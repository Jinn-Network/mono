import { describe, it, expect, vi } from 'vitest';
import { makeCollectCompletions } from '../../scripts/run-autopilot.js';
import type { CommandRunner } from '../../src/dispatcher/issue-source.js';
import type { ProjectSnapshot, SnapshotItem } from '../../src/dispatcher/project-snapshot.js';
import type { InFlightSession, SessionResult } from '../../src/dispatcher/types.js';
import type { DeliverySink } from '../../src/dispatcher/delivery-sink.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeItem(overrides: Partial<SnapshotItem> & { number: number }): SnapshotItem {
  return {
    id: `PVTI_${overrides.number}`,
    contentType: 'Issue',
    status: null,
    priority: null,
    effort: null,
    blockedOn: null,
    issueType: null,
    blockedByIssues: [],
    sprintIterationId: null,
    ...overrides,
  };
}

function makeSnapshot(items: SnapshotItem[]): ProjectSnapshot {
  return {
    items,
    rateLimit: { remaining: 5000, used: 0, resetAt: '2026-06-02T16:00:00Z' },
    currentSprintIterationId: null,
  };
}

function makeSession(issueNumber: number): InFlightSession {
  return {
    issueNumber,
    branch: `feat/${issueNumber}-x`,
    worktreePath: `/tmp/jinn-mono_worktrees/${issueNumber}`,
    pid: null,
    startedAt: 1,
    logPath: `/tmp/autopilot/sessions/${issueNumber}.log`,
  };
}

function makeSink(): DeliverySink & { collect: ReturnType<typeof vi.fn> } {
  return { collect: vi.fn().mockResolvedValue(undefined) };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('makeCollectCompletions', () => {
  it('classifies a finished In-Review session as pr-opened and recovers the PR number', async () => {
    const snapshot = makeSnapshot([makeItem({ number: 101, status: 'In Review' })]);
    const runner: CommandRunner = vi
      .fn()
      .mockResolvedValue(JSON.stringify([{ number: 555 }]));
    const sink = makeSink();

    const collect = makeCollectCompletions(snapshot, runner, sink);
    const results = await collect([makeSession(101)], []);

    expect(runner).toHaveBeenCalledWith('gh', [
      'pr', 'list',
      '--repo', 'Jinn-Network/mono',
      '--head', 'feat/101-x',
      '--state', 'open',
      '--json', 'number',
    ]);
    const expected: SessionResult[] = [
      { issueNumber: 101, outcome: 'pr-opened', prNumber: 555 },
    ];
    expect(results).toEqual(expected);
    expect(sink.collect).toHaveBeenCalledWith(expected[0]);
  });

  it('classifies a finished non-In-Review session as escalated', async () => {
    const snapshot = makeSnapshot([
      makeItem({ number: 102, status: 'In Progress', blockedOn: 'Human' }),
    ]);
    const runner: CommandRunner = vi.fn();
    const sink = makeSink();

    const collect = makeCollectCompletions(snapshot, runner, sink);
    const results = await collect([makeSession(102)], []);

    expect(results).toEqual([{ issueNumber: 102, outcome: 'escalated' }]);
    expect(sink.collect).toHaveBeenCalledWith({ issueNumber: 102, outcome: 'escalated' });
    // No PR lookup for an escalation.
    expect(runner).not.toHaveBeenCalled();
  });

  it('yields pr-opened with undefined prNumber when `gh pr list` returns no PR', async () => {
    const snapshot = makeSnapshot([makeItem({ number: 103, status: 'In Review' })]);
    const runner: CommandRunner = vi.fn().mockResolvedValue(JSON.stringify([]));
    const sink = makeSink();

    const collect = makeCollectCompletions(snapshot, runner, sink);
    const results = await collect([makeSession(103)], []);

    expect(results).toEqual([
      { issueNumber: 103, outcome: 'pr-opened', prNumber: undefined },
    ]);
    expect(sink.collect).toHaveBeenCalledOnce();
  });

  it('returns [] and touches nothing when no session finished', async () => {
    const snapshot = makeSnapshot([makeItem({ number: 104, status: 'In Progress' })]);
    const runner: CommandRunner = vi.fn();
    const sink = makeSink();

    const collect = makeCollectCompletions(snapshot, runner, sink);
    const results = await collect([makeSession(104)], [makeSession(104)]);

    expect(results).toEqual([]);
    expect(sink.collect).not.toHaveBeenCalled();
    expect(runner).not.toHaveBeenCalled();
  });

  it('classifies only the session that left the in-flight set', async () => {
    const snapshot = makeSnapshot([
      makeItem({ number: 101, status: 'In Progress', blockedOn: 'Human' }),
      makeItem({ number: 102, status: 'In Progress' }),
    ]);
    const runner: CommandRunner = vi.fn();
    const sink = makeSink();

    const collect = makeCollectCompletions(snapshot, runner, sink);
    // prev = [101, 102]; current = [102] → only 101 finished.
    const results = await collect([makeSession(101), makeSession(102)], [makeSession(102)]);

    expect(results).toEqual([{ issueNumber: 101, outcome: 'escalated' }]);
    expect(sink.collect).toHaveBeenCalledOnce();
  });

  it('escalates (no crash) when a finished issue is absent from the snapshot', async () => {
    const snapshot = makeSnapshot([]); // 105 not on the board
    const runner: CommandRunner = vi.fn();
    const sink = makeSink();

    const collect = makeCollectCompletions(snapshot, runner, sink);
    const results = await collect([makeSession(105)], []);

    expect(results).toEqual([{ issueNumber: 105, outcome: 'escalated' }]);
    expect(sink.collect).toHaveBeenCalledOnce();
  });
});
