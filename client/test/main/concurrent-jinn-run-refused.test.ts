/**
 * Integration regression for #649 — a second `jinn run` invocation that races
 * against an already-running daemon must refuse cleanly: no pidfile clobber,
 * no spurious `startup` activity row, no `daemon_started_at` rewrite.
 *
 * In-process pattern (mirrors `restart-daemon-cleanup-frees-ports.test.ts`): we
 * don't fork a second node process; we exercise the liveness helper against a
 * real Daemon on port 0 inside one vitest worker, asserting the side-effect
 * surface the operator dashboard cares about.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Daemon, type DaemonConfig } from '../../src/daemon/daemon.js';
import { LocalAdapter } from '../../src/adapters/local/adapter.js';
import { SimpleRunner } from '../../src/runner/simple.js';
import { HarnessRegistry } from '../../src/harnesses/engine/registry.js';
import { Store } from '../../src/store/store.js';
import { checkPidfileLiveness } from '../../src/preflight/pidfile-liveness.js';

function minimalEngineConfig(root: string): DaemonConfig['restorationEngine'] {
  const implRegistry = new HarnessRegistry({ default: 'legacy-claude' });
  return {
    implRegistry,
    paths: {
      workingDirRoot: join(root, 'work'),
      implStateDirRoot: join(root, 'impl-state'),
    },
  };
}

describe('#649 — second jinn run refuses without corrupting state', () => {
  let tmp: string;
  let pidPath: string;
  let store: Store;
  let daemon: Daemon;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'jinn-649-'));
    pidPath = join(tmp, 'daemon.pid');
    store = new Store(':memory:');
    daemon = new Daemon({
      adapter: new LocalAdapter(),
      runner: new SimpleRunner(async (desc) => `Done: ${desc}`),
      store,
      dbPath: ':memory:',
      apiPort: 0, // OS picks
      pollIntervalMs: 60_000,
      taskSources: [],
      restorationEngine: minimalEngineConfig(tmp),
    });
    await daemon.start();
    // First daemon writes its own pidfile, exactly like main.ts does at
    // client/src/main.ts:2578.
    writeFileSync(pidPath, `${process.pid}\n`, 'utf-8');
  });

  afterEach(async () => {
    await daemon.stop().catch(() => undefined);
    rmSync(tmp, { recursive: true, force: true });
  });

  it('refuses when the recorded PID is alive, and leaves shared state alone', () => {
    const startedAtBefore = store.getDaemonStartedAt();
    const startupCountBefore = store.getActivityCountsByKind()['startup'] ?? 0;
    const pidfileBefore = readFileSync(pidPath, 'utf-8');

    const decision = checkPidfileLiveness({ pidPath });

    expect(decision.decision).toBe('refuse');
    if (decision.decision === 'refuse') {
      expect(decision.pid).toBe(process.pid);
      expect(decision.reason).toBe('alive');
    }

    // The simulated second invocation MUST NOT have:
    //  - touched the pidfile,
    //  - bumped daemon_started_at,
    //  - written a second `startup` activity row.
    expect(readFileSync(pidPath, 'utf-8')).toBe(pidfileBefore);
    expect(store.getDaemonStartedAt()).toBe(startedAtBefore);
    expect(store.getActivityCountsByKind()['startup'] ?? 0).toBe(startupCountBefore);
  });

  it('reports a stale pidfile (ESRCH) so the caller can unlink and proceed', () => {
    // PID 1 is guaranteed-alive on every POSIX, so use an unallocatable PID.
    // Node coerces 0 to "current process group" on kill — use a fake high PID
    // that we can't possibly have allocated, then spy on process.kill to throw
    // ESRCH for that specific PID without touching real signals.
    const fakeStalePid = 2147483646; // INT32_MAX - 1
    writeFileSync(pidPath, `${fakeStalePid}\n`, 'utf-8');
    const killSpy = vi.spyOn(process, 'kill').mockImplementation((pid, sig) => {
      if (pid === fakeStalePid && sig === 0) {
        const err = new Error('ESRCH') as NodeJS.ErrnoException;
        err.code = 'ESRCH';
        throw err;
      }
      return true as never;
    });
    try {
      const decision = checkPidfileLiveness({ pidPath });
      expect(decision.decision).toBe('unlink-stale');
      if (decision.decision === 'unlink-stale') {
        expect(decision.pid).toBe(fakeStalePid);
        expect(decision.reason).toBe('esrch');
      }
    } finally {
      killSpy.mockRestore();
    }
  });
});
