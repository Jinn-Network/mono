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
    }
  | {
      readonly phase: 'update-branch';
      readonly issueNumber: number;
      readonly prNumber: number;
      readonly head: GitOid;
    }
  | {
      readonly phase: 'file-reconcile-child';
      readonly issueNumber: number;
      readonly prNumber: number;
      readonly head: GitOid;
      readonly effort: 'low' | 'medium' | 'high';
    }
  | {
      readonly phase: 'rerun-failed-checks';
      readonly issueNumber: number;
      readonly prNumber: number;
      readonly head: GitOid;
    }
  | {
      readonly phase: 'file-ci-failure-child';
      readonly issueNumber: number;
      readonly prNumber: number;
      readonly head: GitOid;
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
  };
  readonly availableLogins: readonly string[];
  readonly implementationPreferredLogin: string;
  readonly openPipelineBacklog: number;
  readonly implementationBackpressureThreshold: number;
  readonly newWorkPaused?: boolean;
}

export interface ActiveSchedulingSkip {
  readonly phase: ActiveCandidate['phase'];
  readonly subject: string;
  readonly reason: 'capacity' | 'credential-lane' | 'identity' | 'backpressure' | 'disk-floor';
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

function capacitySkipReason(input: ActiveSchedulingInput): ActiveSchedulingSkip['reason'] {
  return input.newWorkPaused === true ? 'disk-floor' : 'capacity';
}

export function scheduleActiveActions(
  input: ActiveSchedulingInput,
): ActiveSchedulingPlan {
  const actions: NewWorkAction[] = [];
  const skips: ActiveSchedulingSkip[] = [];
  const configuredLogins = new Set(
    input.availableLogins.map((login) => login.toLowerCase()),
  );
  const implementation = input.candidates.filter(
    (candidate): candidate is Extract<ActiveCandidate, { phase: 'implementation' }> =>
      candidate.phase === 'implementation',
  );
  for (const candidate of implementation) {
    if (actions.filter((action) => action.kind === 'claim-implementation').length
      >= input.remaining.implementation) {
      skips.push({
        phase: candidate.phase,
        subject: subject(candidate),
        reason: capacitySkipReason(input),
      });
      continue;
    }
    if (input.openPipelineBacklog >= input.implementationBackpressureThreshold) {
      skips.push({ phase: candidate.phase, subject: subject(candidate), reason: 'backpressure' });
      continue;
    }
    if (configuredLogins.size === 0) {
      skips.push({ phase: candidate.phase, subject: subject(candidate), reason: 'credential-lane' });
      continue;
    }
    actions.push({ kind: 'claim-implementation', issueNumber: candidate.issueNumber });
  }

  for (const candidate of input.candidates) {
    if (candidate.phase !== 'review') continue;
    if (actions.filter((action) => action.kind === 'claim-review').length >= input.remaining.review) {
      skips.push({
        phase: candidate.phase,
        subject: subject(candidate),
        reason: capacitySkipReason(input),
      });
      continue;
    }
    const reviewer = [...configuredLogins].find(
      (login) => login !== candidate.author.toLowerCase(),
    );
    if (reviewer === undefined) {
      skips.push({
        phase: candidate.phase,
        subject: subject(candidate),
        reason: configuredLogins.size === 0 ? 'credential-lane' : 'identity',
      });
      continue;
    }
    actions.push({
      kind: 'claim-review',
      issueNumber: candidate.issueNumber,
      prNumber: candidate.prNumber,
      head: candidate.head,
    });
  }

  for (const candidate of input.candidates) {
    if (candidate.phase === 'update-branch') {
      actions.push({
        kind: 'update-branch',
        issueNumber: candidate.issueNumber,
        prNumber: candidate.prNumber,
        head: candidate.head,
      });
      continue;
    }
    if (candidate.phase === 'file-reconcile-child') {
      actions.push({
        kind: 'file-reconcile-child',
        issueNumber: candidate.issueNumber,
        prNumber: candidate.prNumber,
        head: candidate.head,
        effort: candidate.effort,
      });
      continue;
    }
    if (candidate.phase === 'rerun-failed-checks') {
      actions.push({
        kind: 'rerun-failed-checks',
        issueNumber: candidate.issueNumber,
        prNumber: candidate.prNumber,
        head: candidate.head,
      });
      continue;
    }
    if (candidate.phase === 'file-ci-failure-child') {
      actions.push({
        kind: 'file-ci-failure-child',
        issueNumber: candidate.issueNumber,
        prNumber: candidate.prNumber,
        head: candidate.head,
      });
    }
  }

  for (const candidate of input.candidates) {
    if (candidate.phase !== 'merge') continue;
    if (configuredLogins.size === 0) {
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
