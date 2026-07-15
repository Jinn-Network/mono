/** ContributionPort projection over the shared daemon/jinn-layer store. */
import {
  deriveContributionStatus,
  ok,
  unavailable,
  type ContributionCandidateV1,
  type ContributionLedgerEntry,
  type ContributionPort,
  type ContributionStatusSnapshot,
  type PortResult,
} from '@jinn-network/plugin';
import { ContributionStore } from '../contribution-store.js';

/** Compatibility name retained for existing composition roots. */
export type ContributionStatusStore = ContributionStore;

/**
 * Compatibility factory retained for callers that previously supplied a
 * sidecar status-file path. It now opens the canonical contribution store at
 * exactly that path, so adapter writes and daemon reads share one file.
 */
export function createContributionStatusStore(path: string): ContributionStatusStore {
  return new ContributionStore({ filePath: path });
}

export interface ContributionAdapterDeps {
  /** `statusStore` is retained as a source-compatible dependency name. */
  statusStore: ContributionStatusStore;
  now?: () => string;
}

function snapshot(record: Awaited<ReturnType<ContributionStore['get']>>): ContributionStatusSnapshot | null {
  if (!record) return null;
  return {
    localState: record.localState,
    publicationState: record.publicationState,
    ...(record.mintRef ? { mintRef: record.mintRef } : {}),
    ...(record.publicationRef ? { publicationRef: record.publicationRef } : {}),
    status: deriveContributionStatus(record),
  };
}

export function createContributionAdapter(deps: ContributionAdapterDeps): ContributionPort {
  const store = deps.statusStore;
  const now = deps.now ?? (() => new Date().toISOString());

  return {
    async recordMineable(candidate, options): Promise<PortResult<{ recordId: string }>> {
      try {
        const record = await store.record(candidate, undefined, options);
        return ok({ recordId: record.recordId });
      } catch (error) {
        return unavailable(`contribution store recordMineable failed: ${String(error)}`);
      }
    },

    async ledger(): Promise<PortResult<ContributionLedgerEntry[]>> {
      try {
        const entries = (await store.list()).map((record): ContributionLedgerEntry => ({
          recordId: record.recordId,
          sourceId: record.candidate.sourceId,
          createdAt: record.candidate.createdAt,
          verifiabilityTier: record.candidate.testRuns.some((run) => run.exitCode === 0)
            ? 'tests-passed'
            : 'user-accepted',
          repositorySlug: record.candidate.repositorySlug,
          baseCommit: record.candidate.baseCommit,
          localState: record.localState,
          publicationState: record.publicationState,
          ...(record.mintRef ? { mintRef: record.mintRef } : {}),
          ...(record.publicationRef ? { publicationRef: record.publicationRef } : {}),
          status: deriveContributionStatus(record),
        }));
        return ok(entries);
      } catch (error) {
        return unavailable(`contribution ledger failed: ${String(error)}`);
      }
    },

    async mintStatus(recordId: string): Promise<PortResult<ContributionStatusSnapshot>> {
      try {
        const value = snapshot(await store.get(recordId));
        return value ? ok(value) : unavailable(`no such record: ${recordId}`);
      } catch (error) {
        return unavailable(`contribution status failed: ${String(error)}`);
      }
    },

    async authorize(recordId) {
      try {
        const record = await store.authorize(recordId, now());
        const status = deriveContributionStatus(record);
        if (record.publicationState !== 'queued' || status !== 'queued') {
          return unavailable(`contribution ${recordId} did not enter the queued state`);
        }
        return ok({ recordId, publicationState: 'queued' as const, status: 'queued' as const });
      } catch (error) {
        return unavailable(`contribution authorization failed: ${String(error)}`);
      }
    },

    async veto(recordId) {
      try {
        await store.veto(recordId);
        return ok({ recordId, publicationState: 'vetoed' as const, status: 'vetoed' as const });
      } catch (error) {
        return unavailable(`contribution veto failed: ${String(error)}`);
      }
    },

    async disableUnpublished() {
      try {
        return ok({ recordIds: await store.disableUnpublished() });
      } catch (error) {
        return unavailable(`contribution disable failed: ${String(error)}`);
      }
    },
  };
}
