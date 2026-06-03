import { describe, it, expect, afterEach } from 'vitest';
import { setupTier3Scenario, type Tier3Handle, isDailyDriverRunning, tierOpNames } from './tier-3-helpers.js';

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

describe('isDailyDriverRunning', () => {
  it('returns false when nothing is on the daily-driver ports', async () => {
    const running = await isDailyDriverRunning({ ports: [60001, 60002] });
    expect(running).toBe(false);
  });

  it('returns true when something is on a daily-driver port', async () => {
    const net = await import('node:net');
    const srv = net.createServer();
    await new Promise<void>((resolve) => srv.listen(60003, resolve));
    try {
      const running = await isDailyDriverRunning({ ports: [60003] });
      expect(running).toBe(true);
    } finally {
      await new Promise<void>((resolve) => srv.close(() => resolve()));
    }
  });
});

describe('setupTier3Scenario', () => {
  it('refuses to run when daily driver is up and mode is autonomous', async () => {
    const net = await import('node:net');
    const srv = net.createServer();
    await new Promise<void>((resolve) => srv.listen(60004, resolve));
    try {
      await expect(
        setupTier3Scenario({
          scenarioId: 'T3.X-test',
          mode: 'autonomous',
          dailyDriverPorts: [60004],
        }),
      ).rejects.toThrow(/daily driver/i);
    } finally {
      await new Promise<void>((resolve) => srv.close(() => resolve()));
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
