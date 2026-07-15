import type {
  ContributionLedgerEntry,
  ContributionPort,
  ContributionRecordOptions,
  ContributionState,
  ContributionStatusSnapshot,
} from '../ports/contribution-port.js';
import { deriveContributionStatus } from '../ports/contribution-port.js';
import { ok, unavailable } from '../outcome.js';
import {
  ContributionCandidateV1Schema,
  type ContributionCandidateV1,
} from '../schemas/contribution-candidate.js';

interface StoredContribution {
  candidate: ContributionCandidateV1;
  state: ContributionState;
}

function snapshot(state: ContributionState): ContributionStatusSnapshot {
  return { ...state, status: deriveContributionStatus(state) };
}

export class InMemoryContributionPort implements ContributionPort {
  private readonly records = new Map<string, StoredContribution>();
  private counter = 0;

  async recordMineable(candidate: ContributionCandidateV1, options?: ContributionRecordOptions) {
    const parsed = ContributionCandidateV1Schema.safeParse(candidate);
    if (!parsed.success) return unavailable('invalid contribution candidate');

    this.counter += 1;
    const recordId = `record-${this.counter}`;
    this.records.set(recordId, {
      candidate: parsed.data,
      state: {
        localState: 'recorded',
        publicationState: options?.publicationState ??
          (parsed.data.publishMinedTasksConsent ? 'preview-required' : 'disabled'),
      },
    });
    return ok({ recordId });
  }

  async ledger() {
    return ok([...this.records.entries()].map(([recordId, record]) => ({
      recordId,
      sourceId: record.candidate.sourceId,
      createdAt: record.candidate.createdAt,
      verifiabilityTier: record.candidate.testRuns.some((run) => run.exitCode === 0)
        ? 'tests-passed' as const
        : 'user-accepted' as const,
      repositorySlug: record.candidate.repositorySlug,
      baseCommit: record.candidate.baseCommit,
      ...snapshot(record.state),
    })) satisfies ContributionLedgerEntry[]);
  }

  async mintStatus(recordId: string) {
    const record = this.records.get(recordId);
    if (!record) return unavailable(`no such record: ${recordId}`);
    return ok(snapshot(record.state));
  }

  async authorize(recordId: string) {
    const record = this.records.get(recordId);
    if (!record) return unavailable(`no such record: ${recordId}`);
    if (record.state.publicationState === 'disabled') {
      return unavailable(`publication disabled by consent: ${recordId}`);
    }
    if (record.state.publicationState === 'vetoed') {
      return unavailable(`publication vetoed: ${recordId}`);
    }
    record.state.publicationState = 'queued';
    return ok({ recordId, publicationState: 'queued' as const, status: 'queued' as const });
  }

  async veto(recordId: string) {
    const record = this.records.get(recordId);
    if (!record) return unavailable(`no such record: ${recordId}`);
    record.state.publicationState = 'vetoed';
    return ok({ recordId, publicationState: 'vetoed' as const, status: 'vetoed' as const });
  }

  async disableUnpublished() {
    const recordIds: string[] = [];
    for (const [recordId, record] of this.records) {
      if (record.state.publicationState === 'preview-required' || record.state.publicationState === 'queued') {
        record.state.publicationState = 'disabled';
        recordIds.push(recordId);
      }
    }
    return ok({ recordIds });
  }

  /** Testing control for the sidecar-owned forward state. */
  markMinted(recordId: string, mintRef: string): void {
    const record = this.records.get(recordId);
    if (!record) return;
    record.state.localState = 'minted';
    record.state.mintRef = mintRef;
  }

  /** Testing control for the sidecar-owned terminal local state. */
  markRejected(recordId: string): void {
    const record = this.records.get(recordId);
    if (!record) return;
    record.state.localState = 'rejected';
    delete record.state.mintRef;
    if (record.state.publicationState !== 'vetoed') record.state.publicationState = 'disabled';
  }

  /** Testing control for the sidecar-owned outbound state. */
  markPublished(recordId: string, publicationRef: string): void {
    const record = this.records.get(recordId);
    if (!record) return;
    record.state.publicationState = 'published';
    record.state.publicationRef = publicationRef;
  }

  getCandidate(recordId: string): ContributionCandidateV1 | undefined {
    return this.records.get(recordId)?.candidate;
  }
}
