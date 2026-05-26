import { describe, it, expect } from 'vitest';
import { Readable, Writable } from 'node:stream';
import {
  PrettyPrintTransform,
  discoverSessions,
  encodeWorktreePathToProjectDir,
  killSession,
  lastAssistantText,
  lastTimestamp,
  parseJsonlLines,
  prLinkRecord,
  renderJson,
  renderTable,
  runSessionsCli,
  tailSession,
  tildeCompress,
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
    const idxWorktree = header.indexOf('WORKTREE');
    const idxLast = header.indexOf('LAST ACTIVITY');
    const idxSummary = header.indexOf('SUMMARY');
    const idxTranscript = header.indexOf('TRANSCRIPT');
    expect(idxIssue).toBeGreaterThanOrEqual(0);
    expect(idxStatus).toBeGreaterThan(idxIssue);
    expect(idxPid).toBeGreaterThan(idxStatus);
    expect(idxWorktree).toBeGreaterThan(idxPid);
    expect(idxLast).toBeGreaterThan(idxWorktree);
    expect(idxSummary).toBeGreaterThan(idxLast);
    expect(idxTranscript).toBeGreaterThan(idxSummary);
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
    expect(out).toContain('WORKTREE');
    expect(out).toContain('TRANSCRIPT');
    expect(out).toContain('(no sessions in the last 24h)');
  });

  it('renders the WORKTREE column with the home prefix collapsed to ~', () => {
    const rec: SessionRecord = {
      ...alive,
      worktreePath: '/home/test/work/100',
    };
    const out = renderTable([rec], '/home/test');
    expect(out).toContain('~/work/100');
    expect(out).not.toContain('/home/test/work/100');
  });

  it('renders the TRANSCRIPT column as only the JSONL basename (sessionId)', () => {
    const rec: SessionRecord = {
      ...alive,
      transcriptPath: '/home/test/.claude/projects/-wt-100/abcd-1234.jsonl',
    };
    const out = renderTable([rec], '/home/test');
    expect(out).toContain('abcd-1234.jsonl');
    // The deterministic projects/<dir>/ prefix must be elided from the table.
    expect(out).not.toContain('.claude/projects');
  });
});

describe('tildeCompress', () => {
  it('replaces a leading home prefix with ~', () => {
    expect(tildeCompress('/home/test/foo/bar', '/home/test')).toBe('~/foo/bar');
  });

  it('returns the path unchanged when home does not prefix it', () => {
    expect(tildeCompress('/other/path', '/home/test')).toBe('/other/path');
  });

  it('handles a trailing slash on home', () => {
    expect(tildeCompress('/home/test/foo', '/home/test/')).toBe('~/foo');
  });

  it('returns ~ when path equals home exactly', () => {
    expect(tildeCompress('/home/test', '/home/test')).toBe('~');
  });
});

describe('PrettyPrintTransform', () => {
  // Drive the transform with a buffer and collect output text.
  function pump(input: string | string[]): Promise<string> {
    const chunks = Array.isArray(input) ? input : [input];
    return new Promise((resolve, reject) => {
      const t = new PrettyPrintTransform();
      const out: Buffer[] = [];
      t.on('data', (chunk: Buffer) => out.push(chunk));
      t.on('end', () => resolve(Buffer.concat(out).toString('utf8')));
      t.on('error', reject);
      for (const c of chunks) t.write(Buffer.from(c));
      t.end();
    });
  }

  it('emits one line per assistant text block', async () => {
    const out = await pump(FIX_WITH_TEXT);
    expect(out).toContain('[00:01:00 assistant] first summary');
    expect(out).toContain('[00:02:00 assistant] latest summary');
  });

  it('emits user text blocks', async () => {
    const out = await pump(FIX_WITH_TEXT);
    expect(out).toContain('[00:00:01 user] hi');
  });

  it('emits pr-link records with #N and URL', async () => {
    const out = await pump(FIX_WITH_PR_LINK);
    expect(out).toContain('[00:02:00 pr-link] #612 https://github.com/Jinn-Network/mono/pull/612');
  });

  it('drops queue-operation, attachment, tool_use-only assistant records, and thinking-only blocks', async () => {
    const fix = [
      JSON.stringify({ type: 'queue-operation', operation: 'enqueue', timestamp: '2026-05-26T00:00:00.000Z' }),
      JSON.stringify({ type: 'attachment', timestamp: '2026-05-26T00:00:00.000Z' }),
      JSON.stringify({ type: 'last-prompt', timestamp: '2026-05-26T00:00:00.000Z' }),
      JSON.stringify({ type: 'assistant', timestamp: '2026-05-26T00:00:00.000Z', message: { content: [{ type: 'thinking', thinking: '...' }] } }),
      JSON.stringify({ type: 'assistant', timestamp: '2026-05-26T00:00:00.000Z', message: { content: [{ type: 'tool_use', name: 'Bash' }] } }),
      '',
    ].join('\n');
    const out = await pump(fix);
    expect(out).toBe('');
  });

  it('handles partial chunks across line boundaries', async () => {
    const split = Math.floor(FIX_WITH_TEXT.length / 2);
    const out = await pump([FIX_WITH_TEXT.slice(0, split), FIX_WITH_TEXT.slice(split)]);
    expect(out).toContain('[00:01:00 assistant] first summary');
    expect(out).toContain('[00:02:00 assistant] latest summary');
  });

  it('silently drops malformed JSON lines', async () => {
    const fix = [
      'not json',
      JSON.stringify({ type: 'assistant', timestamp: '2026-05-26T00:00:00.000Z', message: { content: [{ type: 'text', text: 'ok' }] } }),
      '',
    ].join('\n');
    const out = await pump(fix);
    expect(out).toContain('[00:00:00 assistant] ok');
  });
});

describe('tailSession', () => {
  function captureWritable(): { write: Writable; collected: string[] } {
    const collected: string[] = [];
    const write = new Writable({
      write(chunk, _enc, cb) {
        collected.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
        cb();
      },
    });
    return { write, collected };
  }

  // Configure a deps fixture where issue #500 has one transcript file.
  function setupDeps(overrides: Partial<SessionsDeps> = {}): SessionsDeps {
    return buildDeps({
      listProjectDirs: async () => ['-wt-500'],
      listJsonlFiles: async () => [{ name: 'sess-500.jsonl', mtimeMs: Date.parse('2026-05-26T11:30:00.000Z') }],
      readJsonl: async () => FIX_WITH_TEXT,
      ...overrides,
    });
  }

  it('passes the resolved transcript path to spawnTail', async () => {
    let receivedPath: string | undefined;
    const { write } = captureWritable();
    const deps = setupDeps({
      stdout: write,
      spawnTail: (path) => {
        receivedPath = path;
        return { stdout: Readable.from([]), kill: () => {} };
      },
    });
    await tailSession(500, { tailLines: 50 }, deps);
    expect(receivedPath).toBe('/p/-wt-500/sess-500.jsonl');
  });

  it('pipes spawnTail stdout through PrettyPrintTransform into deps.stdout', async () => {
    const { write, collected } = captureWritable();
    const deps = setupDeps({
      stdout: write,
      spawnTail: () => ({ stdout: Readable.from([Buffer.from(FIX_WITH_TEXT)]), kill: () => {} }),
    });
    await tailSession(500, { tailLines: 50 }, deps);
    const out = collected.join('');
    expect(out).toContain('[00:01:00 assistant] first summary');
    expect(out).toContain('[00:02:00 assistant] latest summary');
  });

  it('rejects with a clear error when no transcript matches the issue', async () => {
    const { write } = captureWritable();
    const deps = setupDeps({
      stdout: write,
      spawnTail: () => ({ stdout: Readable.from([]), kill: () => {} }),
    });
    await expect(tailSession(999, { tailLines: 50 }, deps)).rejects.toThrow(/no transcript found for issue #999/);
  });

  it('forwards SIGINT to the tail subprocess via onSigint seam', async () => {
    let killed = false;
    let installedHandler: (() => void) | null = null;
    const { write } = captureWritable();
    const deps = setupDeps({
      stdout: write,
      spawnTail: () => ({ stdout: Readable.from([]), kill: () => { killed = true; } }),
      onSigint: (handler) => { installedHandler = handler; },
    });
    await tailSession(500, { tailLines: 50 }, deps);
    expect(installedHandler).not.toBeNull();
    installedHandler!();
    expect(killed).toBe(true);
  });
});

describe('killSession', () => {
  const ALIVE_TS = Date.parse('2026-05-26T11:30:00.000Z');
  const DONE_TS = Date.parse('2026-05-26T11:00:00.000Z');

  function captureStderr(): { write: Writable; collected: string[] } {
    const collected: string[] = [];
    const write = new Writable({
      write(chunk, _enc, cb) {
        collected.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
        cb();
      },
    });
    return { write, collected };
  }

  function aliveDeps(overrides: Partial<SessionsDeps> = {}): SessionsDeps {
    return buildDeps({
      listProjectDirs: async () => ['-wt-500'],
      listJsonlFiles: async () => [{ name: 'sess.jsonl', mtimeMs: ALIVE_TS }],
      readJsonl: async () => [
        JSON.stringify({ type: 'assistant', timestamp: new Date(ALIVE_TS).toISOString(), message: { content: [{ type: 'text', text: 'ok' }] } }),
        '',
      ].join('\n'),
      listClaudeProcesses: async () => [{ pid: 4242 }],
      resolveProcessCwd: async () => '/wt/500',
      ...overrides,
    });
  }

  function doneDeps(overrides: Partial<SessionsDeps> = {}): SessionsDeps {
    return buildDeps({
      listProjectDirs: async () => ['-wt-500'],
      listJsonlFiles: async () => [{ name: 'sess.jsonl', mtimeMs: DONE_TS }],
      readJsonl: async () => [
        JSON.stringify({ type: 'assistant', timestamp: new Date(DONE_TS).toISOString(), message: { content: [{ type: 'text', text: 'done' }] } }),
        '',
      ].join('\n'),
      listClaudeProcesses: async () => [],
      resolveProcessCwd: async () => null,
      ...overrides,
    });
  }

  it('sends SIGTERM when the operator confirms with y', async () => {
    let signal: { pid?: number; sig?: NodeJS.Signals } = {};
    const { write, collected } = captureStderr();
    const deps = aliveDeps({
      confirm: async () => true,
      sendSignal: (pid, sig) => { signal = { pid, sig }; },
      stderr: write,
    });
    await killSession(500, { force: false }, deps);
    expect(signal.pid).toBe(4242);
    expect(signal.sig).toBe('SIGTERM');
    expect(collected.join('')).toContain('killed pid 4242');
  });

  it('aborts (no signal) when the operator declines', async () => {
    let called = false;
    const { write, collected } = captureStderr();
    const deps = aliveDeps({
      confirm: async () => false,
      sendSignal: () => { called = true; },
      stderr: write,
    });
    await killSession(500, { force: false }, deps);
    expect(called).toBe(false);
    expect(collected.join('')).toContain('aborted (no-op)');
  });

  it('skips the confirmation prompt when force is true', async () => {
    let confirmCalled = false;
    let sent = false;
    const { write } = captureStderr();
    const deps = aliveDeps({
      confirm: async () => { confirmCalled = true; return true; },
      sendSignal: () => { sent = true; },
      stderr: write,
    });
    await killSession(500, { force: true }, deps);
    expect(confirmCalled).toBe(false);
    expect(sent).toBe(true);
  });

  it('throws when the issue has no matching session', async () => {
    const deps = aliveDeps();
    await expect(killSession(999, { force: true }, deps)).rejects.toThrow(/no session found for issue #999/);
  });

  it('throws when the session is not alive', async () => {
    const deps = doneDeps();
    await expect(killSession(500, { force: true }, deps)).rejects.toThrow(/session for issue #500 is not alive/);
  });
});

describe('runSessionsCli', () => {
  const ALIVE_TS = Date.parse('2026-05-26T11:30:00.000Z');

  function captureWritables(): {
    stdout: Writable; stderr: Writable;
    outChunks: string[]; errChunks: string[];
  } {
    const outChunks: string[] = [];
    const errChunks: string[] = [];
    const stdout = new Writable({
      write(chunk, _enc, cb) {
        outChunks.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
        cb();
      },
    });
    const stderr = new Writable({
      write(chunk, _enc, cb) {
        errChunks.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
        cb();
      },
    });
    return { stdout, stderr, outChunks, errChunks };
  }

  function aliveCliDeps(overrides: Partial<SessionsDeps> = {}): SessionsDeps {
    return buildDeps({
      listProjectDirs: async () => ['-wt-500'],
      listJsonlFiles: async () => [{ name: 'sess.jsonl', mtimeMs: ALIVE_TS }],
      readJsonl: async () => [
        JSON.stringify({ type: 'assistant', timestamp: new Date(ALIVE_TS).toISOString(), message: { content: [{ type: 'text', text: 'hello' }] } }),
        '',
      ].join('\n'),
      listClaudeProcesses: async () => [{ pid: 4242 }],
      resolveProcessCwd: async () => '/wt/500',
      ...overrides,
    });
  }

  it('writes a human table to stdout with no flags', async () => {
    const w = captureWritables();
    const deps = aliveCliDeps({ stdout: w.stdout, stderr: w.stderr });
    await runSessionsCli([], deps);
    expect(w.outChunks.join('')).toContain('ISSUE');
  });

  it('writes JSON to stdout with --json', async () => {
    const w = captureWritables();
    const deps = aliveCliDeps({ stdout: w.stdout, stderr: w.stderr });
    await runSessionsCli(['--json'], deps);
    const parsed = JSON.parse(w.outChunks.join('').trim()) as SessionRecord[];
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.issueNumber).toBe(500);
  });

  it('routes --tail <N> to tailSession (spawnTail invoked)', async () => {
    const w = captureWritables();
    let spawnTailCalled = false;
    const deps = aliveCliDeps({
      stdout: w.stdout,
      stderr: w.stderr,
      spawnTail: () => {
        spawnTailCalled = true;
        return { stdout: Readable.from([]), kill: () => {} };
      },
    });
    await runSessionsCli(['--tail', '500'], deps);
    expect(spawnTailCalled).toBe(true);
  });

  it('routes --kill <N> to killSession with force=false (confirm invoked)', async () => {
    const w = captureWritables();
    let confirmCalled = false;
    const deps = aliveCliDeps({
      stdout: w.stdout,
      stderr: w.stderr,
      confirm: async () => { confirmCalled = true; return true; },
      sendSignal: () => {},
    });
    await runSessionsCli(['--kill', '500'], deps);
    expect(confirmCalled).toBe(true);
  });

  it('routes --kill <N> --yes to killSession with force=true (confirm skipped)', async () => {
    const w = captureWritables();
    let confirmCalled = false;
    const deps = aliveCliDeps({
      stdout: w.stdout,
      stderr: w.stderr,
      confirm: async () => { confirmCalled = true; return true; },
      sendSignal: () => {},
    });
    await runSessionsCli(['--kill', '500', '--yes'], deps);
    expect(confirmCalled).toBe(false);
  });

  it('routes --kill <N> --force the same as --yes', async () => {
    const w = captureWritables();
    let confirmCalled = false;
    const deps = aliveCliDeps({
      stdout: w.stdout,
      stderr: w.stderr,
      confirm: async () => { confirmCalled = true; return true; },
      sendSignal: () => {},
    });
    await runSessionsCli(['--kill', '500', '--force'], deps);
    expect(confirmCalled).toBe(false);
  });

  it('throws on unknown flag', async () => {
    const w = captureWritables();
    const deps = aliveCliDeps({ stdout: w.stdout, stderr: w.stderr });
    await expect(runSessionsCli(['--bogus'], deps)).rejects.toThrow(/unknown flag/);
  });

  it('throws when --tail is not followed by a number', async () => {
    const w = captureWritables();
    const deps = aliveCliDeps({ stdout: w.stdout, stderr: w.stderr });
    await expect(runSessionsCli(['--tail'], deps)).rejects.toThrow(/--tail requires an issue number/);
  });

  it('throws when --kill is not followed by a number', async () => {
    const w = captureWritables();
    const deps = aliveCliDeps({ stdout: w.stdout, stderr: w.stderr });
    await expect(runSessionsCli(['--kill'], deps)).rejects.toThrow(/--kill requires an issue number/);
  });
});
