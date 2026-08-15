/**
 * Regression test for the #778 follow-up — the Hermes harness's `isReady()`
 * shelled out to `hermes doctor` AND `hermes auth list openrouter` via
 * `spawnSync` on every readiness-registry refresh tick (~250ms). Live
 * observation on a wedged daemon: ~2 sync spawns/sec keeping ~99% of main-
 * thread sample time in `node::SyncProcessRunner::Spawn`. Same wedge class
 * as the harvest/restoration-patch fix in #778 — that one was the post-
 * execution `git diff` path; this one is the readiness path that #398's
 * canAcceptTask O(1) cache deliberately avoided.
 *
 * Acceptance check: while the underlying `execFile` is in flight (here
 * mocked to never resolve), a concurrent `setTimeout` callback MUST still
 * fire. The sync version of the code blocked the timer; the async version
 * leaves the event loop free.
 *
 * Companion: `probeCodexDoctor` had the same wedge shape (called from the
 * learner harness's `codexIsReady`) and is exercised in the same shape
 * below.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { vi } from 'vitest';

// MOCK_JUSTIFICATION: child_process is a leaf syscall; we cannot DI it
// without owning a shim. We need to inject a never-resolving execFile to
// reproduce the wedge condition deterministically. The production code goes
// through `promisify(execFile)`, so we mock the callback-style execFile and
// re-attach the `util.promisify.custom` impl so `promisify(execFile)`
// resolves with `{stdout, stderr}` the way the real node:child_process does.
// The point of THIS regression test is to assert the event loop keeps
// ticking WHILE the underlying promise is unresolved, so the mock simply
// never invokes the captured callback.
const { slowExecFileCalls, pendingResolvers } = vi.hoisted(() => ({
  slowExecFileCalls: [] as { command: string; args: readonly string[] }[],
  pendingResolvers: [] as Array<() => void>,
}));

vi.mock('node:child_process', async () => {
  const { promisify: promisifyImpl } = await import('node:util');

  function mockedExecFile(
    command: string,
    args: readonly string[],
    ..._rest: unknown[]
  ): unknown {
    slowExecFileCalls.push({ command, args });
    const callback = _rest.find((arg) => typeof arg === 'function') as
      | ((err: Error | null, stdout: string, stderr: string) => void)
      | undefined;
    // Capture the callback rather than firing it — the test drains the queue
    // on teardown. The promisify wrapper will hang on `await` until we call
    // this. THAT is the wedge condition we want to assert is non-blocking.
    if (callback) {
      pendingResolvers.push(() => callback(null, '', ''));
    }
    return { stdin: null, kill: () => {} };
  }

  (mockedExecFile as unknown as { [k: symbol]: unknown })[promisifyImpl.custom] = (
    file: string,
    args: readonly string[],
    options?: Record<string, unknown>,
  ): Promise<{ stdout: string; stderr: string }> =>
    new Promise((resolve, reject) => {
      mockedExecFile(file, args, options ?? {}, (err: Error | null, stdout: string, stderr: string) => {
        if (err) reject(err);
        else resolve({ stdout, stderr });
      });
    });

  return { execFile: mockedExecFile };
});

// Import AFTER the mock is registered.
const { probeHermesDoctor, probeHermesAuthStatus } = await import(
  '../../src/api/hermes-doctor-endpoint.js'
);
const { probeCodexDoctor } = await import('../../src/api/codex-doctor-endpoint.js');

describe('probeHermesDoctor — async wedge regression (#778 follow-up)', () => {
  beforeEach(() => {
    slowExecFileCalls.length = 0;
    pendingResolvers.length = 0;
  });

  it('does not block the event loop while `hermes doctor` is in flight', async () => {
    const probePromise = probeHermesDoctor({});

    // Race the probe against a 100ms tick. With the OLD sync code the entire
    // main thread is blocked in `spawnSync` until hermes returns; the
    // setTimeout cannot fire. With the async fix the timer drains while
    // execFile is still in flight, so this Promise resolves first.
    const eventLoopTicked = await Promise.race([
      new Promise<'tick'>((resolve) => setTimeout(() => resolve('tick'), 100)),
      probePromise.then(() => 'probe-done' as const).catch(() => 'probe-done' as const),
    ]);

    expect(eventLoopTicked).toBe('tick');
    expect(slowExecFileCalls.length).toBeGreaterThan(0);
    expect(slowExecFileCalls[0]?.args).toEqual(['doctor']);

    // Drain the probe so vitest doesn't see a dangling Promise.
    for (const resolve of pendingResolvers.splice(0)) resolve();
    await probePromise.catch(() => undefined);
  });
});

describe('probeHermesAuthStatus — async wedge regression (#778 follow-up)', () => {
  beforeEach(() => {
    slowExecFileCalls.length = 0;
    pendingResolvers.length = 0;
  });

  it('does not block the event loop while `hermes auth list <provider>` is in flight', async () => {
    const probePromise = probeHermesAuthStatus('openrouter');

    const eventLoopTicked = await Promise.race([
      new Promise<'tick'>((resolve) => setTimeout(() => resolve('tick'), 100)),
      probePromise.then(() => 'probe-done' as const).catch(() => 'probe-done' as const),
    ]);

    expect(eventLoopTicked).toBe('tick');
    expect(slowExecFileCalls.length).toBeGreaterThan(0);
    expect(slowExecFileCalls[0]?.args).toEqual(['auth', 'list', 'openrouter']);

    for (const resolve of pendingResolvers.splice(0)) resolve();
    await probePromise.catch(() => undefined);
  });
});

describe('probeCodexDoctor — async wedge regression (#778 follow-up)', () => {
  beforeEach(() => {
    slowExecFileCalls.length = 0;
    pendingResolvers.length = 0;
  });

  it('does not block the event loop while `codex --version` is in flight', async () => {
    // Pass empty env + a readAuthFile override so the probe doesn't touch the
    // real filesystem or env — the only blocking op under test is execFile.
    const probePromise = probeCodexDoctor({
      env: {},
      readAuthFile: () => undefined,
    });

    const eventLoopTicked = await Promise.race([
      new Promise<'tick'>((resolve) => setTimeout(() => resolve('tick'), 100)),
      probePromise.then(() => 'probe-done' as const).catch(() => 'probe-done' as const),
    ]);

    expect(eventLoopTicked).toBe('tick');
    expect(slowExecFileCalls.length).toBeGreaterThan(0);
    expect(slowExecFileCalls[0]?.args).toEqual(['--version']);

    for (const resolve of pendingResolvers.splice(0)) resolve();
    await probePromise.catch(() => undefined);
  });
});
