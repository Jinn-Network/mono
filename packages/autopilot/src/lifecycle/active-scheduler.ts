import type { NewWorkAction } from './types.js';
import type { GitOid } from './types.js';

export type ActiveCandidate =
  | { readonly phase: 'implementation'; readonly issueNumber: number }
  | {
      readonly phase: 'review';
      readonly issueNumber: number;
      readonly prNumber: number;
      readonly head: GitOid;
      readonly author: string;
      readonly recoverFixes?: boolean;
    }
  | {
      readonly phase: 'merge-prep';
      readonly issueNumber: number;
      readonly prNumber: number;
      readonly head: GitOid;
      readonly recoverStale?: boolean;
    }
  | {
      readonly phase: 'merge';
      readonly issueNumber: number;
      readonly prNumber: number;
      readonly head: GitOid;
    };

export interface ActiveSchedulingInput {
  readonly candidates: readonly ActiveCandidate[];
  readonly remaining: {
    readonly implementation: number;
    readonly review: number;
    readonly mergePrep: number;
  };
  readonly availableLogins: readonly string[];
  readonly implementationPreferredLogin: string;
  readonly openPipelineBacklog: number;
  readonly implementationBackpressureThreshold: number;
}

export interface ActiveSchedulingSkip {
  readonly phase: ActiveCandidate['phase'];
  readonly subject: string;
  readonly reason: 'capacity' | 'credential-lane' | 'identity' | 'backpressure';
}

export interface ActiveSchedulingPlan {
  readonly actions: readonly NewWorkAction[];
  readonly skips: readonly ActiveSchedulingSkip[];
}

function subject(candidate: ActiveCandidate): string {
  return candidate.phase === 'implementation'
    ? `issue:${candidate.issueNumber}`
    : `pr:${candidate.prNumber}`;
}

export function scheduleActiveActions(
  input: ActiveSchedulingInput,
): ActiveSchedulingPlan {
  const actions: NewWorkAction[] = [];
  const skips: ActiveSchedulingSkip[] = [];
  const freeLogins = new Set(input.availableLogins.map((login) => login.toLowerCase()));
  const implementation = input.candidates.filter(
    (candidate): candidate is Extract<ActiveCandidate, { phase: 'implementation' }> =>
      candidate.phase === 'implementation',
  );
  for (const candidate of implementation) {
    if (actions.filter((action) => action.kind === 'claim-implementation').length
      >= input.remaining.implementation) {
      skips.push({ phase: candidate.phase, subject: subject(candidate), reason: 'capacity' });
      continue;
    }
    if (input.openPipelineBacklog >= input.implementationBackpressureThreshold) {
      skips.push({ phase: candidate.phase, subject: subject(candidate), reason: 'backpressure' });
      continue;
    }
    const preferred = input.implementationPreferredLogin.toLowerCase();
    const login = freeLogins.has(preferred) ? preferred : freeLogins.values().next().value;
    if (login === undefined) {
      skips.push({ phase: candidate.phase, subject: subject(candidate), reason: 'credential-lane' });
      continue;
    }
    freeLogins.delete(login);
    actions.push({ kind: 'claim-implementation', issueNumber: candidate.issueNumber });
  }

  for (const candidate of input.candidates) {
    if (candidate.phase !== 'review') continue;
    if (actions.filter((action) => action.kind === 'claim-review').length >= input.remaining.review) {
      skips.push({ phase: candidate.phase, subject: subject(candidate), reason: 'capacity' });
      continue;
    }
    const reviewer = [...freeLogins].find(
      (login) => login !== candidate.author.toLowerCase(),
    );
    if (reviewer === undefined) {
      skips.push({
        phase: candidate.phase,
        subject: subject(candidate),
        reason: freeLogins.size === 0 ? 'credential-lane' : 'identity',
      });
      continue;
    }
    freeLogins.delete(reviewer);
    actions.push({
      kind: 'claim-review',
      issueNumber: candidate.issueNumber,
      prNumber: candidate.prNumber,
      head: candidate.head,
      recoverFixes: candidate.recoverFixes ?? false,
    });
  }

  for (const candidate of input.candidates) {
    if (candidate.phase !== 'merge-prep') continue;
    if (
      actions.filter((action) => action.kind === 'claim-merge-prep').length
        >= input.remaining.mergePrep
    ) {
      skips.push({ phase: candidate.phase, subject: subject(candidate), reason: 'capacity' });
      continue;
    }
    const login = freeLogins.values().next().value;
    if (login === undefined) {
      skips.push({ phase: candidate.phase, subject: subject(candidate), reason: 'credential-lane' });
      continue;
    }
    freeLogins.delete(login);
    actions.push({
      kind: 'claim-merge-prep',
      issueNumber: candidate.issueNumber,
      prNumber: candidate.prNumber,
      head: candidate.head,
      recoverStale: candidate.recoverStale ?? false,
    });
  }

  for (const candidate of input.candidates) {
    if (candidate.phase !== 'merge') continue;
    if (freeLogins.size === 0) {
      skips.push({ phase: candidate.phase, subject: subject(candidate), reason: 'credential-lane' });
      continue;
    }
    actions.push({
      kind: 'merge',
      issueNumber: candidate.issueNumber,
      prNumber: candidate.prNumber,
      head: candidate.head,
    });
  }

  return { actions, skips };
}
