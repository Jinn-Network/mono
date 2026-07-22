import { describe, expect, it } from 'vitest';
import {
  chooseIntegrationLadderAction,
  decideApprovalCarryOver,
  effectiveDiffsIdentical,
} from '../../src/lifecycle/integration-ladder.js';
import { gitOid } from '../../src/lifecycle/types.js';

const base = {
  approved: true,
  ciGreen: true,
  draft: false,
  humanHold: false,
  mergeable: 'MERGEABLE' as const,
  mergeStateStatus: 'CLEAN',
  compareStatus: 'ahead' as const,
  openReconcileChild: false,
  openFindingChild: false,
  childrenEnabled: true,
};

describe('chooseIntegrationLadderAction', () => {
  it('returns merge-ready when clean and ahead', () => {
    expect(chooseIntegrationLadderAction(base)).toEqual({ kind: 'merge-ready' });
  });

  it('update-branch when behind and children armed', () => {
    expect(chooseIntegrationLadderAction({
      ...base,
      compareStatus: 'behind',
      mergeStateStatus: 'BEHIND',
    })).toEqual({ kind: 'update-branch' });
  });

  it('blocks when behind and children disarmed', () => {
    expect(chooseIntegrationLadderAction({
      ...base,
      compareStatus: 'behind',
      mergeStateStatus: 'BEHIND',
      childrenEnabled: false,
    })).toEqual({ kind: 'blocked', reasons: ['children-disarmed'] });
  });

  it('files reconcile child when conflicting', () => {
    expect(chooseIntegrationLadderAction({
      ...base,
      mergeable: 'CONFLICTING',
      mergeStateStatus: 'DIRTY',
    })).toEqual({ kind: 'file-reconcile-child', effort: 'medium' });
  });

  it('blocks when an open child exists', () => {
    expect(chooseIntegrationLadderAction({
      ...base,
      openReconcileChild: true,
    })).toEqual({ kind: 'blocked', reasons: ['open-child'] });
    expect(chooseIntegrationLadderAction({
      ...base,
      openFindingChild: true,
      compareStatus: 'behind',
    })).toEqual({ kind: 'blocked', reasons: ['open-child'] });
  });

  it('blocks draft / human / not-approved / ci', () => {
    expect(chooseIntegrationLadderAction({ ...base, draft: true }))
      .toEqual({ kind: 'blocked', reasons: ['draft'] });
    expect(chooseIntegrationLadderAction({ ...base, humanHold: true }))
      .toEqual({ kind: 'blocked', reasons: ['human'] });
    expect(chooseIntegrationLadderAction({ ...base, approved: false }))
      .toEqual({ kind: 'blocked', reasons: ['not-approved'] });
    expect(chooseIntegrationLadderAction({ ...base, ciGreen: false }))
      .toEqual({ kind: 'blocked', reasons: ['ci'] });
  });
});

describe('decideApprovalCarryOver', () => {
  const before = gitOid('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  const after = gitOid('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
  const diff = 'diff --git a/x b/x\n+one\n';

  it('allows carryover by default (Stage 4) and rejects when explicitly disabled', () => {
    expect(decideApprovalCarryOver({
      env: {},
      gatePerformedUpdateBranch: true,
      beforeDiff: diff,
      afterDiff: diff,
      beforeHead: before,
      afterHead: after,
    })).toEqual({ allow: true, reason: 'effective-diff-identical' });
    for (const raw of ['0', 'false', 'no', 'off'] as const) {
      expect(decideApprovalCarryOver({
        env: { JINN_AUTOPILOT_CARRYOVER: raw },
        gatePerformedUpdateBranch: true,
        beforeDiff: diff,
        afterDiff: diff,
        beforeHead: before,
        afterHead: after,
      })).toEqual({ allow: false, reason: 'carryover-disabled' });
    }
  });

  it('allows identical effective diffs after gate-owned update', () => {
    expect(decideApprovalCarryOver({
      env: { JINN_AUTOPILOT_CARRYOVER: '1' },
      gatePerformedUpdateBranch: true,
      beforeDiff: diff,
      afterDiff: diff,
      beforeHead: before,
      afterHead: after,
    })).toEqual({ allow: true, reason: 'effective-diff-identical' });
  });

  it('rejects content change either direction', () => {
    expect(decideApprovalCarryOver({
      env: { JINN_AUTOPILOT_CARRYOVER: 'on' },
      gatePerformedUpdateBranch: true,
      beforeDiff: diff,
      afterDiff: `${diff}+two\n`,
      beforeHead: before,
      afterHead: after,
    })).toEqual({ allow: false, reason: 'effective-diff-changed' });
    expect(effectiveDiffsIdentical(diff, diff)).toBe(true);
    expect(effectiveDiffsIdentical(diff, '')).toBe(false);
  });

  it('rejects non-gate updates and unchanged heads', () => {
    expect(decideApprovalCarryOver({
      env: { JINN_AUTOPILOT_CARRYOVER: '1' },
      gatePerformedUpdateBranch: false,
      beforeDiff: diff,
      afterDiff: diff,
      beforeHead: before,
      afterHead: after,
    }).reason).toBe('not-gate-owned-update');
    expect(decideApprovalCarryOver({
      env: { JINN_AUTOPILOT_CARRYOVER: '1' },
      gatePerformedUpdateBranch: true,
      beforeDiff: diff,
      afterDiff: diff,
      beforeHead: before,
      afterHead: before,
    }).reason).toBe('head-unchanged');
  });
});
