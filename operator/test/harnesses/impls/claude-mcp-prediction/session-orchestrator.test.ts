/**
 * Tests for claude-mcp-prediction/session-orchestrator.ts — trajectory span emission.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { spawnSession } from '../../../../src/harnesses/impls/claude-mcp-prediction/session-orchestrator.js';
import { TrajectoryCollector } from '../../../../src/trajectory/collector.js';

// ── Fake child-process factory ─────────────────────────────────────────────────

function makeFakeChild() {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const child = new EventEmitter() as EventEmitter & {
    stdout: typeof stdout;
    stderr: typeof stderr;
    kill: ReturnType<typeof vi.fn>;
    killed: boolean;
  };
  child.stdout = stdout;
  child.stderr = stderr;
  child.killed = false;
  child.kill = vi.fn().mockImplementation((_signal?: string) => {
    child.killed = true;
    setImmediate(() => child.emit('exit', null, 'SIGTERM'));
  });

  return {
    child: child as unknown as ChildProcess,
    emitStdout: (data: string) => stdout.emit('data', Buffer.from(data)),
    emitExit: (code: number | null, signal?: string) => child.emit('exit', code, signal ?? null),
    emitError: (err: Error) => child.emit('error', err),
  };
}

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
    log: vi.fn(),
    isSubmitted: () => false,
    sessionMaxMs: 5_000,
    pollIntervalMs: 50,
    submissionGraceMs: 100,
    ...overrides,
  };
}

// ── Trajectory span emission tests ────────────────────────────────────────────

describe('spawnSession (prediction) — trajectory spans', () => {
  let tmpDir: string;

  afterEach(() => {
    try { rmSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
  });

  it('emits a jinn.state_transition span on normal exit when trajectory is provided', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'pred-traj-'));
    const { child, emitExit } = makeFakeChild();
    const spawnFn: SpawnFn = vi.fn().mockReturnValue(child);

    const collector = new TrajectoryCollector({ taskCid: 'bafy-pred', runId: 'run-pred-1' });

    setImmediate(() => emitExit(0));

    const deps = makeDeps(tmpDir, { _spawnFn: spawnFn, trajectory: collector });
    await spawnSession('pred-session-1', 'predict prompt', deps);

    const { spans } = collector.snapshot();
    expect(spans).toHaveLength(1);
    const span = spans[0];
    expect(span.attributes['jinn.span.kind']).toBe('jinn.state_transition');
    expect(span.attributes['jinn.state.from']).toBe('PREPARED');
    expect(span.attributes['jinn.state.to']).toBe('RAN_CLAUDE');
    expect(span.attributes['subprocess.cmd']).toBe('claude');
    expect(span.attributes['subprocess.exit_code']).toBe(0);
    expect(span.attributes['session.id']).toBe('pred-session-1');
    expect(span.status.code).toBe('OK');
  });

  it('emits an ERROR span for non-zero exit', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'pred-traj-'));
    const { child, emitExit } = makeFakeChild();
    const spawnFn: SpawnFn = vi.fn().mockReturnValue(child);

    const collector = new TrajectoryCollector({ taskCid: 'bafy-pred', runId: 'run-pred-2' });

    setImmediate(() => emitExit(2));

    const deps = makeDeps(tmpDir, { _spawnFn: spawnFn, trajectory: collector });
    await spawnSession('pred-session-2', 'predict prompt', deps);

    const { spans } = collector.snapshot();
    expect(spans[0].status.code).toBe('ERROR');
    expect(spans[0].attributes['subprocess.exit_code']).toBe(2);
  });

  it('emits an ERROR span with exception event on spawn error', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'pred-traj-'));
    const { child, emitError } = makeFakeChild();
    const spawnFn: SpawnFn = vi.fn().mockReturnValue(child);

    const collector = new TrajectoryCollector({ taskCid: 'bafy-pred', runId: 'run-pred-3' });

    setImmediate(() => emitError(new Error('ENOENT: claude not found')));

    const deps = makeDeps(tmpDir, { _spawnFn: spawnFn, trajectory: collector });
    await spawnSession('pred-session-err', 'predict prompt', deps);

    const { spans } = collector.snapshot();
    expect(spans).toHaveLength(1);
    expect(spans[0].status.code).toBe('ERROR');
    expect(spans[0].events[0].name).toBe('exception');
    expect(spans[0].events[0].attributes?.['exception.message']).toContain('ENOENT');
  });

  it('includes prediction.submitted attribute on the span', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'pred-traj-'));
    const { child, emitExit } = makeFakeChild();
    const spawnFn: SpawnFn = vi.fn().mockReturnValue(child);

    const collector = new TrajectoryCollector({ taskCid: 'bafy-pred', runId: 'run-pred-4' });

    setImmediate(() => emitExit(0));

    const deps = makeDeps(tmpDir, {
      _spawnFn: spawnFn,
      trajectory: collector,
      isSubmitted: () => true,
    });
    await spawnSession('pred-session-submitted', 'predict prompt', deps);

    const { spans } = collector.snapshot();
    expect(spans[0].attributes['prediction.submitted']).toBe(true);
  });

  it('does not throw when no trajectory collector is provided', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'pred-traj-'));
    const { child, emitExit } = makeFakeChild();
    const spawnFn: SpawnFn = vi.fn().mockReturnValue(child);

    setImmediate(() => emitExit(0));

    const deps = makeDeps(tmpDir, { _spawnFn: spawnFn });
    await expect(spawnSession('no-traj', 'predict prompt', deps)).resolves.toBeDefined();
  });
});
