import { describe, it, expect } from 'vitest';
import { syncStackBases } from '../../src/dispatcher/stack-sweep.js';
import type { ProjectSnapshot, SnapshotItem } from '../../src/dispatcher/project-snapshot.js';
import type { FieldCache } from '../../src/dispatcher/field-cache.js';
import type { PrLink, PrState } from '../../src/dispatcher/pr-links.js';
import type { CommandRunner } from '../../src/dispatcher/issue-source.js';

const FIELD_CACHE: FieldCache = {
  projectId: 'PVT_x',
  status: { fieldId: 'F_status', options: { Todo: 'o_todo', 'In Progress': 'o_ip', Human: 'o_human', 'In Review': 'o_ir', Done: 'o_done' } },
  blockedOn: { fieldId: 'F_blk', options: { Nothing: 'o_nothing', Human: 'o_bhuman', 'Another issue': 'o_another' } },
};

function item(number: number, over: Partial<SnapshotItem> = {}): SnapshotItem {
  return {
    id: `PVTI_${number}`, number, contentType: 'Issue',
    status: 'In Progress', priority: 'P1', effort: 'Low', blockedOn: 'Nothing',
    issueType: 'feat', blockedByIssues: [], sprintIterationId: null, ...over,
  };
}

function snap(items: SnapshotItem[]): ProjectSnapshot {
  return { items, rateLimit: { remaining: 5000, used: 0, resetAt: 'x' }, currentSprintIterationId: null };
}

function link(prNumber: number, headRefName: string, baseRefName: string, state: PrState): PrLink {
  return { prNumber, headRefName, baseRefName, state, isDraft: true, author: 'ritsukai' };
}

function recordingRunner(): { runner: CommandRunner; calls: { cmd: string; args: string[] }[] } {
  const calls: { cmd: string; args: string[] }[] = [];
  const runner: CommandRunner = async (cmd, args) => { calls.push({ cmd, args }); return ''; };
  return { runner, calls };
}

// child #200 (In Progress) has open PR #20 stacked on the blocker's branch;
// blocker #100 owns PR #10 whose head IS that base branch.
function stacked(baseState: PrState): Map<number, PrLink[]> {
  return new Map<number, PrLink[]>([
    [200, [link(20, 'feat/200-child', 'feat/100-base', 'OPEN')]],
    [100, [link(10, 'feat/100-base', 'next', baseState)]],
  ]);
}

describe('syncStackBases', () => {
  it('re-blocks an in-flight child stacked on a CLOSED (unmerged) base PR', async () => {
    const { runner, calls } = recordingRunner();
    const res = await syncStackBases(snap([item(200), item(100)]), stacked('CLOSED'), FIELD_CACHE, runner);

    expect(res.reblocked).toEqual([200]);
    const edit = calls.find((c) => c.args.includes('item-edit'));
    expect(edit?.args).toContain('o_bhuman'); // Blocked on → Human option
    expect(edit?.args).toContain('PVTI_200');
    expect(calls.some((c) => c.args[0] === 'issue' && c.args[1] === 'comment')).toBe(true);
  });

  it('does NOT re-block when the base PR is still OPEN', async () => {
    const { runner, calls } = recordingRunner();
    const res = await syncStackBases(snap([item(200), item(100)]), stacked('OPEN'), FIELD_CACHE, runner);
    expect(res.reblocked).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('does NOT re-block when the base PR merged (GitHub auto-retargets)', async () => {
    const { runner } = recordingRunner();
    const res = await syncStackBases(snap([item(200), item(100)]), stacked('MERGED'), FIELD_CACHE, runner);
    expect(res.reblocked).toEqual([]);
  });

  it('ignores a child whose PR targets next (not stacked)', async () => {
    const prByIssue = new Map<number, PrLink[]>([
      [200, [link(20, 'feat/200-child', 'next', 'OPEN')]],
    ]);
    const { runner } = recordingRunner();
    const res = await syncStackBases(snap([item(200)]), prByIssue, FIELD_CACHE, runner);
    expect(res.reblocked).toEqual([]);
  });

  it('re-blocks an In-Review child on a dead base (mainline: PR opened, status already flipped off In Progress)', async () => {
    const { runner, calls } = recordingRunner();
    const res = await syncStackBases(snap([item(200, { status: 'In Review' }), item(100)]), stacked('CLOSED'), FIELD_CACHE, runner);
    expect(res.reblocked).toEqual([200]);
    expect(calls.find((c) => c.args.includes('item-edit'))?.args).toContain('o_bhuman');
  });

  it('skips a child in a non-live status (e.g. Done)', async () => {
    const { runner } = recordingRunner();
    const res = await syncStackBases(snap([item(200, { status: 'Done' }), item(100)]), stacked('CLOSED'), FIELD_CACHE, runner);
    expect(res.reblocked).toEqual([]);
  });

  it('is idempotent: skips a child already Blocked on Human', async () => {
    const { runner } = recordingRunner();
    const res = await syncStackBases(snap([item(200, { blockedOn: 'Human' }), item(100)]), stacked('CLOSED'), FIELD_CACHE, runner);
    expect(res.reblocked).toEqual([]);
  });
});
