import { describe, it, expect } from 'vitest';
import { escalateStuckPrs } from '../../src/dispatcher/stuck-escalation.js';
import type { StuckPr } from '../../src/dispatcher/merge-sweep.js';
import type { CommandRunner } from '../../src/dispatcher/issue-source.js';
import type { FieldCache } from '../../src/dispatcher/field-cache.js';
import type { ProjectSnapshot, SnapshotItem } from '../../src/dispatcher/project-snapshot.js';
import type { PrLink } from '../../src/dispatcher/pr-links.js';

const PROJECT_ID = 'PVT_test';
const BLOCKED_FIELD_ID = 'field_blocked';
const BLOCKED_HUMAN_OPT = 'opt_b_human';

const FIELD_CACHE: FieldCache = {
  projectId: PROJECT_ID,
  status: {
    fieldId: 'field_status',
    options: {
      Todo: 'opt_todo', 'In Progress': 'opt_inprog', Human: 'opt_human',
      'In Review': 'opt_inreview', Done: 'opt_done',
    },
  },
  blockedOn: {
    fieldId: BLOCKED_FIELD_ID,
    options: { Nothing: 'opt_nothing', Human: BLOCKED_HUMAN_OPT, 'Another issue': 'opt_another' },
  },
};

function item(over: Partial<SnapshotItem> & Pick<SnapshotItem, 'id' | 'number'>): SnapshotItem {
  return {
    contentType: 'Issue', status: null, priority: null, effort: null,
    blockedOn: null, issueType: null, blockedByIssues: [], sprintIterationId: null,
    ...over,
  };
}

function snapshot(items: SnapshotItem[]): ProjectSnapshot {
  return { items, rateLimit: { remaining: 5000, used: 0, resetAt: '2026-01-01T00:00:00Z' }, currentSprintIterationId: null };
}

function stuck(over: Partial<StuckPr> = {}): StuckPr {
  return {
    number: 42, title: 't', reason: 'conflicting',
    headRefName: 'feat/50-x', headRefOid: 'deadbeef1234', escalated: false, ...over,
  };
}

/** PR #42 closes issue #50. */
function prMap(): Map<number, PrLink[]> {
  const link: PrLink = {
    prNumber: 42, headRefName: 'feat/50-x', baseRefName: 'next',
    state: 'OPEN', isDraft: false, author: 'ritsukai', labels: ['engine:review'],
  };
  return new Map([[50, [link]]]);
}

function recordingRunner(fail?: (cmd: string, args: string[]) => boolean) {
  const calls: { cmd: string; args: string[] }[] = [];
  const runner: CommandRunner = async (cmd, args) => {
    calls.push({ cmd, args });
    if (fail?.(cmd, args)) throw new Error('boom');
    return '';
  };
  return { runner, calls };
}

describe('escalateStuckPrs', () => {
  it('fresh stuck PR: label + linked-issue Blocked-on:Human + exactly one comment', async () => {
    const { runner, calls } = recordingRunner();
    const report = await escalateStuckPrs([stuck()], snapshot([item({ id: 'PVTI_50', number: 50 })]), prMap(), FIELD_CACHE, runner);

    expect(report.escalated).toEqual([42]);

    const label = calls.find((c) => c.args.includes('--add-label'));
    expect(label?.args).toEqual(['pr', 'edit', '42', '--repo', expect.any(String), '--add-label', 'review:needs-human']);

    const edit = calls.find((c) => c.args[1] === 'item-edit');
    expect(edit?.args).toContain('PVTI_50');
    expect(edit?.args).toContain(BLOCKED_FIELD_ID);
    expect(edit?.args).toContain(BLOCKED_HUMAN_OPT);

    const comments = calls.filter((c) => c.args[1] === 'comment');
    expect(comments).toHaveLength(1);
  });

  it('already-escalated PR is skipped entirely (zero calls)', async () => {
    const { runner, calls } = recordingRunner();
    const report = await escalateStuckPrs([stuck({ escalated: true })], snapshot([item({ id: 'PVTI_50', number: 50 })]), prMap(), FIELD_CACHE, runner);
    expect(report.escalated).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it('no linked issue: still labels + comments, makes no board edit', async () => {
    const { runner, calls } = recordingRunner();
    const report = await escalateStuckPrs([stuck()], snapshot([]), new Map(), FIELD_CACHE, runner);
    expect(report.escalated).toEqual([42]);
    expect(calls.some((c) => c.args.includes('--add-label'))).toBe(true);
    expect(calls.some((c) => c.args[1] === 'item-edit')).toBe(false);
    expect(calls.some((c) => c.args[1] === 'comment')).toBe(true);
  });

  it('board edit failure does not prevent the comment (isolated)', async () => {
    const { runner, calls } = recordingRunner((_cmd, args) => args[1] === 'item-edit');
    const report = await escalateStuckPrs([stuck()], snapshot([item({ id: 'PVTI_50', number: 50 })]), prMap(), FIELD_CACHE, runner);
    expect(report.escalated).toEqual([42]); // still succeeds
    expect(calls.some((c) => c.args[1] === 'comment')).toBe(true);
  });

  it('label failure aborts that PR (recorded skipped) but the next PR still processes', async () => {
    const { runner } = recordingRunner((_cmd, args) => args[1] === 'edit' && args[2] === '42');
    const two = [stuck(), stuck({ number: 43 })];
    const report = await escalateStuckPrs(two, snapshot([]), new Map(), FIELD_CACHE, runner);
    expect(report.escalated).toEqual([43]);
    expect(report.skipped.some((s) => s.includes('#42'))).toBe(true);
  });
});
