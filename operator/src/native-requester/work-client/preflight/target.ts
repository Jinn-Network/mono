import { RequesterError } from '../errors.js';

export interface PostingTargetCandidate {
  readonly postingKey: string;
  readonly workKind: string;
  readonly profileUri: string;
  /** Supplied by the caller from venue facts; this module reads no chain and no network. */
  readonly live: boolean;
  /** Migration-honesty annotation carried from the launched-record migration. */
  readonly legacyManifestDigest?: string;
}

export interface SelectLiveTargetInput {
  readonly candidates: readonly PostingTargetCandidate[];
  readonly explicitPostingKey?: string;
  readonly requestedWorkKind?: string;
}

/**
 * Selection never guesses: an explicit key must exist and be live, and an implicit selection
 * must resolve to exactly one live candidate after the optional work-kind narrowing. Replaces the
 * legacy `selectMarketplaceTaskSolverNet` (operator/src/tasks/submit-preflight.ts:97-130); the
 * selection axis is the posting-config entry, not a SolverNet manifest, and liveness is supplied
 * by the caller from venue facts, keeping this function pure.
 */
export function selectLiveTarget(input: SelectLiveTargetInput): PostingTargetCandidate {
  if (input.explicitPostingKey !== undefined) {
    const exact = input.candidates.find(
      (candidate) => candidate.postingKey === input.explicitPostingKey,
    );
    if (exact === undefined) {
      throw new RequesterError(
        'target',
        'explicit-unknown',
        `posting entry ${input.explicitPostingKey} is not configured`,
      );
    }
    if (!exact.live) {
      throw new RequesterError(
        'target',
        'explicit-not-live',
        `posting entry ${input.explicitPostingKey} is configured but not live at the venue`,
      );
    }
    return exact;
  }

  const live = input.candidates.filter((candidate) => candidate.live);
  const narrowed = input.requestedWorkKind === undefined
    ? live
    : live.filter((candidate) => candidate.workKind === input.requestedWorkKind);

  if (narrowed.length === 0) {
    throw new RequesterError(
      'target',
      'no-live-target',
      input.requestedWorkKind === undefined
        ? 'no live posting entry is configured'
        : `no live posting entry serves work kind ${input.requestedWorkKind}`,
    );
  }
  if (narrowed.length > 1) {
    throw new RequesterError(
      'target',
      'ambiguous-target',
      `expected exactly one live posting entry but found ${narrowed.length} `
      + `(${narrowed.map((candidate) => candidate.postingKey).join(', ')}); pass an explicit entry`,
    );
  }
  return narrowed[0]!;
}
