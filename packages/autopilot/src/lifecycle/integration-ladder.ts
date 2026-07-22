/**
 * Merge-gate integration ladder helpers (single-surface Stage 2).
 */

import { carryoverEnabled, childrenPathEnabled } from './child-issues.js';
import type { GitOid } from './types.js';

export type IntegrationLadderAction =
  | { readonly kind: 'merge-ready' }
  | { readonly kind: 'update-branch' }
  | { readonly kind: 'file-reconcile-child'; readonly effort: 'low' | 'medium' | 'high' }
  | { readonly kind: 'blocked'; readonly reasons: readonly string[] }

export interface IntegrationLadderInput {
  readonly approved: boolean;
  readonly ciGreen: boolean;
  readonly draft: boolean;
  readonly humanHold: boolean;
  readonly mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' | string;
  readonly mergeStateStatus: string;
  readonly compareStatus: 'ahead' | 'behind' | 'diverged' | 'identical' | 'unknown';
  readonly openReconcileChild: boolean;
  readonly openFindingChild: boolean;
  readonly childrenEnabled?: boolean;
}

export function chooseIntegrationLadderAction(
  input: IntegrationLadderInput,
): IntegrationLadderAction {
  if (input.draft) return { kind: 'blocked', reasons: ['draft'] };
  if (input.humanHold) return { kind: 'blocked', reasons: ['human'] };
  if (!input.approved) return { kind: 'blocked', reasons: ['not-approved'] };
  if (!input.ciGreen) return { kind: 'blocked', reasons: ['ci'] };
  if (input.openFindingChild || input.openReconcileChild) {
    return { kind: 'blocked', reasons: ['open-child'] };
  }

  const childrenOn = input.childrenEnabled ?? true;
  const conflicting = input.mergeable === 'CONFLICTING'
    || input.mergeStateStatus === 'DIRTY';

  if (conflicting) {
    if (!childrenOn) return { kind: 'blocked', reasons: ['children-disarmed'] };
    return { kind: 'file-reconcile-child', effort: 'medium' };
  }

  if (input.compareStatus === 'behind' || input.compareStatus === 'diverged') {
    if (!childrenOn) return { kind: 'blocked', reasons: ['children-disarmed'] };
    return { kind: 'update-branch' };
  }

  if (
    input.mergeable === 'MERGEABLE'
    && ['CLEAN', 'UNSTABLE', 'HAS_HOOKS'].includes(input.mergeStateStatus)
    && (input.compareStatus === 'ahead' || input.compareStatus === 'identical')
  ) {
    return { kind: 'merge-ready' };
  }

  return { kind: 'blocked', reasons: ['mergeability'] };
}

export function effectiveDiffsIdentical(
  beforeDiff: string,
  afterDiff: string,
): boolean {
  return beforeDiff === afterDiff;
}

export interface CarryOverDecision {
  readonly allow: boolean;
  readonly reason: string;
}

export function decideApprovalCarryOver(input: {
  readonly env?: NodeJS.ProcessEnv;
  readonly gatePerformedUpdateBranch: boolean;
  readonly beforeDiff: string;
  readonly afterDiff: string;
  readonly beforeHead: GitOid;
  readonly afterHead: GitOid;
}): CarryOverDecision {
  if (!carryoverEnabled(input.env)) {
    return { allow: false, reason: 'carryover-disabled' };
  }
  if (!input.gatePerformedUpdateBranch) {
    return { allow: false, reason: 'not-gate-owned-update' };
  }
  if (input.beforeHead === input.afterHead) {
    return { allow: false, reason: 'head-unchanged' };
  }
  if (!effectiveDiffsIdentical(input.beforeDiff, input.afterDiff)) {
    return { allow: false, reason: 'effective-diff-changed' };
  }
  return { allow: true, reason: 'effective-diff-identical' };
}

export function childrenArmed(env: NodeJS.ProcessEnv = process.env): boolean {
  return childrenPathEnabled(env);
}
