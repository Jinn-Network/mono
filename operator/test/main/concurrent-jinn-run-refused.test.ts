/**
 * Integration regression for #649 — a second `jinn run` invocation that races
 * against an already-running daemon must refuse cleanly: no pidfile clobber,
 * no spurious `startup` activity row, no `daemon_started_at` rewrite.
 *
 * In-process pattern (mirrors `restart-daemon-cleanup-frees-ports.test.ts`): we
 * don't fork a second node process; we exercise the gate against a real Daemon
 * on port 0 inside one vitest worker, asserting the side-effect surface the
 * operator dashboard cares about.
 *
 * Three cases:
 *   1. Classifier-under-Daemon: `checkPidfileLiveness` returns `refuse` and
 *      no shared state changes (side-effect-free sanity check).
 *   2. main.ts wire-in: `applyPidfileLivenessGate` + the subsequent
 *      writeFileSync, with `process.exit` spied to throw. Proves the gate's
 *      `emitEnvelope → process.exit` halts control flow *before* the pidfile
 *      write line runs.
 *   3. Stale-pidfile (ESRCH): classifier returns `unlink-stale` so the caller
 *      can clean up and proceed.
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
import {
  applyPidfileLivenessGate,
  checkPidfileLiveness,
} from '../../src/preflight/pidfile-liveness.js';
import {
  __setExecSyncForTesting,
  __resetExecSyncForTesting,
} from '../../src/lifecycle/process-discovery.js';

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
  // A genuinely-live *sibling* daemon's PID — distinct from our own and from
  // PID 1, so it stays on the refuse path after #805 reclaims self/PID-1. We
  // spy `process.kill` to report it alive (the unit-test idiom), since writing
  // `process.pid` here would now self-reclaim rather than refuse.
  const siblingPid = 987654;
  let killSpy: ReturnType<typeof vi.spyOn> | undefined;

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
    // First (sibling) daemon writes its own pidfile, exactly like main.ts does
    // at operator/src/main.ts:2578. We record a distinct sibling PID and spy
    // `process.kill` to report it alive, so the gate sees a live *other* daemon.
    writeFileSync(pidPath, `${siblingPid}\n`, 'utf-8');
    killSpy = vi.spyOn(process, 'kill').mockImplementation((pid, sig) => {
      if (pid === siblingPid && sig === 0) {
        return true as never;
      }
      const err = new Error('ESRCH') as NodeJS.ErrnoException;
      err.code = 'ESRCH';
      throw err;
    });
    // #805: the sibling is a genuine jinn daemon — pin the cmdline probe so
    // the refuse-path tests below aren't at the mercy of real `ps` output.
    __setExecSyncForTesting(() => 'node /opt/jinn/dist/bin/jinn.js run\n');
  });

  afterEach(async () => {
    killSpy?.mockRestore();
    killSpy = undefined;
    __resetExecSyncForTesting();
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
      expect(decision.pid).toBe(siblingPid);
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

  it('main.ts wire-in halts before writeFileSync on refuse, leaving store + pidfile untouched', () => {
    // This mirrors the three-line wire-in at operator/src/main.ts (the
    // `applyPidfileLivenessGate(pidPath); writeFileSyncMain(pidPath, ...)`
    // sequence). The pure classifier already proves the *decision*; this
    // test proves the *wire-in itself* — that `process.exit` (inside
    // `emitEnvelope`) halts control flow before the pidfile write runs.

    const startedAtBefore = store.getDaemonStartedAt();
    const startupCountBefore = store.getActivityCountsByKind()['startup'] ?? 0;
    const pidfileBefore = readFileSync(pidPath, 'utf-8');

    // Spy on process.exit: throw so control halts immediately, mirroring how
    // the real process.exit terminates the event loop.
    class ExitInvoked extends Error {
      constructor(public readonly code: number) {
        super(`process.exit(${code})`);
      }
    }
    const exitCalls: Array<number | undefined> = [];
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation(((code?: number) => {
        exitCalls.push(code);
        throw new ExitInvoked(typeof code === 'number' ? code : 0);
      }) as never);
    // Route the wire-in's writeFileSync through a counter (ESM exports are
    // read-only bindings, so `vi.spyOn(fs, 'writeFileSync')` is rejected by
    // Node). The wire-in below calls *this* wrapper, so the assertion is
    // equivalent in intent: did the write line execute, or did process.exit
    // halt control flow first.
    let writeCalls = 0;
    const writeProbe = {
      writeFileSync: (...args: Parameters<typeof writeFileSync>) => {
        writeCalls += 1;
        return writeFileSync(...args);
      },
    };

    let thrown: unknown = null;
    try {
      // === replicated main.ts wire-in (see operator/src/main.ts) ===
      applyPidfileLivenessGate(pidPath);
      // emitEnvelope inside the gate calls process.exit on `refuse`; the spy
      // throws so this line MUST NOT execute on the refuse path.
      writeProbe.writeFileSync(pidPath, `${process.pid}\n`, 'utf-8');
      // === end wire-in ===
    } catch (err) {
      thrown = err;
    } finally {
      exitSpy.mockRestore();
    }

    // The gate refused, so process.exit was invoked (and the spy threw).
    expect(thrown).toBeInstanceOf(ExitInvoked);
    expect((thrown as ExitInvoked).code).toBeGreaterThan(0);
    expect(exitCalls).toHaveLength(1);
    expect(typeof exitCalls[0]).toBe('number');

    // The wire-in's writeFileSync MUST NOT have been called.
    expect(writeCalls).toBe(0);

    // Shared state is untouched.
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

  it('reclaims (does not refuse) when the sibling pid is alive but not a jinn daemon — #805 recycled-pid case', () => {
    __setExecSyncForTesting(() => 'python train.py\n');
    const decision = checkPidfileLiveness({ pidPath });
    expect(decision.decision).toBe('unlink-stale');
    if (decision.decision === 'unlink-stale') {
      expect(decision.pid).toBe(siblingPid);
      expect(decision.reason).toBe('not-jinn');
    }
  });
});
