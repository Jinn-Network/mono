import { describe, it, expect, afterEach, vi } from 'vitest';
import { setupTier3Scenario, type Tier3Handle, isDailyDriverRunning, tierOpNames, waitForHarnessReady } from './tier-3-helpers.js';

describe('tierOpNames', () => {
  const saved = { p: process.env['JINN_TIER_PRODUCER_OP'], s: process.env['JINN_TIER_SOLVER_OP'] };
  afterEach(() => {
    if (saved.p === undefined) delete process.env['JINN_TIER_PRODUCER_OP']; else process.env['JINN_TIER_PRODUCER_OP'] = saved.p;
    if (saved.s === undefined) delete process.env['JINN_TIER_SOLVER_OP']; else process.env['JINN_TIER_SOLVER_OP'] = saved.s;
  });

  it('defaults to op-a (producer) / op-b (solver)', () => {
    delete process.env['JINN_TIER_PRODUCER_OP'];
    delete process.env['JINN_TIER_SOLVER_OP'];
    expect(tierOpNames()).toEqual({ producer: 'op-a', solver: 'op-b' });
  });

  it('honors env overrides (env suite runs op-c, never the live op-a)', () => {
    process.env['JINN_TIER_PRODUCER_OP'] = 'op-c';
    process.env['JINN_TIER_SOLVER_OP'] = 'op-b';
    expect(tierOpNames()).toEqual({ producer: 'op-c', solver: 'op-b' });
  });

  it('treats blank/whitespace env as unset (falls back to defaults)', () => {
    process.env['JINN_TIER_PRODUCER_OP'] = '   ';
    process.env['JINN_TIER_SOLVER_OP'] = '';
    expect(tierOpNames()).toEqual({ producer: 'op-a', solver: 'op-b' });
  });
});

/**
 * Bind 127.0.0.1 on a KERNEL-ASSIGNED port and hold it until `close()`.
 *
 * `listen(0)` assigns and holds atomically, so — unlike a hard-coded port, or
 * an allocate-then-rebind helper — there is no window in which a sibling
 * vitest worker can take the port out from under this test. Vitest runs ~850
 * files across 3 forked workers on CI and they share one kernel-global
 * 127.0.0.1 port space. Issue #1627.
 *
 * Kept local to this file: two call sites, one file.
 */
async function listenOnFreePort(): Promise<{ port: number; close: () => Promise<void> }> {
  const net = await import('node:net');
  const srv = net.createServer();
  const port = await new Promise<number>((resolve, reject) => {
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (!addr || typeof addr === 'string') {
        srv.close();
        reject(new Error('could not resolve the kernel-assigned port'));
        return;
      }
      resolve(addr.port);
    });
  });
  return { port, close: () => new Promise<void>((resolve) => srv.close(() => resolve())) };
}

describe('isDailyDriverRunning', () => {
  it('returns false when nothing is on the daily-driver ports', async () => {
    // This assertion IS "nothing is listening", so the test cannot bind the
    // ports itself — they have to be fixed. 9331/9332 are below 32768, and so
    // below both the Linux ephemeral range (32768–60999) and the macOS one
    // (49152–65535): no sibling worker's `listen(0)` can ever be handed them,
    // and nothing in this repo binds them. Issue #1627.
    const running = await isDailyDriverRunning({ ports: [9331, 9332] });
    expect(running).toBe(false);
  });

  it('returns true when something is on a daily-driver port', async () => {
    const srv = await listenOnFreePort();
    try {
      const running = await isDailyDriverRunning({ ports: [srv.port] });
      expect(running).toBe(true);
    } finally {
      await srv.close();
    }
  });
});

describe('waitForHarnessReady', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fails fast with the evaluator readiness reason and next step', async () => {
    const fetchSpy = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.headers).toMatchObject({ 'x-jinn-ui-token': 'ui-secret' });
      return new Response(JSON.stringify({
        harnessName: 'swe-rebench-v2-evaluator',
        manifestCids: ['bafkrei-t3'],
        ready: false,
        reason: 'swe-rebench-v2 evaluator not enabled',
        nextStep: { cli: 'jinn harnesses enable swe-rebench-v2-evaluator' },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchSpy);

    await expect(waitForHarnessReady({
      opName: 'op-a',
      apiPort: 7360,
      harnessName: 'swe-rebench-v2-evaluator',
      uiToken: 'ui-secret',
      timeoutMs: 50,
      intervalMs: 1,
    })).rejects.toThrow(
      /Tier 3 evaluator harness readiness infra-blocked on op-a: swe-rebench-v2 evaluator not enabled.*jinn harnesses enable swe-rebench-v2-evaluator/,
    );
  });
});

describe('setupTier3Scenario', () => {
  it('refuses to run when daily driver is up and mode is autonomous', async () => {
    const srv = await listenOnFreePort();
    try {
      await expect(
        setupTier3Scenario({
          scenarioId: 'T3.X-test',
          mode: 'autonomous',
          dailyDriverPorts: [srv.port],
        }),
      ).rejects.toThrow(/daily driver/i);
    } finally {
      await srv.close();
    }
  });

  it('uses gold paths directly (no workspace copy)', async () => {
    // Skip if substrate not present
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const os = await import('node:os');
    const goldOpA = path.join(os.homedir(), 'jinn-dev', 'operators', 'op-a');
    try { await fs.access(goldOpA); } catch { return; }

    // We don't actually want to spawn daemons in this unit test (that would
    // require mutex'ing the real daily driver). Just assert that the helper's
    // resolveGoldPath function returns the gold dir.
    const { resolveGoldDaemonHome } = await import('./tier-3-helpers');
    const home = resolveGoldDaemonHome('op-a');
    expect(home).toBe(goldOpA);
  });
});
