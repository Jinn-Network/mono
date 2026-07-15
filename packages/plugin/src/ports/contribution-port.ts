import type { PortResult } from '../outcome.js';
import type { ContributionCandidateV1 } from '../schemas/contribution-candidate.js';

export type ContributionLocalState = 'recorded' | 'minted' | 'rejected';
export type ContributionPublicationState =
  | 'disabled'
  | 'preview-required'
  | 'queued'
  | 'published'
  | 'vetoed';
export type ContributionStatus =
  | ContributionLocalState
  | Exclude<ContributionPublicationState, 'disabled'>;

export interface ContributionState {
  localState: ContributionLocalState;
  publicationState: ContributionPublicationState;
  mintRef?: string;
  publicationRef?: string;
}

export interface ContributionStatusSnapshot extends ContributionState {
  status: ContributionStatus;
}

export interface ContributionLedgerEntry extends ContributionStatusSnapshot {
  recordId: string;
  sourceId: string;
  createdAt: string;
  verifiabilityTier: 'user-accepted' | 'tests-passed';
  /** Sanitized repository facts used by the local first-share preview. */
  repositorySlug?: string;
  baseCommit?: string;
}

export interface ContributionRecordOptions {
  /** Persist a durable veto in the same atomic write that creates the record. */
  publicationState?: 'vetoed';
}

/** Collapse the independent local and outbound axes into one display status. */
export function deriveContributionStatus(
  state: Pick<ContributionState, 'localState' | 'publicationState'>,
): ContributionStatus {
  if (state.publicationState === 'published') return 'published';
  if (state.publicationState === 'vetoed') return 'vetoed';
  if (state.localState === 'rejected') return 'rejected';
  if (state.publicationState === 'preview-required') return 'preview-required';
  if (state.publicationState === 'queued') return 'queued';
  return state.localState;
}

export interface ContributionPort {
  /** Always stores the complete candidate locally; consent controls only publication state. */
  recordMineable(
    candidate: ContributionCandidateV1,
    options?: ContributionRecordOptions,
  ): Promise<PortResult<{ recordId: string }>>;
  ledger(): Promise<PortResult<ContributionLedgerEntry[]>>;
  /** Retained name for adapter compatibility; reports both axes and the derived status. */
  mintStatus(recordId: string): Promise<PortResult<ContributionStatusSnapshot>>;
  authorize(recordId: string): Promise<PortResult<{
    recordId: string;
    publicationState: 'queued';
    status: 'queued';
  }>>;
  veto(recordId: string): Promise<PortResult<{
    recordId: string;
    publicationState: 'vetoed';
    status: 'vetoed';
  }>>;
  /** Disable every unpublished standing authorization when sharing is turned off. */
  disableUnpublished?(): Promise<PortResult<{ recordIds: string[] }>>;
}
