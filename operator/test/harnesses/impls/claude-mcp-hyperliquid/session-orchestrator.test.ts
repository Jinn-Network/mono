/**
 * Tests for session-orchestrator.ts — cadence logic, market-move trigger,
 * and child-process lifecycle (spawnSession, runSessionLoop).
 * Claude is mocked via _spawnFn injection — no real subprocesses spawned.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import {
  checkMarketMoveTrigger,
  spawnSession,
  runSessionLoop,
} from '../../../../src/harnesses/impls/claude-mcp-hyperliquid/session-orchestrator.js';
import { TrajectoryCollector } from '../../../../src/trajectory/collector.js';

// ── Fake child-process factory ─────────────────────────────────────────────────

/**
 * Creates a fake child process that emits controllable stdout/stderr/exit events.
 * Returns both the fake child and control handles.
 */
function makeFakeChild() {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const child = new EventEmitter() as EventEmitter & {
    stdout: typeof stdout;
    stderr: typeof stderr;
    kill: ReturnType<typeof vi.fn>;
    pid: number;
  };
  child.stdout = stdout;
  child.stderr = stderr;
  child.kill = vi.fn().mockImplementation((_signal?: string) => {
    // Simulate process termination on kill
    setImmediate(() => child.emit('exit', null, 'SIGTERM'));
  });
  child.pid = 12345;

  return {
    child: child as unknown as ChildProcess,
    emitStdout: (data: string) => stdout.emit('data', Buffer.from(data)),
    emitStderr: (data: string) => stderr.emit('data', Buffer.from(data)),
    emitExit: (code: number | null, signal?: string) => child.emit('exit', code, signal ?? null),
    emitError: (err: Error) => child.emit('error', err),
    killMock: child.kill,
  };
}

/** Build minimal OrchestratorDeps for testing. */
type SpawnFn = NonNullable<Parameters<typeof spawnSession>[2]['_spawnFn']>;

function makeDeps(
  tmpDir: string,
  overrides: Partial<Parameters<typeof spawnSession>[2]> = {},
): Parameters<typeof spawnSession>[2] {
  return {
    claudePath: 'claude',
    mcpConfigPath: '/dev/null',
    workingDir: tmpDir,
    abort: new AbortController().signal,
    msUntilEndTs: () => 60_000,
    log: vi.fn(),
    config: {
      cadenceMs: 100, // short cadence for tests
      sessionMaxMs: 5_000,
      marketMoveTriggerFraction: 0.02,
      trackedCoins: [],
    },
    ...overrides,
  };
}

// ── spawnSession tests ─────────────────────────────────────────────────────────

describe('spawnSession', () => {
  let tmpDir: string;

  afterEach(() => {
    try { rmSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
  });

  it('resolves with session result when child exits normally', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'orch-test-'));
    const { child, emitStdout, emitExit } = makeFakeChild();

    const spawnFn: SpawnFn = vi.fn().mockReturnValue(child);

    // Emit output then exit
    setImmediate(() => {
      emitStdout('Session analysis complete\n');
      setImmediate(() => emitExit(0));
    });

    const deps = makeDeps(tmpDir, { _spawnFn: spawnFn });
    const result = await spawnSession('test-session-1', 'test prompt', deps);

    expect(result.sessionId).toBe('test-session-1');
    expect(result.stdout).toContain('Session analysis complete');
    expect(result.aborted).toBe(false);
    expect(result.initiatedFillTids).toEqual([]);
    expect(existsSync(result.transcriptPath)).toBe(true);
  });

  it('writes transcript to disk (including partial output on early exit)', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'orch-test-'));
    const { child, emitStdout, emitExit } = makeFakeChild();

    const spawnFn: SpawnFn = vi.fn().mockReturnValue(child);

    setImmediate(() => {
      emitStdout('partial output');
      setImmediate(() => emitExit(1));
    });

    const deps = makeDeps(tmpDir, { _spawnFn: spawnFn });
    const result = await spawnSession('test-session-2', 'test prompt', deps);

    const transcript = readFileSync(result.transcriptPath, 'utf-8');
    expect(transcript).toContain('partial output');
    expect(transcript).toContain('Session ended');
  });

  it('kills child and sets aborted=true when AbortSignal fires', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'orch-test-'));
    const { child, killMock } = makeFakeChild();

    const spawnFn: SpawnFn = vi.fn().mockReturnValue(child);
    const controller = new AbortController();
    const deps = makeDeps(tmpDir, { abort: controller.signal, _spawnFn: spawnFn });

    const sessionPromise = spawnSession('test-session-3', 'test prompt', deps);

    // Fire abort signal after a tick
    setImmediate(() => controller.abort());

    const result = await sessionPromise;
    expect(result.aborted).toBe(true);
    expect(killMock).toHaveBeenCalled();
  });

  it('resolves with empty stdout on spawn error; transcript records error', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'orch-test-'));
    const { child, emitError } = makeFakeChild();

    const spawnFn: SpawnFn = vi.fn().mockReturnValue(child);

    setImmediate(() => emitError(new Error('ENOENT: claude not found')));

    const deps = makeDeps(tmpDir, { _spawnFn: spawnFn });
    const result = await spawnSession('test-session-err', 'test prompt', deps);

    expect(result.stdout).toBe('');
    expect(result.aborted).toBe(false);
    // Transcript should record the error
    const transcript = readFileSync(result.transcriptPath, 'utf-8');
    expect(transcript).toContain('spawn error');
  });

  it('kills child on session timeout and transcript records session end', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'orch-test-'));
    const { child, killMock } = makeFakeChild();

    const spawnFn: SpawnFn = vi.fn().mockReturnValue(child);

    // Short session max time; child never exits on its own
    const deps = makeDeps(tmpDir, {
      _spawnFn: spawnFn,
      config: { cadenceMs: 100, sessionMaxMs: 50, marketMoveTriggerFraction: 0.02, trackedCoins: [] },
    });

    const result = await spawnSession('test-session-timeout', 'test prompt', deps);

    // kill() should have been called due to timeout
    expect(killMock).toHaveBeenCalled();
    expect(existsSync(result.transcriptPath)).toBe(true);
  });
});

// ── runSessionLoop tests ───────────────────────────────────────────────────────

describe('runSessionLoop', () => {
  let tmpDir: string;

  afterEach(() => {
    try { rmSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
  });

  it('runs exactly one session when AbortSignal fires after first session', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'orch-loop-'));

    const controller = new AbortController();
    let sessionCount = 0;

    const spawnFn: SpawnFn = vi.fn().mockImplementation(() => {
      sessionCount++;
      const { child, emitExit } = makeFakeChild();
      setImmediate(() => {
        emitExit(0);
        // Abort after first session exits
        if (sessionCount === 1) setImmediate(() => controller.abort());
      });
      return child;
    });

    const deps = makeDeps(tmpDir, {
      abort: controller.signal,
      _spawnFn: spawnFn,
      config: { cadenceMs: 50, sessionMaxMs: 5000, marketMoveTriggerFraction: 0.02, trackedCoins: [] },
    });

    const loopResult = await runSessionLoop(
      (n, _id) => `Session ${n} prompt`,
      deps,
    );

    expect(loopResult.sessions).toHaveLength(1);
    expect(loopResult.totalSessions).toBe(1);
  });

  it('respects msUntilEndTs: stops loop when window expires after first session', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'orch-loop-'));

    const spawnFn: SpawnFn = vi.fn().mockImplementation(() => {
      const { child, emitExit } = makeFakeChild();
      setImmediate(() => emitExit(0));
      return child;
    });

    // msUntilEndTs returns positive for first loop-entry check, then 0
    let callCount = 0;
    const deps = makeDeps(tmpDir, {
      _spawnFn: spawnFn,
      msUntilEndTs: () => {
        callCount++;
        return callCount <= 1 ? 1000 : 0;
      },
      config: { cadenceMs: 50, sessionMaxMs: 5000, marketMoveTriggerFraction: 0.02, trackedCoins: [] },
    });

    const loopResult = await runSessionLoop(
      (n, _id) => `Session ${n} prompt`,
      deps,
    );

    expect(loopResult.sessions).toHaveLength(1);
  });

  it('collects multiple sessions before abort', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'orch-loop-'));

    const controller = new AbortController();
    let sessionCount = 0;

    const spawnFn: SpawnFn = vi.fn().mockImplementation(() => {
      sessionCount++;
      const { child, emitExit } = makeFakeChild();
      setImmediate(() => {
        emitExit(0);
        if (sessionCount === 2) setImmediate(() => controller.abort());
      });
      return child;
    });

    const deps = makeDeps(tmpDir, {
      abort: controller.signal,
      _spawnFn: spawnFn,
      config: { cadenceMs: 10, sessionMaxMs: 5000, marketMoveTriggerFraction: 0.02, trackedCoins: [] },
    });

    const loopResult = await runSessionLoop(
      (n, _id) => `Session ${n} prompt`,
      deps,
    );

    expect(loopResult.sessions).toHaveLength(2);
    expect(loopResult.totalSessions).toBe(2);
  });
});

describe('checkMarketMoveTrigger', () => {
  it('returns triggered=false when no coins tracked', () => {
    const result = checkMarketMoveTrigger(
      { BTC: '50000', ETH: '3000' },
      { BTC: '55000', ETH: '3100' },
      [],
      0.02,
    );
    expect(result.triggered).toBe(false);
  });

  it('returns triggered=false when move below threshold', () => {
    const result = checkMarketMoveTrigger(
      { BTC: '50000' },
      { BTC: '50900' }, // 1.8% move
      ['BTC'],
      0.02,
    );
    expect(result.triggered).toBe(false);
  });

  it('triggers when move equals threshold', () => {
    const result = checkMarketMoveTrigger(
      { BTC: '50000' },
      { BTC: '51000' }, // exactly 2% move
      ['BTC'],
      0.02,
    );
    expect(result.triggered).toBe(true);
    expect(result.coin).toBe('BTC');
    expect(result.moveFraction).toBeCloseTo(0.02, 5);
  });

  it('triggers when move exceeds threshold', () => {
    const result = checkMarketMoveTrigger(
      { ETH: '3000' },
      { ETH: '3100' }, // 3.33% move
      ['ETH'],
      0.02,
    );
    expect(result.triggered).toBe(true);
    expect(result.coin).toBe('ETH');
  });

  it('triggers on downward move', () => {
    const result = checkMarketMoveTrigger(
      { BTC: '50000' },
      { BTC: '48000' }, // -4% move
      ['BTC'],
      0.02,
    );
    expect(result.triggered).toBe(true);
  });

  it('skips coin with no prev mid (prev=0)', () => {
    const result = checkMarketMoveTrigger(
      {},
      { BTC: '50000' },
      ['BTC'],
      0.02,
    );
    expect(result.triggered).toBe(false);
  });

  it('returns first triggered coin', () => {
    const result = checkMarketMoveTrigger(
      { BTC: '50000', ETH: '3000' },
      { BTC: '51500', ETH: '3100' }, // BTC: 3%, ETH: 3.33%
      ['BTC', 'ETH'],
      0.02,
    );
    expect(result.triggered).toBe(true);
    // BTC is checked first
    expect(result.coin).toBe('BTC');
  });
});

// ── Trajectory span emission ───────────────────────────────────────────────────

describe('spawnSession — trajectory spans', () => {
  let tmpDir: string;

  afterEach(() => {
    try { rmSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
  });

  it('emits a jinn.state_transition span when trajectory collector is provided and session exits', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'orch-traj-'));
    const { child, emitStdout, emitExit } = makeFakeChild();
    const spawnFn: SpawnFn = vi.fn().mockReturnValue(child);

    const collector = new TrajectoryCollector({ taskCid: 'bafy-test', runId: 'run-traj-1' });

    setImmediate(() => {
      emitStdout('some output\n');
      setImmediate(() => emitExit(0));
    });

    const deps = makeDeps(tmpDir, { _spawnFn: spawnFn, trajectory: collector });
    await spawnSession('traj-session-1', 'test prompt', deps);

    const { spans } = collector.snapshot();
    expect(spans).toHaveLength(1);
    const span = spans[0];
    expect(span.attributes['jinn.span.kind']).toBe('jinn.state_transition');
    expect(span.attributes['jinn.state.from']).toBe('PREPARED');
    expect(span.attributes['jinn.state.to']).toBe('RAN_CLAUDE');
    expect(span.attributes['subprocess.cmd']).toBe('claude');
    expect(span.attributes['subprocess.exit_code']).toBe(0);
    expect(span.attributes['session.id']).toBe('traj-session-1');
    expect(span.status.code).toBe('OK');
  });

  it('emits an ERROR span when session exits non-zero', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'orch-traj-'));
    const { child, emitExit } = makeFakeChild();
    const spawnFn: SpawnFn = vi.fn().mockReturnValue(child);

    const collector = new TrajectoryCollector({ taskCid: 'bafy-test', runId: 'run-traj-2' });

    setImmediate(() => emitExit(1));

    const deps = makeDeps(tmpDir, { _spawnFn: spawnFn, trajectory: collector });
    await spawnSession('traj-session-2', 'test prompt', deps);

    const { spans } = collector.snapshot();
    expect(spans[0].status.code).toBe('ERROR');
    expect(spans[0].attributes['subprocess.exit_code']).toBe(1);
  });

  it('emits an ERROR span with exception event on spawn error', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'orch-traj-'));
    const { child, emitError } = makeFakeChild();
    const spawnFn: SpawnFn = vi.fn().mockReturnValue(child);

    const collector = new TrajectoryCollector({ taskCid: 'bafy-test', runId: 'run-traj-3' });

    setImmediate(() => emitError(new Error('ENOENT: claude not found')));

    const deps = makeDeps(tmpDir, { _spawnFn: spawnFn, trajectory: collector });
    await spawnSession('traj-session-err', 'test prompt', deps);

    const { spans } = collector.snapshot();
    expect(spans).toHaveLength(1);
    expect(spans[0].status.code).toBe('ERROR');
    expect(spans[0].events[0].name).toBe('exception');
    expect(spans[0].events[0].attributes?.['exception.message']).toContain('ENOENT');
  });

  it('does not emit a span when no trajectory collector is provided', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'orch-traj-'));
    const { child, emitExit } = makeFakeChild();
    const spawnFn: SpawnFn = vi.fn().mockReturnValue(child);

    setImmediate(() => emitExit(0));

    // No trajectory field — should not throw
    const deps = makeDeps(tmpDir, { _spawnFn: spawnFn });
    await expect(spawnSession('no-traj-session', 'test prompt', deps)).resolves.toBeDefined();
  });
});
