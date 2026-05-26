import { describe, it, expect } from 'vitest';
import {
  discoverSessions,
  encodeWorktreePathToProjectDir,
  lastAssistantText,
  lastTimestamp,
  parseIssueNumberFromWorktree,
  parseJsonlLines,
  prLinkRecord,
  renderJson,
  renderTable,
  truncate,
} from '../../src/cli/sessions.js';
import type { SessionRecord, SessionsDeps } from '../../src/cli/sessions.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FIX_WITH_TEXT = [
  JSON.stringify({ type: 'queue-operation', operation: 'enqueue', timestamp: '2026-05-26T00:00:00.000Z' }),
  JSON.stringify({ type: 'user', timestamp: '2026-05-26T00:00:01.000Z', message: { content: [{ type: 'text', text: 'hi' }] } }),
  JSON.stringify({ type: 'assistant', timestamp: '2026-05-26T00:01:00.000Z', message: { content: [{ type: 'thinking', thinking: '...' }, { type: 'text', text: 'first summary' }] } }),
  JSON.stringify({ type: 'assistant', timestamp: '2026-05-26T00:02:00.000Z', message: { content: [{ type: 'text', text: 'latest summary' }] } }),
  '',
].join('\n');

const FIX_TOOL_USE_ONLY = [
  JSON.stringify({ type: 'assistant', timestamp: '2026-05-26T00:00:00.000Z', message: { content: [{ type: 'tool_use', name: 'Bash' }] } }),
  '',
].join('\n');

const FIX_WITH_PR_LINK = [
  JSON.stringify({ type: 'assistant', timestamp: '2026-05-26T00:01:00.000Z', message: { content: [{ type: 'text', text: 'opened PR' }] } }),
  JSON.stringify({ type: 'pr-link', timestamp: '2026-05-26T00:02:00.000Z', prNumber: 612, prUrl: 'https://github.com/Jinn-Network/mono/pull/612' }),
  '',
].join('\n');

const FIX_BLANK_AND_GARBAGE = [
  '',
  'not json at all',
  JSON.stringify({ type: 'assistant', timestamp: '2026-05-26T00:00:00.000Z', message: { content: [{ type: 'text', text: 'ok' }] } }),
  '',
].join('\n');

// ---------------------------------------------------------------------------
// Test helper: build an in-memory SessionsDeps
// ---------------------------------------------------------------------------

function buildDeps(overrides: Partial<SessionsDeps> = {}): SessionsDeps {
  return {
    worktreesBase: '/wt',
    claudeProjectsDir: '/p',
    now: () => Date.parse('2026-05-26T12:00:00.000Z'),
    listProjectDirs: async () => [],
    listJsonlFiles: async () => [],
    readJsonl: async () => '',
    listClaudeProcesses: async () => [],
    resolveProcessCwd: async () => null,
    spawnTail: () => { throw new Error('spawnTail not stubbed'); },
    sendSignal: () => { throw new Error('sendSignal not stubbed'); },
    confirm: async () => false,
    stdout: process.stdout,
    stderr: process.stderr,
    onSigint: () => {},
    ...overrides,
  };
}

describe('encodeWorktreePathToProjectDir', () => {
  it('encodes the live worktree path from this machine', () => {
    expect(
      encodeWorktreePathToProjectDir(
        "/Users/adrianobradley/life's-work/jinn-mono_worktrees/587",
      ),
    ).toBe('-Users-adrianobradley-life-s-work-jinn-mono-worktrees-587');
  });

  it('encodes a short absolute path', () => {
    expect(encodeWorktreePathToProjectDir('/tmp/foo')).toBe('-tmp-foo');
  });

  it('collapses apostrophe + underscore runs to a single dash', () => {
    expect(encodeWorktreePathToProjectDir("/Users/a/b'c_d/e")).toBe('-Users-a-b-c-d-e');
  });

  it('trims a trailing dash from a trailing-slash path', () => {
    expect(encodeWorktreePathToProjectDir('/Users/a/')).toBe('-Users-a');
  });
});

describe('parseIssueNumberFromWorktree', () => {
  it('returns the numeric leaf when worktreePath is a direct child of base', () => {
    expect(parseIssueNumberFromWorktree('/wt/587', '/wt')).toBe(587);
  });

  it('returns null when worktreePath is not under base', () => {
    expect(parseIssueNumberFromWorktree('/other/587', '/wt')).toBeNull();
  });

  it('returns null when the leaf is non-numeric', () => {
    expect(parseIssueNumberFromWorktree('/wt/feature-branch', '/wt')).toBeNull();
  });

  it('returns null for nested children (only direct children count)', () => {
    expect(parseIssueNumberFromWorktree('/wt/587/sub', '/wt')).toBeNull();
  });

  it('handles a trailing slash on base', () => {
    expect(parseIssueNumberFromWorktree('/wt/587', '/wt/')).toBe(587);
  });
});

describe('parseJsonlLines', () => {
  it('skips blank lines and non-JSON lines', () => {
    const records = parseJsonlLines(FIX_BLANK_AND_GARBAGE);
    expect(records).toHaveLength(1);
  });
});

describe('lastTimestamp', () => {
  it('returns the max ISO-8601 timestamp across records', () => {
    const records = parseJsonlLines(FIX_WITH_TEXT);
    expect(lastTimestamp(records)).toBe(Date.parse('2026-05-26T00:02:00.000Z'));
  });

  it('returns a finite number even when some lines are garbage', () => {
    const records = parseJsonlLines(FIX_BLANK_AND_GARBAGE);
    const ts = lastTimestamp(records);
    expect(ts).not.toBeNull();
    expect(Number.isFinite(ts)).toBe(true);
  });
});

describe('lastAssistantText', () => {
  it('returns the most recent text block from assistant records', () => {
    const records = parseJsonlLines(FIX_WITH_TEXT);
    expect(lastAssistantText(records)).toBe('latest summary');
  });

  it('returns null when the only assistant blocks are tool_use', () => {
    const records = parseJsonlLines(FIX_TOOL_USE_ONLY);
    expect(lastAssistantText(records)).toBeNull();
  });
});

describe('prLinkRecord', () => {
  it('returns the pr-link payload when present', () => {
    const records = parseJsonlLines(FIX_WITH_PR_LINK);
    expect(prLinkRecord(records)).toEqual({
      prNumber: 612,
      prUrl: 'https://github.com/Jinn-Network/mono/pull/612',
    });
  });

  it('returns null when no pr-link record is present', () => {
    const records = parseJsonlLines(FIX_WITH_TEXT);
    expect(prLinkRecord(records)).toBeNull();
  });
});

describe('truncate', () => {
  it('returns the input unchanged when shorter than the cap', () => {
    expect(truncate('hi', 10)).toBe('hi');
  });

  it('truncates and appends ellipsis when longer than the cap', () => {
    const out = truncate('hello world', 5);
    expect(out).toBe('he...');
    expect(out).toHaveLength(5);
  });

  it('returns the input unchanged at exact cap', () => {
    expect(truncate('abc', 3)).toBe('abc');
  });

  it('returns only the ellipsis when the cap is shorter than the input + ellipsis', () => {
    expect(truncate('abcd', 3)).toBe('...');
  });
});

describe('discoverSessions', () => {
  const NOW = Date.parse('2026-05-26T12:00:00.000Z');
  const MS_PER_HOUR = 3600_000;

  // Build a one-record JSONL anchored at a specific timestamp so each fixture
  // controls its own `lastActivity`. Includes one assistant text block so the
  // record has a deterministic `lastSummary`.
  function jsonlAt(timestampMs: number, summary: string): string {
    return [
      JSON.stringify({
        type: 'assistant',
        timestamp: new Date(timestampMs).toISOString(),
        message: { content: [{ type: 'text', text: summary }] },
      }),
      '',
    ].join('\n');
  }

  it('classifies alive/done and excludes stale; sorts by lastActivity desc', async () => {
    const aliveTs = NOW - 30 * 60_000;        // T - 30m
    const doneTs = NOW - 1 * MS_PER_HOUR;      // T - 1h
    const staleTs = NOW - 26 * MS_PER_HOUR;    // T - 26h

    const transcripts: Record<string, string> = {
      '/p/-wt-100/sess-100.jsonl': jsonlAt(aliveTs, 'latest summary'),
      '/p/-wt-200/sess-200.jsonl': jsonlAt(doneTs, 'done summary'),
      '/p/-wt-300/sess-300.jsonl': jsonlAt(staleTs, 'stale summary'),
    };

    const deps = buildDeps({
      listProjectDirs: async () => ['-wt-100', '-wt-200', '-wt-300'],
      listJsonlFiles: async (dir) => {
        if (dir === '/p/-wt-100') return [{ name: 'sess-100.jsonl', mtimeMs: aliveTs }];
        if (dir === '/p/-wt-200') return [{ name: 'sess-200.jsonl', mtimeMs: doneTs }];
        if (dir === '/p/-wt-300') return [{ name: 'sess-300.jsonl', mtimeMs: staleTs }];
        return [];
      },
      readJsonl: async (path) => transcripts[path] ?? '',
      listClaudeProcesses: async () => [{ pid: 1000 }],
      resolveProcessCwd: async (pid) => (pid === 1000 ? '/wt/100' : null),
    });

    const records = await discoverSessions(deps);
    expect(records).toHaveLength(2);
    expect(records[0]?.issueNumber).toBe(100);
    expect(records[0]?.status).toBe('alive');
    expect(records[0]?.pid).toBe(1000);
    expect(records[0]?.lastSummary).toBe('latest summary');
    expect(records[1]?.issueNumber).toBe(200);
    expect(records[1]?.status).toBe('done');
    expect(records[1]?.pid).toBeNull();
  });

  it('ignores project dirs whose decoded path is not under worktreesBase', async () => {
    const ts = NOW - 30 * 60_000;
    const deps = buildDeps({
      listProjectDirs: async () => ['-wt-100', '-Users-elsewhere'],
      listJsonlFiles: async (dir) => {
        if (dir === '/p/-wt-100') return [{ name: 'sess.jsonl', mtimeMs: ts }];
        return [];
      },
      readJsonl: async () => jsonlAt(ts, 'ok'),
    });

    const records = await discoverSessions(deps);
    expect(records).toHaveLength(1);
    expect(records[0]?.issueNumber).toBe(100);
  });

  it('ignores project dirs whose leaf is non-numeric', async () => {
    const ts = NOW - 30 * 60_000;
    const deps = buildDeps({
      listProjectDirs: async () => ['-wt-feature-branch'],
      listJsonlFiles: async () => [{ name: 'sess.jsonl', mtimeMs: ts }],
      readJsonl: async () => jsonlAt(ts, 'ok'),
    });

    const records = await discoverSessions(deps);
    expect(records).toHaveLength(0);
  });
});

describe('renderJson', () => {
  const sample: SessionRecord = {
    issueNumber: 100,
    status: 'alive',
    pid: 1234,
    worktreePath: '/wt/100',
    transcriptPath: '/p/-wt-100/sess.jsonl',
    sessionId: 'sess',
    lastActivity: '2026-05-26T11:30:00.000Z',
    lastSummary: 'hello',
    prUrl: null,
  };

  it('round-trips through JSON.parse', () => {
    const out = renderJson([sample]);
    expect(JSON.parse(out)).toEqual([sample]);
  });

  it('renders an empty array as "[]"', () => {
    expect(renderJson([])).toBe('[]');
  });

  it('emits exactly the nine documented fields', () => {
    const parsed = JSON.parse(renderJson([sample])) as SessionRecord[];
    expect(Object.keys(parsed[0]!).sort()).toEqual([
      'issueNumber',
      'lastActivity',
      'lastSummary',
      'pid',
      'prUrl',
      'sessionId',
      'status',
      'transcriptPath',
      'worktreePath',
    ]);
  });
});

describe('renderTable', () => {
  const alive: SessionRecord = {
    issueNumber: 100,
    status: 'alive',
    pid: 1234,
    worktreePath: '/wt/100',
    transcriptPath: '/p/-wt-100/sess.jsonl',
    sessionId: 'sess',
    lastActivity: '2026-05-26T11:30:00.000Z',
    lastSummary: 'hello',
    prUrl: null,
  };
  const done: SessionRecord = {
    issueNumber: 200,
    status: 'done',
    pid: null,
    worktreePath: '/wt/200',
    transcriptPath: '/p/-wt-200/sess.jsonl',
    sessionId: 'sess',
    lastActivity: '2026-05-26T11:00:00.000Z',
    lastSummary: null,
    prUrl: null,
  };

  it('renders the header columns in the documented order', () => {
    const out = renderTable([alive]);
    const header = out.split('\n')[0]!;
    const idxIssue = header.indexOf('ISSUE');
    const idxStatus = header.indexOf('STATUS');
    const idxPid = header.indexOf('PID');
    const idxLast = header.indexOf('LAST ACTIVITY');
    const idxSummary = header.indexOf('SUMMARY');
    expect(idxIssue).toBeGreaterThanOrEqual(0);
    expect(idxStatus).toBeGreaterThan(idxIssue);
    expect(idxPid).toBeGreaterThan(idxStatus);
    expect(idxLast).toBeGreaterThan(idxPid);
    expect(idxSummary).toBeGreaterThan(idxLast);
  });

  it('renders an alive session with the pid as a decimal integer', () => {
    const out = renderTable([alive]);
    expect(out).toContain('1234');
  });

  it('renders a done session with "-" in the PID column', () => {
    const out = renderTable([done]);
    const dataLine = out.split('\n').find((line) => line.includes('200'));
    expect(dataLine).toBeDefined();
    expect(dataLine).toMatch(/\b-\b/);
  });

  it('renders null lastSummary as "(no assistant text)"', () => {
    const out = renderTable([done]);
    expect(out).toContain('(no assistant text)');
  });

  it('renders empty input as header + "(no sessions in the last 24h)"', () => {
    const out = renderTable([]);
    expect(out).toContain('ISSUE');
    expect(out).toContain('(no sessions in the last 24h)');
  });
});
