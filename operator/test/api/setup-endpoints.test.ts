import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addSetupRoutes } from '../../src/api/setup-endpoints.js';
import { stage1MinMasterEth } from '../../src/earning/bootstrap.js';
import { getChainConfig } from '../../src/earning/contracts.js';
import { FleetStateStore } from '../../src/earning/store.js';
import { encryptMnemonic, generateMnemonic } from '../../src/earning/wallet.js';

describe('GET /v1/auth/claude', () => {
  it('returns binary status and skips auth probe when claude is missing', async () => {
    const app = new Hono();
    const probeClaudeAuth = vi.fn();
    addSetupRoutes(app, {
      claudePath: '/missing/claude',
      checkClaudeBinary: async () => ({
        ok: false,
        detail: 'claude binary not found',
      }),
      probeClaudeAuth,
    });
    const res = await app.request('/v1/auth/claude');
    expect(res.status).toBe(200);
    const body = await res.json() as {
      authenticated: boolean;
      context: string;
      binary: { ok: boolean; detail: string };
    };
    expect(body.authenticated).toBe(false);
    expect(typeof body.context).toBe('string');
    expect(body.binary.ok).toBe(false);
    expect(probeClaudeAuth).not.toHaveBeenCalled();
  });

  it('probes auth through the configured claude path when binary is present', async () => {
    const app = new Hono();
    const probeClaudeAuth = vi.fn(() => ({
      authenticated: true,
      context: 'bare' as const,
      detail: 'logged in',
      email: 'operator@example.com',
    }));
    addSetupRoutes(app, {
      claudePath: '/custom/claude',
      checkClaudeBinary: async (claudePath: string) => ({
        ok: true,
        detail: `${claudePath} is executable`,
        resolvedPath: claudePath,
      }),
      probeClaudeAuth,
    });
    const res = await app.request('/v1/auth/claude');
    expect(res.status).toBe(200);
    const body = await res.json() as {
      authenticated: boolean;
      email?: string;
      binary: { ok: boolean; resolvedPath?: string };
    };
    expect(body.authenticated).toBe(true);
    expect(body.email).toBe('operator@example.com');
    expect(body.binary.resolvedPath).toBe('/custom/claude');
    expect(probeClaudeAuth).toHaveBeenCalledWith(expect.objectContaining({
      claudePath: '/custom/claude',
    }));
  });
});

describe('POST /v1/setup/claude/install', () => {
  it('returns already_present when configured claude works', async () => {
    const app = new Hono();
    const execFileAsync = vi.fn();
    const persistConfigValue = vi.fn();
    addSetupRoutes(app, {
      claudePath: '/custom/claude',
      checkClaudeBinary: async (claudePath: string) => ({
        ok: true,
        detail: `${claudePath} is executable`,
        resolvedPath: claudePath,
      }),
      execFileAsync,
      persistConfigValue,
    });

    const res = await app.request('/v1/setup/claude/install', { method: 'POST' });

    expect(res.status).toBe(202);
    const body = await res.json() as { ok: boolean; status: string };
    expect(body.ok).toBe(true);
    expect(body.status).toBe('already_present');
    expect(execFileAsync).not.toHaveBeenCalled();
    expect(persistConfigValue).not.toHaveBeenCalled();
  });

  it('reuses global claude on PATH when configured path is broken', async () => {
    const app = new Hono();
    const selected: string[] = [];
    const persistConfigValue = vi.fn();
    addSetupRoutes(app, {
      claudePath: '/broken/claude',
      checkClaudeBinary: async (claudePath: string) => claudePath === 'claude'
        ? { ok: true, detail: 'global claude is executable', resolvedPath: '/usr/local/bin/claude' }
        : { ok: false, detail: 'configured claude missing' },
      persistConfigValue,
      onClaudePathSelected: (claudePath) => selected.push(claudePath),
    });

    const res = await app.request('/v1/setup/claude/install', { method: 'POST' });

    expect(res.status).toBe(202);
    const body = await res.json() as { ok: boolean; status: string; binary?: { resolvedPath?: string } };
    expect(body.ok).toBe(true);
    expect(body.status).toBe('already_present');
    expect(body.binary?.resolvedPath).toBe('/usr/local/bin/claude');
    expect(persistConfigValue).toHaveBeenCalledWith('claudePath', 'claude', expect.any(String));
    expect(selected).toEqual(['claude']);
  });

  it('installs locally, persists the path, and dedupes concurrent requests', async () => {
    const app = new Hono();
    const dir = mkdtempSync(join(tmpdir(), 'jinn-claude-install-'));
    const configPath = join(dir, 'config.json');
    const installRoot = join(dir, 'tools', 'claude-code');
    const installedPath = join(installRoot, 'node_modules', '.bin', 'claude');
    let npmCalls = 0;
    let releaseInstall: (() => void) | null = null;
    const installGate = new Promise<void>((resolve) => {
      releaseInstall = resolve;
    });
    const execFileAsync = vi.fn(async () => {
      npmCalls += 1;
      await installGate;
      const { mkdirSync, writeFileSync, chmodSync } = await import('node:fs');
      mkdirSync(join(installRoot, 'node_modules', '.bin'), { recursive: true });
      writeFileSync(installedPath, '#!/bin/sh\n');
      chmodSync(installedPath, 0o755);
      return { stdout: '', stderr: '' };
    });
    const selected: string[] = [];
    addSetupRoutes(app, {
      claudePath: '/missing/claude',
      configPath,
      claudeInstallRoot: installRoot,
      checkClaudeBinary: async (claudePath: string) => {
        if (claudePath === installedPath) {
          return { ok: true, detail: 'installed claude executable', resolvedPath: installedPath };
        }
        return { ok: false, detail: `${claudePath} missing` };
      },
      execFileAsync,
      onClaudePathSelected: (claudePath) => selected.push(claudePath),
    });

    const first = app.request('/v1/setup/claude/install', { method: 'POST' });
    const second = app.request('/v1/setup/claude/install', { method: 'POST' });
    releaseInstall?.();
    const [res1, res2] = await Promise.all([first, second]);

    expect(res1.status).toBe(202);
    expect(res2.status).toBe(202);
    expect(npmCalls).toBe(1);
    expect(execFileAsync).toHaveBeenCalledTimes(1);
    const body = await res1.json() as { ok: boolean; status: string; binary?: { resolvedPath?: string } };
    expect(body.ok).toBe(true);
    expect(body.status).toBe('installed');
    expect(body.binary?.resolvedPath).toBe(installedPath);
    expect(selected).toEqual([installedPath]);
    const saved = JSON.parse(readFileSync(configPath, 'utf-8')) as { claudePath?: string };
    expect(saved.claudePath).toBe(installedPath);
  });

  it('uses the selected installed path for live auth probes without restart', async () => {
    const app = new Hono();
    const dir = mkdtempSync(join(tmpdir(), 'jinn-claude-live-path-'));
    const configPath = join(dir, 'config.json');
    const installRoot = join(dir, 'tools', 'claude-code');
    const installedPath = join(installRoot, 'node_modules', '.bin', 'claude');
    let currentClaudePath = '/missing/claude';
    const checkedPaths: string[] = [];
    const execFileAsync = vi.fn(async () => {
      const { mkdirSync, writeFileSync, chmodSync } = await import('node:fs');
      mkdirSync(join(installRoot, 'node_modules', '.bin'), { recursive: true });
      writeFileSync(installedPath, '#!/bin/sh\n');
      chmodSync(installedPath, 0o755);
      return { stdout: '', stderr: '' };
    });
    const probeClaudeAuth = vi.fn(() => ({
      authenticated: false,
      context: 'bare' as const,
      detail: 'login required',
    }));

    addSetupRoutes(app, {
      getClaudePath: () => currentClaudePath,
      configPath,
      claudeInstallRoot: installRoot,
      checkClaudeBinary: async (claudePath: string) => {
        checkedPaths.push(claudePath);
        if (claudePath === installedPath) {
          return { ok: true, detail: 'installed claude executable', resolvedPath: installedPath };
        }
        return { ok: false, detail: `${claudePath} missing` };
      },
      execFileAsync,
      probeClaudeAuth,
      onClaudePathSelected: (claudePath) => {
        currentClaudePath = claudePath;
      },
    });

    const installRes = await app.request('/v1/setup/claude/install', { method: 'POST' });
    expect(installRes.status).toBe(202);

    const authRes = await app.request('/v1/auth/claude');
    expect(authRes.status).toBe(200);
    const authBody = await authRes.json() as {
      binary: { ok: boolean; resolvedPath?: string };
    };
    expect(authBody.binary.ok).toBe(true);
    expect(authBody.binary.resolvedPath).toBe(installedPath);
    expect(checkedPaths.at(-1)).toBe(installedPath);
    expect(probeClaudeAuth).toHaveBeenCalledWith(expect.objectContaining({
      claudePath: installedPath,
    }));
  });

  it('returns install_failed when npm install fails', async () => {
    const app = new Hono();
    addSetupRoutes(app, {
      claudePath: '/missing/claude',
      checkClaudeBinary: async () => ({ ok: false, detail: 'missing' }),
      execFileAsync: async () => {
        throw Object.assign(new Error('npm failed'), { stderr: 'permission denied' });
      },
    });

    const res = await app.request('/v1/setup/claude/install', { method: 'POST' });

    expect(res.status).toBe(500);
    const body = await res.json() as { ok: boolean; status: string; detail: string };
    expect(body.ok).toBe(false);
    expect(body.status).toBe('install_failed');
    expect(body.detail).toContain('permission denied');
  });
});

describe('POST /v1/setup/change-password', () => {
  it('rotates the keystore password when current is correct', async () => {
    const earningDir = mkdtempSync(join(tmpdir(), 'jinn-cp-'));
    const store = new FleetStateStore(earningDir);
    const mnemonic = generateMnemonic();
    const ks = await encryptMnemonic(mnemonic, 'old-password');
    await store.saveMnemonicKeystore(ks);

    const oldEnv = process.env['JINN_EARNING_DIR'];
    const oldHome = process.env['HOME'];
    process.env['JINN_EARNING_DIR'] = earningDir;
    process.env['HOME'] = earningDir; // sandbox keystore-password write
    try {
      const app = new Hono();
      addSetupRoutes(app);
      const res = await app.request('/v1/setup/change-password', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ current: 'old-password', next: 'new-password-99' }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean };
      expect(body.ok).toBe(true);
    } finally {
      if (oldEnv === undefined) delete process.env['JINN_EARNING_DIR'];
      else process.env['JINN_EARNING_DIR'] = oldEnv;
      if (oldHome === undefined) delete process.env['HOME'];
      else process.env['HOME'] = oldHome;
    }
  }, 15000);

  it('rejects when current password is wrong', async () => {
    const earningDir = mkdtempSync(join(tmpdir(), 'jinn-cp-'));
    const store = new FleetStateStore(earningDir);
    const mnemonic = generateMnemonic();
    const ks = await encryptMnemonic(mnemonic, 'real-password');
    await store.saveMnemonicKeystore(ks);

    const oldEnv = process.env['JINN_EARNING_DIR'];
    const oldHome = process.env['HOME'];
    process.env['JINN_EARNING_DIR'] = earningDir;
    process.env['HOME'] = earningDir; // sandbox keystore-password write
    try {
      const app = new Hono();
      addSetupRoutes(app);
      const res = await app.request('/v1/setup/change-password', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ current: 'wrong', next: 'new-password-99' }),
      });
      expect(res.status).toBe(401);
    } finally {
      if (oldEnv === undefined) delete process.env['JINN_EARNING_DIR'];
      else process.env['JINN_EARNING_DIR'] = oldEnv;
      if (oldHome === undefined) delete process.env['HOME'];
      else process.env['HOME'] = oldHome;
    }
  }, 15000);
});

describe('POST /v1/setup/drip', () => {
  it('sizes the iteration cap to clear the fresh-fleet bootstrap target', async () => {
    const earningDir = mkdtempSync(join(tmpdir(), 'jinn-drip-cap-'));
    const store = new FleetStateStore(earningDir);
    const state = await store.load('base-sepolia');
    await store.save({
      ...state,
      master_address: '0x2222222222222222222222222222222222222222',
    });

    const requestFunding = vi.fn(async () => ({
      ok: true,
      txHash: '0x' + 'cd'.repeat(32),
    }));
    const app = new Hono();
    addSetupRoutes(app, {
      earningDir,
      chain: 'base-sepolia',
      requestFunding,
      minEoaGasWei: '10000000000000000',
      interDripPauseMs: 0,
    });

    const res = await app.request('/v1/setup/drip', { method: 'POST' });

    expect(res.status).toBe(202);
    const attempts = requestFunding.mock.calls.length;
    const DRIP_WEI = 100_000_000_000_000n;
    const TARGET_WEI = 10_000_000_000_000_000n;
    expect(BigInt(attempts) * DRIP_WEI >= TARGET_WEI).toBe(true);
    expect(attempts).toBeGreaterThan(60);
  });

  // ── Wiring invariant test (jinn-mono-u34i) ───────────────────────────────
  //
  // The class of bug this test exists to catch: the faucet endpoint and the
  // daemon's Stage 1 funding gate must agree on what "fully funded" means.
  // Before u34i, the daemon read the gate from stage1MinMasterEth() while
  // main.ts plumbed a separately-computed number through `minEoaGasWei` to
  // the faucet endpoint. The two drifted (0.01 vs 0.015 ETH); the faucet
  // declared itself done while the daemon kept polling, and the operator
  // was stuck. No unit test caught it because each module passed its own
  // tests with its own idea of the target.
  //
  // The fix routes both through stage1MinMasterEth(getChainConfig(chain)).
  // This test locks the invariant: with NO minEoaGasWei override (the
  // production wiring), the faucet's reported target equals what the daemon
  // gate uses. If someone changes one without the other in the future, this
  // test fails loudly.
  it('default faucet target equals daemon Stage 1 gate (no override → derived from chain config) (jinn-mono-u34i)', async () => {
    const earningDir = mkdtempSync(join(tmpdir(), 'jinn-drip-default-target-'));
    const store = new FleetStateStore(earningDir);
    const state = await store.load('base-sepolia');
    await store.save({
      ...state,
      master_address: '0x4444444444444444444444444444444444444444',
    });
    const app = new Hono();
    addSetupRoutes(app, {
      earningDir,
      chain: 'base-sepolia',
      requestFunding: vi.fn(async () => ({ ok: true, txHash: '0x' + 'aa'.repeat(32) })),
      // Critical: do NOT pass minEoaGasWei. The endpoint must derive the
      // target from the chain config using the same helper as the daemon.
      maxFaucetIters: 0, // short-circuit the loop; we only care about targetWei in the response
      interDripPauseMs: 0,
    });

    const res = await app.request('/v1/setup/drip', { method: 'POST' });

    const body = (await res.json()) as { targetWei?: string };
    const expected = stage1MinMasterEth(getChainConfig('base-sepolia')).toString();
    expect(body.targetWei).toBe(expected);
  });

  it('stops the user-triggered faucet loop at the wall-clock cutoff', async () => {
    const earningDir = mkdtempSync(join(tmpdir(), 'jinn-drip-timeout-'));
    const store = new FleetStateStore(earningDir);
    const state = await store.load('base-sepolia');
    await store.save({
      ...state,
      master_address: '0x3333333333333333333333333333333333333333',
    });

    let now = 0;
    const requestFunding = vi.fn(async () => {
      now = 3;
      return {
        ok: true,
        txHash: '0x' + 'ef'.repeat(32),
      };
    });
    const app = new Hono();
    addSetupRoutes(app, {
      earningDir,
      chain: 'base-sepolia',
      requestFunding,
      minEoaGasWei: '10000000000000000',
      faucetLoopTimeoutMs: 2,
      now: () => now,
      interDripPauseMs: 0,
    });

    const res = await app.request('/v1/setup/drip', { method: 'POST' });

    expect(res.status).toBe(202);
    expect(requestFunding).toHaveBeenCalledTimes(1);
    const body = await res.json() as { ok: boolean; attempts: number; reason?: string; txHashes: string[] };
    expect(body.ok).toBe(true);
    expect(body.attempts).toBe(1);
    expect(body.reason).toBe('faucet_loop_timeout');
    expect(body.txHashes).toHaveLength(1);
  });

  it('runs the user-triggered faucet loop for the persisted Base Sepolia master wallet', async () => {
    const earningDir = mkdtempSync(join(tmpdir(), 'jinn-drip-'));
    const store = new FleetStateStore(earningDir);
    const state = await store.load('base-sepolia');
    await store.save({
      ...state,
      master_address: '0x1111111111111111111111111111111111111111',
    });

    const requestFunding = vi.fn(async () => ({
      ok: true,
      txHash: '0x' + 'ab'.repeat(32),
    }));
    const app = new Hono();
    addSetupRoutes(app, {
      earningDir,
      chain: 'base-sepolia',
      requestFunding,
      maxFaucetIters: 3,
      interDripPauseMs: 0,
    });

    const res = await app.request('/v1/setup/drip', { method: 'POST' });

    expect(res.status).toBe(202);
    expect(requestFunding).toHaveBeenCalledTimes(3);
    expect(requestFunding).toHaveBeenCalledWith(
      '0x1111111111111111111111111111111111111111',
      'base-sepolia',
    );
    const body = await res.json() as { ok: boolean; attempts: number; txHashes: string[] };
    expect(body.ok).toBe(true);
    expect(body.attempts).toBe(3);
    expect(body.txHashes).toHaveLength(3);
  });

  // The historical `target_not_reached` test that lived here was removed
  // when this branch merged in PR #84 (oak/onboarding-faucet-cap-and-rerip).
  // PR #84 replaces the static-cap "partial" reason with a dynamic cap that
  // sizes itself to clear the target, plus an SPA-side "Fund more" button
  // that surfaces the same partial state through balanceWei/targetWei rather
  // than a special reason code. The drip-cap-test that PR #84 added
  // upstream (`runs the user-triggered faucet loop for the persisted Base
  // Sepolia master wallet`, above) covers the new behaviour.

  // ── Single-drip mode (jinn-mono #336) ────────────────────────────────────
  //
  // The running-mode Dashboard "Top up" button must fire the faucet EXACTLY
  // ONCE per click — never loop. `?singleDrip=true` selects that path. These
  // tests lock the invariant: one request → one `requestFunding` call, even
  // when the multi-drip cap would otherwise loop dozens of times.
  it('fires the faucet exactly once with ?singleDrip=true (jinn-mono #336)', async () => {
    const earningDir = mkdtempSync(join(tmpdir(), 'jinn-drip-single-'));
    const store = new FleetStateStore(earningDir);
    const state = await store.load('base-sepolia');
    await store.save({
      ...state,
      master_address: '0x5555555555555555555555555555555555555555',
    });

    const requestFunding = vi.fn(async () => ({
      ok: true,
      txHash: '0x' + '5a'.repeat(32),
    }));
    const app = new Hono();
    addSetupRoutes(app, {
      earningDir,
      chain: 'base-sepolia',
      requestFunding,
      // A target that the multi-drip loop would chase for dozens of
      // iterations — singleDrip must ignore the cap entirely.
      minEoaGasWei: '10000000000000000',
      interDripPauseMs: 0,
    });

    const res = await app.request('/v1/setup/drip?singleDrip=true', {
      method: 'POST',
    });

    expect(res.status).toBe(202);
    expect(requestFunding).toHaveBeenCalledTimes(1);
    expect(requestFunding).toHaveBeenCalledWith(
      '0x5555555555555555555555555555555555555555',
      'base-sepolia',
    );
    const body = (await res.json()) as {
      ok: boolean;
      txHash?: string;
      txHashes: string[];
      attempts: number;
    };
    expect(body.ok).toBe(true);
    expect(body.attempts).toBe(1);
    expect(body.txHashes).toHaveLength(1);
    expect(body.txHash).toBe('0x' + '5a'.repeat(32));
  });

  it('still runs the multi-drip loop when ?singleDrip is absent (jinn-mono #336 regression guard)', async () => {
    const earningDir = mkdtempSync(join(tmpdir(), 'jinn-drip-multi-'));
    const store = new FleetStateStore(earningDir);
    const state = await store.load('base-sepolia');
    await store.save({
      ...state,
      master_address: '0x6666666666666666666666666666666666666666',
    });

    const requestFunding = vi.fn(async () => ({
      ok: true,
      txHash: '0x' + '6b'.repeat(32),
    }));
    const app = new Hono();
    addSetupRoutes(app, {
      earningDir,
      chain: 'base-sepolia',
      requestFunding,
      maxFaucetIters: 3,
      interDripPauseMs: 0,
    });

    const res = await app.request('/v1/setup/drip', { method: 'POST' });

    expect(res.status).toBe(202);
    // The bootstrap funding gate keeps looping — singleDrip did not regress it.
    expect(requestFunding).toHaveBeenCalledTimes(3);
  });

  it('surfaces a faucet failure on the single-drip path without looping (jinn-mono #336)', async () => {
    const earningDir = mkdtempSync(join(tmpdir(), 'jinn-drip-single-fail-'));
    const store = new FleetStateStore(earningDir);
    const state = await store.load('base-sepolia');
    await store.save({
      ...state,
      master_address: '0x7777777777777777777777777777777777777777',
    });

    const requestFunding = vi.fn(async () => ({
      ok: false,
      rateLimited: true,
      reason: 'Faucet rate limited (1 claim per 24 hours per address).',
    }));
    const app = new Hono();
    addSetupRoutes(app, {
      earningDir,
      chain: 'base-sepolia',
      requestFunding,
      minEoaGasWei: '10000000000000000',
      interDripPauseMs: 0,
    });

    const res = await app.request('/v1/setup/drip?singleDrip=true', {
      method: 'POST',
    });

    expect(res.status).toBe(200);
    expect(requestFunding).toHaveBeenCalledTimes(1);
    const body = (await res.json()) as {
      ok: boolean;
      rateLimited?: boolean;
      reason?: string;
    };
    expect(body.ok).toBe(false);
    expect(body.rateLimited).toBe(true);
  });

  // ── Drip-loop pacing (issue #984 work unit 1) ────────────────────────────
  //
  // AC-2: a transient CDP throttle (429) must back off and retry WITHIN the
  // session rather than ending it on the first 429. Before #984 the first
  // `rateLimited` result returned immediately, killing the whole drip session.
  it('retries after a transient 429 instead of bailing', async () => {
    const earningDir = mkdtempSync(join(tmpdir(), 'jinn-drip-retry-'));
    const store = new FleetStateStore(earningDir);
    const state = await store.load('base-sepolia');
    await store.save({
      ...state,
      master_address: '0x8888888888888888888888888888888888888888',
    });

    let call = 0;
    const requestFunding = vi.fn(async () => {
      call += 1;
      if (call <= 2) {
        return { ok: false, rateLimited: true, reason: 'rate limited' };
      }
      return { ok: true, txHash: '0x' + '88'.repeat(32) };
    });
    const app = new Hono();
    addSetupRoutes(app, {
      earningDir,
      chain: 'base-sepolia',
      requestFunding,
      maxFaucetIters: 5,
      interDripPauseMs: 0,
      faucetRateLimitBackoffMs: 0,
      getBalance: async () => 0n,
    });

    const res = await app.request('/v1/setup/drip', { method: 'POST' });

    expect(requestFunding.mock.calls.length).toBeGreaterThanOrEqual(3);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  // AC-3: balance must not be read once per drip. Before #984 every iteration
  // did a `getBalance()` RPC call; the loop now reads on a reduced cadence
  // (~every 5 drips + the final iteration), gated by the 5-min wall-clock cap.
  it('does not read balance once per drip on a multi-drip session', async () => {
    const earningDir = mkdtempSync(join(tmpdir(), 'jinn-drip-balance-cadence-'));
    const store = new FleetStateStore(earningDir);
    const state = await store.load('base-sepolia');
    await store.save({
      ...state,
      master_address: '0x9999999999999999999999999999999999999999',
    });

    const requestFunding = vi.fn(async () => ({
      ok: true,
      txHash: '0x' + '99'.repeat(32),
    }));
    const getBalance = vi.fn(async () => 0n);
    const app = new Hono();
    addSetupRoutes(app, {
      earningDir,
      chain: 'base-sepolia',
      requestFunding,
      maxFaucetIters: 20,
      interDripPauseMs: 0,
      getBalance,
    });

    const res = await app.request('/v1/setup/drip', { method: 'POST' });

    expect(res.status).toBe(202);
    const balanceReads = getBalance.mock.calls.length;
    const drips = requestFunding.mock.calls.length;
    expect(balanceReads).toBeLessThan(drips);
    // ~ceil(20/5) cadence reads + pre-loop + final, with headroom.
    expect(balanceReads).toBeLessThanOrEqual(Math.ceil(20 / 5) + 2);
  });

  // ── Batched daily-cap top-up (issue #560) ───────────────────────────────
  //
  // The running-mode Dashboard "Top up from faucet" button issues a BATCH of
  // drips up to a project-set daily cap in one click, then disables itself
  // until a 24h cooldown elapses since the first call of that batch.
  it('batch mode drips exactly up to the daily cap and persists the sidecar (issue #560)', async () => {
    const earningDir = mkdtempSync(join(tmpdir(), 'jinn-drip-batch-cap-'));
    const store = new FleetStateStore(earningDir);
    const state = await store.load('base-sepolia');
    const master = '0xAAAA000000000000000000000000000000000001';
    await store.save({ ...state, master_address: master });

    const requestFunding = vi.fn(async () => ({ ok: true, txHash: '0x' + 'ba'.repeat(32) }));
    const app = new Hono();
    addSetupRoutes(app, {
      earningDir,
      chain: 'base-sepolia',
      requestFunding,
      faucetDailyTopupCap: 3,
      faucetTopupCooldownMs: 24 * 60 * 60 * 1000,
      now: () => 1_000,
    });

    const res = await app.request('/v1/setup/drip?batch=true', { method: 'POST' });
    expect(res.status).toBe(202);
    expect(requestFunding).toHaveBeenCalledTimes(3);
    const body = (await res.json()) as {
      ok: boolean;
      txHashes: string[];
      callsRemaining: number;
      dailyCap: number;
      cooldownExpiresAt: number;
    };
    expect(body.ok).toBe(true);
    expect(body.txHashes).toHaveLength(3);
    expect(body.callsRemaining).toBe(0);
    expect(body.dailyCap).toBe(3);
    expect(body.cooldownExpiresAt).toBe(1_000 + 24 * 60 * 60 * 1000);

    const sidecar = JSON.parse(readFileSync(join(earningDir, 'faucet-topup.json'), 'utf-8')) as {
      byAddress: Record<string, { callsToday: number; batchStartedAt: number }>;
    };
    expect(sidecar.byAddress[master.toLowerCase()]).toEqual({
      callsToday: 3,
      batchStartedAt: 1_000,
    });
  });

  it('returns topup_cooldown and does not call the faucet once the cap is reached (issue #560)', async () => {
    const earningDir = mkdtempSync(join(tmpdir(), 'jinn-drip-batch-cooldown-'));
    const store = new FleetStateStore(earningDir);
    const state = await store.load('base-sepolia');
    const master = '0xAAAA000000000000000000000000000000000002';
    await store.save({ ...state, master_address: master });

    const requestFunding = vi.fn(async () => ({ ok: true, txHash: '0x' + 'cc'.repeat(32) }));
    const app = new Hono();
    addSetupRoutes(app, {
      earningDir,
      chain: 'base-sepolia',
      requestFunding,
      faucetDailyTopupCap: 2,
      faucetTopupCooldownMs: 24 * 60 * 60 * 1000,
      now: () => 5_000,
    });

    // First batch exhausts the cap.
    const first = await app.request('/v1/setup/drip?batch=true', { method: 'POST' });
    expect(first.status).toBe(202);
    expect(requestFunding).toHaveBeenCalledTimes(2);

    // Immediate second batch at the same `now` → cooldown, no faucet calls.
    const second = await app.request('/v1/setup/drip?batch=true', { method: 'POST' });
    expect(second.status).toBe(200);
    expect(requestFunding).toHaveBeenCalledTimes(2);
    const body = (await second.json()) as {
      ok: boolean;
      reason?: string;
      callsRemaining: number;
      cooldownExpiresAt: number;
    };
    expect(body.ok).toBe(false);
    expect(body.reason).toBe('topup_cooldown');
    expect(body.callsRemaining).toBe(0);
    expect(body.cooldownExpiresAt).toBe(5_000 + 24 * 60 * 60 * 1000);
  });

  it('resets the batch once the cooldown window has elapsed (issue #560)', async () => {
    const earningDir = mkdtempSync(join(tmpdir(), 'jinn-drip-batch-reset-'));
    const store = new FleetStateStore(earningDir);
    const state = await store.load('base-sepolia');
    const master = '0xAAAA000000000000000000000000000000000003';
    await store.save({ ...state, master_address: master });

    const requestFunding = vi.fn(async () => ({ ok: true, txHash: '0x' + 'dd'.repeat(32) }));
    const cooldownMs = 24 * 60 * 60 * 1000;
    let now = 1_000;
    const app = new Hono();
    addSetupRoutes(app, {
      earningDir,
      chain: 'base-sepolia',
      requestFunding,
      faucetDailyTopupCap: 2,
      faucetTopupCooldownMs: cooldownMs,
      now: () => now,
    });

    await app.request('/v1/setup/drip?batch=true', { method: 'POST' });
    expect(requestFunding).toHaveBeenCalledTimes(2);

    // Advance past the cooldown — a fresh batch is granted.
    now = 1_000 + cooldownMs + 1;
    const res = await app.request('/v1/setup/drip?batch=true', { method: 'POST' });
    expect(res.status).toBe(202);
    expect(requestFunding).toHaveBeenCalledTimes(4);
    const body = (await res.json()) as { callsRemaining: number; cooldownExpiresAt: number };
    expect(body.callsRemaining).toBe(0);
    expect(body.cooldownExpiresAt).toBe(now + cooldownMs);
  });

  it('stops the batch early when the faucet rate-limits and persists progress (issue #560)', async () => {
    const earningDir = mkdtempSync(join(tmpdir(), 'jinn-drip-batch-rl-'));
    const store = new FleetStateStore(earningDir);
    const state = await store.load('base-sepolia');
    const master = '0xAAAA000000000000000000000000000000000004';
    await store.save({ ...state, master_address: master });

    let call = 0;
    const requestFunding = vi.fn(async () => {
      call++;
      if (call === 1) return { ok: true, txHash: '0x' + 'ee'.repeat(32) };
      return { ok: false, rateLimited: true, reason: 'Faucet rate limited.' };
    });
    const app = new Hono();
    addSetupRoutes(app, {
      earningDir,
      chain: 'base-sepolia',
      requestFunding,
      faucetDailyTopupCap: 5,
      faucetTopupCooldownMs: 24 * 60 * 60 * 1000,
      now: () => 2_000,
    });

    const res = await app.request('/v1/setup/drip?batch=true', { method: 'POST' });
    expect(res.status).toBe(202);
    expect(requestFunding).toHaveBeenCalledTimes(2);
    const body = (await res.json()) as {
      ok: boolean;
      txHashes: string[];
      callsRemaining: number;
      rateLimited?: boolean;
    };
    expect(body.ok).toBe(true);
    expect(body.txHashes).toHaveLength(1);
    expect(body.rateLimited).toBe(true);
    expect(body.callsRemaining).toBe(4);

    const sidecar = JSON.parse(readFileSync(join(earningDir, 'faucet-topup.json'), 'utf-8')) as {
      byAddress: Record<string, { callsToday: number; batchStartedAt: number }>;
    };
    expect(sidecar.byAddress[master.toLowerCase()]).toEqual({
      callsToday: 1,
      batchStartedAt: 2_000,
    });
  });

  // H1: two concurrent batch POSTs for the same wallet must not both read
  // `callsRemaining` before either persists and double-spend the cap. The
  // second concurrent call gets a 409 `batch_in_progress`; the combined
  // successful drips never exceed dailyCap.
  it('rejects a concurrent batch for the same wallet with 409 and never exceeds the cap (issue #560 H1)', async () => {
    const earningDir = mkdtempSync(join(tmpdir(), 'jinn-drip-batch-concurrent-'));
    const store = new FleetStateStore(earningDir);
    const state = await store.load('base-sepolia');
    const master = '0xAAAA000000000000000000000000000000000006';
    await store.save({ ...state, master_address: master });

    // Gate the first faucet call so the second batch POST arrives while the
    // first is still mid-loop (holding the lock).
    let releaseFirstDrip: (() => void) | null = null;
    const firstDripGate = new Promise<void>((resolve) => {
      releaseFirstDrip = resolve;
    });
    let calls = 0;
    const requestFunding = vi.fn(async () => {
      calls += 1;
      if (calls === 1) await firstDripGate;
      return { ok: true, txHash: '0x' + 'a6'.repeat(32) };
    });
    const app = new Hono();
    addSetupRoutes(app, {
      earningDir,
      chain: 'base-sepolia',
      requestFunding,
      faucetDailyTopupCap: 3,
      faucetTopupCooldownMs: 24 * 60 * 60 * 1000,
      now: () => 1_000,
    });

    const first = app.request('/v1/setup/drip?batch=true', { method: 'POST' });
    // Let the first request enter the loop and acquire the lock before the
    // second arrives.
    await new Promise((r) => setTimeout(r, 0));
    const second = app.request('/v1/setup/drip?batch=true', { method: 'POST' });
    // Second should reject quickly (lock held) without touching the faucet.
    const res2 = await second;
    expect(res2.status).toBe(409);
    const body2 = (await res2.json()) as { ok: boolean; reason?: string };
    expect(body2.ok).toBe(false);
    expect(body2.reason).toBe('batch_in_progress');

    // Now let the first batch finish.
    releaseFirstDrip?.();
    const res1 = await first;
    expect(res1.status).toBe(202);
    const body1 = (await res1.json()) as { txHashes: string[]; callsRemaining: number };
    expect(body1.txHashes).toHaveLength(3);
    expect(body1.callsRemaining).toBe(0);

    // Combined faucet calls never exceeded the cap.
    expect(requestFunding).toHaveBeenCalledTimes(3);

    const sidecar = JSON.parse(readFileSync(join(earningDir, 'faucet-topup.json'), 'utf-8')) as {
      byAddress: Record<string, { callsToday: number; batchStartedAt: number }>;
    };
    expect(sidecar.byAddress[master.toLowerCase()]).toEqual({
      callsToday: 3,
      batchStartedAt: 1_000,
    });
  });

  it('singleDrip still wins when both batch and singleDrip are present (issue #560)', async () => {
    const earningDir = mkdtempSync(join(tmpdir(), 'jinn-drip-batch-single-'));
    const store = new FleetStateStore(earningDir);
    const state = await store.load('base-sepolia');
    await store.save({
      ...state,
      master_address: '0xAAAA000000000000000000000000000000000005',
    });

    const requestFunding = vi.fn(async () => ({ ok: true, txHash: '0x' + 'ff'.repeat(32) }));
    const app = new Hono();
    addSetupRoutes(app, {
      earningDir,
      chain: 'base-sepolia',
      requestFunding,
      faucetDailyTopupCap: 5,
      minEoaGasWei: '10000000000000000',
    });

    const res = await app.request('/v1/setup/drip?batch=true&singleDrip=true', {
      method: 'POST',
    });
    expect(res.status).toBe(202);
    expect(requestFunding).toHaveBeenCalledTimes(1);
  });

  // ── GET /v1/setup/drip/quota (issue #560) ───────────────────────────────
  it('GET quota reports the full cap for a fresh wallet (issue #560)', async () => {
    const earningDir = mkdtempSync(join(tmpdir(), 'jinn-quota-fresh-'));
    const store = new FleetStateStore(earningDir);
    const state = await store.load('base-sepolia');
    await store.save({
      ...state,
      master_address: '0xBBBB000000000000000000000000000000000001',
    });

    const app = new Hono();
    addSetupRoutes(app, {
      earningDir,
      chain: 'base-sepolia',
      faucetDailyTopupCap: 7,
      now: () => 1_000,
    });

    const res = await app.request('/v1/setup/drip/quota');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      dailyCap: number;
      callsRemaining: number;
      cooldownExpiresAt: number | null;
    };
    expect(body.ok).toBe(true);
    expect(body.dailyCap).toBe(7);
    expect(body.callsRemaining).toBe(7);
    expect(body.cooldownExpiresAt).toBeNull();
  });

  it('GET quota reflects a drained batch after a top-up (issue #560)', async () => {
    const earningDir = mkdtempSync(join(tmpdir(), 'jinn-quota-after-'));
    const store = new FleetStateStore(earningDir);
    const state = await store.load('base-sepolia');
    await store.save({
      ...state,
      master_address: '0xBBBB000000000000000000000000000000000002',
    });

    const requestFunding = vi.fn(async () => ({ ok: true, txHash: '0x' + '1a'.repeat(32) }));
    const cooldownMs = 24 * 60 * 60 * 1000;
    const app = new Hono();
    addSetupRoutes(app, {
      earningDir,
      chain: 'base-sepolia',
      requestFunding,
      faucetDailyTopupCap: 2,
      faucetTopupCooldownMs: cooldownMs,
      now: () => 9_000,
    });

    await app.request('/v1/setup/drip?batch=true', { method: 'POST' });
    const res = await app.request('/v1/setup/drip/quota');
    const body = (await res.json()) as {
      callsRemaining: number;
      cooldownExpiresAt: number | null;
    };
    expect(body.callsRemaining).toBe(0);
    expect(body.cooldownExpiresAt).toBe(9_000 + cooldownMs);
  });

  it('GET quota soft-renders full cap when no fleet state exists (issue #560)', async () => {
    const earningDir = mkdtempSync(join(tmpdir(), 'jinn-quota-nostate-'));
    const app = new Hono();
    addSetupRoutes(app, {
      earningDir,
      chain: 'base-sepolia',
      faucetDailyTopupCap: 4,
    });

    const res = await app.request('/v1/setup/drip/quota');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      dailyCap: number;
      callsRemaining: number;
      cooldownExpiresAt: number | null;
    };
    expect(body.ok).toBe(true);
    expect(body.dailyCap).toBe(4);
    expect(body.callsRemaining).toBe(4);
    expect(body.cooldownExpiresAt).toBeNull();
  });
});

describe('retired SolverNet membership routes', () => {
  it('does not serve POST /v1/setup/solvernets/:name', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jinn-solvernet-cfg-'));
    const configPath = join(dir, 'config.json');

    const app = new Hono();
    addSetupRoutes(app, { configPath });

    const res = await app.request('/v1/setup/solvernets/prediction', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    });

    expect(res.status).toBe(404);
  });

  it('does not serve GET /v1/operator/joined', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jinn-joined-read-'));
    const configPath = join(dir, 'config.json');
    writeFileSync(configPath, JSON.stringify({ network: 'testnet' }));

    const app = new Hono();
    addSetupRoutes(app, { configPath });
    const res = await app.request('/v1/operator/joined');
    expect(res.status).toBe(404);
  });
});

describe('GET /v1/operator/joined', () => {
  it('has no write counterpart — join and leave are 404 after Wave-4 D1', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jinn-joined-nowrite-'));
    const configPath = join(dir, 'config.json');
    const app = new Hono();
    addSetupRoutes(app, { configPath });

    const post = await app.request('/v1/operator/join/bafyone', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ roles: ['solver'] }),
    });
    expect(post.status).toBe(404);

    const del = await app.request('/v1/operator/join/bafyone', { method: 'DELETE' });
    expect(del.status).toBe(404);
  });
});

describe('POST /v1/setup/network', () => {
  const writeConfig = (path: string, body: unknown): void => {
    require('node:fs').writeFileSync(path, JSON.stringify(body, null, 2) + '\n');
  };

  it('persists a custom RPC URL', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jinn-network-cfg-'));
    const configPath = join(dir, 'config.json');
    writeConfig(configPath, { network: 'testnet', rpcUrl: 'https://default.example' });

    const app = new Hono();
    addSetupRoutes(app, {
      configPath,
      defaultRpcUrlsForChain: () => ['https://default.example'],
    });

    const res = await app.request('/v1/setup/network', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rpcUrl: 'https://my-tenderly.example.com/abc' }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; restartRequired: boolean; rpcUrl: string | string[] };
    expect(body.ok).toBe(true);
    expect(body.restartRequired).toBe(true);
    expect(body.rpcUrl).toEqual(['https://my-tenderly.example.com/abc', 'https://default.example']);

    const persisted = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(persisted.rpcUrl).toEqual(['https://my-tenderly.example.com/abc', 'https://default.example']);
    expect(persisted.network).toBe('testnet');
  });

  it('reverts to default when rpcUrl is null', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jinn-network-cfg-'));
    const configPath = join(dir, 'config.json');
    writeConfig(configPath, { network: 'testnet', rpcUrl: 'https://custom.example' });

    const app = new Hono();
    addSetupRoutes(app, {
      configPath,
      defaultRpcUrlsForChain: () => ['https://sepolia.base.org'],
    });

    const res = await app.request('/v1/setup/network', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rpcUrl: null }),
    });

    expect(res.status).toBe(200);
    const persisted = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(persisted.rpcUrl).toEqual(['https://sepolia.base.org']);
  });

  it('rejects a non-URL string', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jinn-network-cfg-'));
    const configPath = join(dir, 'config.json');
    writeConfig(configPath, { network: 'testnet', rpcUrl: 'https://default.example' });

    const app = new Hono();
    addSetupRoutes(app, { configPath });

    const res = await app.request('/v1/setup/network', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rpcUrl: 'not a url' }),
    });

    expect(res.status).toBe(400);
  });

  it('creates config.json when it does not exist (jinn-mono-u34i)', async () => {
    // Fresh operator: daemon ran with built-in defaults, no config.json on
    // disk. Pre-u34i the endpoint 404'd with `config_not_found`, blocking
    // the only operator-app affordance for switching off a rate-limited
    // public RPC. Operator was forced to drop into the terminal and hand-
    // write JSON — violation of the never-leaves-the-app principle.
    //
    // Fix: the endpoint defers to persistTopLevelConfigValue, which already
    // creates the parent dir + file when missing (same pattern as every
    // other write endpoint in this module).
    const dir = mkdtempSync(join(tmpdir(), 'jinn-network-no-cfg-'));
    const configPath = join(dir, 'config.json');
    // CRITICAL: do NOT pre-write the file.

    const app = new Hono();
    addSetupRoutes(app, {
      configPath,
      defaultRpcUrlsForChain: () => [
        'https://base-sepolia.publicnode.com',
        'https://sepolia.base.org',
      ],
    });

    const res = await app.request('/v1/setup/network', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rpcUrl: 'https://base-sepolia.gateway.tenderly.co/abc123' }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; restartRequired: boolean; rpcUrl: string | string[] };
    expect(body.ok).toBe(true);
    expect(body.restartRequired).toBe(true);
    expect(body.rpcUrl).toEqual([
      'https://base-sepolia.gateway.tenderly.co/abc123',
      'https://base-sepolia.publicnode.com',
      'https://sepolia.base.org',
    ]);

    // The file was created with the new rpcUrl.
    const persisted = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(persisted.rpcUrl).toEqual([
      'https://base-sepolia.gateway.tenderly.co/abc123',
      'https://base-sepolia.publicnode.com',
      'https://sepolia.base.org',
    ]);
  });

  it('persists [primary, ...publicDefaults] when a primary URL is given (#913)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jinn-network-primary-'));
    const configPath = join(dir, 'config.json');
    writeConfig(configPath, { network: 'testnet' });

    const app = new Hono();
    addSetupRoutes(app, {
      configPath,
      defaultRpcUrlsForChain: () => [
        'https://base-sepolia.publicnode.com',
        'https://sepolia.base.org',
      ],
    });

    const res = await app.request('/v1/setup/network', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rpcUrl: 'https://my-alchemy.example/key' }),
    });

    expect(res.status).toBe(200);
    const persisted = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(persisted.rpcUrl).toEqual([
      'https://my-alchemy.example/key',
      'https://base-sepolia.publicnode.com',
      'https://sepolia.base.org',
    ]);
  });

  it('persists [...publicDefaults] when the primary is cleared to null (#913)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jinn-network-clear-'));
    const configPath = join(dir, 'config.json');
    writeConfig(configPath, {
      network: 'testnet',
      rpcUrl: ['https://old-primary.example/k', 'https://base-sepolia.publicnode.com'],
    });

    const app = new Hono();
    addSetupRoutes(app, {
      configPath,
      defaultRpcUrlsForChain: () => [
        'https://base-sepolia.publicnode.com',
        'https://sepolia.base.org',
      ],
    });

    const res = await app.request('/v1/setup/network', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rpcUrl: null }),
    });

    expect(res.status).toBe(200);
    const persisted = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(persisted.rpcUrl).toEqual([
      'https://base-sepolia.publicnode.com',
      'https://sepolia.base.org',
    ]);
  });
});

describe('POST /v1/operator/onboarding-complete', () => {
  const writeConfig = (path: string, body: unknown): void => {
    require('node:fs').writeFileSync(path, JSON.stringify(body, null, 2) + '\n');
  };

  it('persists onboardingComplete:true and preserves other keys', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jinn-onboarding-complete-'));
    const configPath = join(dir, 'config.json');
    writeConfig(configPath, { network: 'testnet' });

    const app = new Hono();
    addSetupRoutes(app, { configPath });

    const res = await app.request('/v1/operator/onboarding-complete', {
      method: 'POST',
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; onboardingComplete: boolean };
    expect(body.ok).toBe(true);
    expect(body.onboardingComplete).toBe(true);

    const persisted = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(persisted.onboardingComplete).toBe(true);
    expect(persisted.network).toBe('testnet');
  });

  it('invokes the in-memory markOnboardingComplete callback when supplied', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jinn-onboarding-complete-cb-'));
    const configPath = join(dir, 'config.json');
    writeConfig(configPath, {});
    const markOnboardingComplete = vi.fn();

    const app = new Hono();
    addSetupRoutes(app, { configPath, markOnboardingComplete });

    const res = await app.request('/v1/operator/onboarding-complete', {
      method: 'POST',
    });
    expect(res.status).toBe(200);
    expect(markOnboardingComplete).toHaveBeenCalledTimes(1);
  });
});
