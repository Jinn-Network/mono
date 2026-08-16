/**
 * Integration regression for #561 — the operator-dashboard Restart button must
 * release port-bound listeners BEFORE the detached child re-execs, otherwise
 * the child crashes binding port 7332 (or OTLP 4317/4318) with EADDRINUSE and
 * the panel goes 502 with no respawn.
 *
 * The unit-level coverage in `restart-daemon-respawn.test.ts` proves that the
 * `preSpawnCleanup` hook is awaited before `spawnFn` runs. This test goes one
 * level deeper: it stands up a REAL `startApiServer` and a REAL `startReceiver`
 * on ephemeral ports, builds the exact same closure shape main.ts wires into
 * `onRestartRequested`, then asserts that after `requestDaemonRestart` has
 * scheduled the spawn the ports are actually free — i.e. another process
 * could re-bind them without EADDRINUSE.
 *
 * What we don't (and can't) verify in a unit-shaped test:
 *   - That the *detached* node child actually re-binds the ports successfully
 *     after the parent vacates. That requires a real fork-and-bind, which is
 *     covered by the operator running `jinn run` end-to-end.
 *
 * What we DO verify:
 *   - The API server listener is gone (a fresh listener can bind the same port).
 *   - The OTLP HTTP receiver is gone (same).
 *   - The OTLP gRPC receiver is gone (same).
 *   - The `harnessReadinessRegistry.stop()` ref is invoked when present, and
 *     skipped without throwing when the holder is empty (pre-bootstrap restart).
 *   - `spawnFn` only fires AFTER all of the above are released.
 *
 * Run-mode: `fix` (issue #561). Skill chain: systematic-debugging →
 * executing-plans → verification-before-completion. This test is Stage 7
 * substitute for the chrome-devtools manual walk (see `testing-jinn-app`
 * skill's caveat that restart tests must NOT use `--no-ui`).
 */

import { createServer, type Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { startApiServer, type ApiServer } from '../../src/api/server.js';
import { Store } from '../../src/store/store.js';
import { requestDaemonRestart } from '../../src/restart-daemon.js';
import { startReceiver, type Receiver } from '../../src/trajectory/receiver.js';

/**
 * Attempt to bind a fresh TCP listener on `port` on 127.0.0.1. Resolves when
 * the bind succeeds, rejects if anything goes wrong (most commonly EADDRINUSE
 * if the port is still held by the previous listener).
 */
function tryBind(port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(port, '127.0.0.1', () => resolve(probe));
  });
}

async function closeBind(srv: Server): Promise<void> {
  await new Promise<void>((res) => srv.close(() => res()));
}

function makeFakeChild() {
  return { unref: vi.fn() };
}

describe('#561 — preSpawnCleanup actually frees the ports', () => {
  let store: Store;
  let apiServer: ApiServer;
  let receiver: Receiver | undefined;

  beforeEach(async () => {
    store = new Store(':memory:');
    apiServer = await startApiServer({
      port: 0, // OS picks an ephemeral port
      store,
      apiToken: 'cleanup-int-test',
    });
    receiver = await startReceiver({
      grpcPort: 0,
      httpPort: 0,
      processors: [],
    });
  });

  afterEach(async () => {
    // Defensive teardown — the test body normally already released both.
    await apiServer?.close().catch(() => undefined);
    await receiver?.shutdown().catch(() => undefined);
    store?.close();
  });

  it('releases the API port + OTLP gRPC + OTLP HTTP ports before spawnFn fires', async () => {
    const apiPort = apiServer.port;
    const grpcPort = receiver!.grpcPort;
    const httpPort = receiver!.httpPort;

    // Sanity: ports are bound right now — a fresh listener should refuse.
    await expect(tryBind(apiPort)).rejects.toMatchObject({ code: 'EADDRINUSE' });
    await expect(tryBind(httpPort)).rejects.toMatchObject({ code: 'EADDRINUSE' });
    // gRPC binds via @grpc/grpc-js which uses the same TCP layer — same check applies.
    await expect(tryBind(grpcPort)).rejects.toMatchObject({ code: 'EADDRINUSE' });

    // Build the EXACT closure shape main.ts uses (operator/src/main.ts:1017–1021).
    // harness readiness holder is undefined (pre-bootstrap restart) → the
    // optional-chained call should be a no-op without throwing.
    const harnessReadinessRegistryHolder: { current: { stop: () => void } | undefined } = {
      current: undefined,
    };
    const closeCaptureReceiver = async () => {
      const r = receiver;
      receiver = undefined;
      await r?.shutdown().catch(() => undefined);
    };
    const preSpawnCleanup = async () => {
      harnessReadinessRegistryHolder.current?.stop();
      await apiServer.close().catch(() => undefined);
      await closeCaptureReceiver();
    };

    const fakeChild = makeFakeChild();
    let spawnedAt = -1;
    let cleanupResolvedAt = -1;
    let counter = 0;
    const spawnFn = vi.fn(() => {
      spawnedAt = ++counter;
      return fakeChild as never;
    });

    // Wrap preSpawnCleanup so we can prove cleanup resolved before spawn.
    const observed = async () => {
      await preSpawnCleanup();
      cleanupResolvedAt = ++counter;
    };

    const result = await requestDaemonRestart({
      env: {},
      argv: ['/usr/bin/node', '/main.js'],
      execPath: '/usr/bin/node',
      spawnFn: spawnFn as unknown as typeof import('node:child_process').spawn,
      exitFn: vi.fn(),
      log: vi.fn(),
      exitDelayMs: 0,
      preSpawnCleanup: observed,
    });

    expect(result).toBe('respawned');

    // Drain microtasks — the helper schedules cleanup → spawn via promise chain.
    for (let i = 0; i < 16; i++) {
      await new Promise((r) => setImmediate(r));
    }

    expect(cleanupResolvedAt).toBe(1);
    expect(spawnedAt).toBe(2);
    expect(spawnFn).toHaveBeenCalledTimes(1);

    // The real proof: every port we held before cleanup is now bindable. If
    // any of these throw EADDRINUSE the fix is broken and the child would
    // crash on respawn.
    const probeApi = await tryBind(apiPort);
    const probeHttp = await tryBind(httpPort);
    const probeGrpc = await tryBind(grpcPort);
    await closeBind(probeApi);
    await closeBind(probeHttp);
    await closeBind(probeGrpc);
  });

  it('invokes harnessReadinessRegistry.stop() when the holder is populated', async () => {
    const stop = vi.fn();
    const harnessReadinessRegistryHolder: { current: { stop: () => void } | undefined } = {
      current: { stop },
    };
    const closeCaptureReceiver = async () => {
      const r = receiver;
      receiver = undefined;
      await r?.shutdown().catch(() => undefined);
    };
    const preSpawnCleanup = async () => {
      harnessReadinessRegistryHolder.current?.stop();
      await apiServer.close().catch(() => undefined);
      await closeCaptureReceiver();
    };

    const spawnFn = vi.fn(() => makeFakeChild() as never);

    requestDaemonRestart({
      env: {},
      argv: ['/usr/bin/node', '/main.js'],
      execPath: '/usr/bin/node',
      spawnFn: spawnFn as unknown as typeof import('node:child_process').spawn,
      exitFn: vi.fn(),
      log: vi.fn(),
      exitDelayMs: 0,
      preSpawnCleanup,
    });

    for (let i = 0; i < 8; i++) {
      await new Promise((r) => setImmediate(r));
    }

    expect(stop).toHaveBeenCalledTimes(1);
    expect(spawnFn).toHaveBeenCalledTimes(1);
  });

  it('still spawns when the API server close throws (cleanup is non-blocking)', async () => {
    // Stub close to reject — per the helper contract, a stuck cleanup must
    // not block the restart (a logged warning is worse than a hung daemon).
    const closeSpy = vi.spyOn(apiServer, 'close').mockRejectedValue(new Error('close stuck'));

    const preSpawnCleanup = async () => {
      await apiServer.close(); // throws — caught inside requestDaemonRestart
    };

    const spawnFn = vi.fn(() => makeFakeChild() as never);
    const log = vi.fn();

    requestDaemonRestart({
      env: {},
      argv: ['/usr/bin/node', '/main.js'],
      execPath: '/usr/bin/node',
      spawnFn: spawnFn as unknown as typeof import('node:child_process').spawn,
      exitFn: vi.fn(),
      log,
      exitDelayMs: 0,
      preSpawnCleanup,
    });

    for (let i = 0; i < 8; i++) {
      await new Promise((r) => setImmediate(r));
    }

    expect(closeSpy).toHaveBeenCalled();
    expect(spawnFn).toHaveBeenCalledTimes(1);
    expect(log.mock.calls.map((c) => c[0]).join('\n')).toMatch(/preSpawnCleanup failed|close stuck/);
    // Restore close so afterEach can clean up properly.
    closeSpy.mockRestore();
    await apiServer.close().catch(() => undefined);
  });
});
