/** ContributionPort projection over the shared daemon/jinn-layer store. */
import { isDeepStrictEqual } from 'node:util';
import {
  deriveContributionStatus,
  degraded,
  ok,
  unavailable,
  ContributionCandidateV1ProjectionSchema,
  ContributionCandidateV1Schema,
  type ContributionCandidateV1,
  type ContributionLedgerEntry,
  type ContributionPort,
  type ContributionStatusSnapshot,
  type EvidencePort,
  type PortResult,
} from '@jinn-network/plugin';
import { ContributionStore } from '@jinn-network/core';

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
  /** Canonical payload resolver; the status store contains references only. */
  evidence: Pick<EvidencePort, 'get'>;
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
        const parsed = ContributionCandidateV1Schema.parse(candidate);
        const evidence = await deps.evidence.get(parsed.sourceId);
        const episode = evidence.status === 'unavailable' ? null : evidence.value;
        const canonicalCandidate = episode?.contributionCandidate === undefined
          ? undefined
          : ContributionCandidateV1ProjectionSchema.safeParse(episode.contributionCandidate);
        if (!episode) {
          return unavailable(`canonical contribution episode is unavailable: ${parsed.sourceId}`);
        }
        if (
          !canonicalCandidate?.success
          || canonicalCandidate.data.sourceId !== episode.episodeId
          || !isDeepStrictEqual(canonicalCandidate.data, parsed)
        ) {
          return unavailable(`canonical contribution candidate mismatch: ${parsed.sourceId}`);
        }
        const record = await store.recordReference(parsed.sourceId, {
          publishMinedTasksConsent: parsed.publishMinedTasksConsent,
          ...options,
        });
        return ok({ recordId: record.recordId });
      } catch (error) {
        return unavailable(`contribution store recordMineable failed: ${String(error)}`);
      }
    },

    async ledger(): Promise<PortResult<ContributionLedgerEntry[]>> {
      try {
        const reasons: string[] = [];
        const entries = await Promise.all((await store.list()).map(async (record): Promise<ContributionLedgerEntry> => {
          const evidence = await deps.evidence.get(record.recordId);
          const episode = evidence.status === 'unavailable' ? null : evidence.value;
          const parsedCandidate = episode?.contributionCandidate === undefined
            ? undefined
            : ContributionCandidateV1ProjectionSchema.safeParse(episode.contributionCandidate);
          const candidate = parsedCandidate?.success && parsedCandidate.data.sourceId === record.recordId
            ? parsedCandidate.data
            : undefined;
          if (!candidate) reasons.push(`unresolved canonical episode: ${record.recordId}`);
          return {
            recordId: record.recordId,
            sourceId: record.recordId,
            ...(candidate ? {
              createdAt: candidate.createdAt,
              verifiabilityTier: candidate.testRuns.some((run) => run.exitCode === 0)
                ? 'tests-passed' as const
                : 'user-accepted' as const,
              repositorySlug: candidate.repositorySlug,
              baseCommit: candidate.baseCommit,
            } : {}),
            localState: record.localState,
            publicationState: record.publicationState,
            ...(record.mintRef ? { mintRef: record.mintRef } : {}),
            ...(record.publicationRef ? { publicationRef: record.publicationRef } : {}),
            status: deriveContributionStatus(record),
          };
        }));
        return reasons.length > 0
          ? degraded([...new Set(reasons)].join('; '), entries)
          : ok(entries);
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
