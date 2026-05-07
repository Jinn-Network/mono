import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addSetupRoutes } from '../../src/api/setup-endpoints.js';
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
});

describe('POST /v1/setup/solvernets/:name', () => {
  const writeConfig = (path: string, body: unknown): void => {
    require('node:fs').writeFileSync(path, JSON.stringify(body, null, 2) + '\n');
  };
  const baseConfig = (): Record<string, unknown> => ({
    network: 'testnet',
    rpcUrl: 'https://example/rpc',
    solverNets: {
      prediction: {
        enabled: false,
        solverType: 'prediction.v0',
        harness: 'claude-code-learner',
        plugins: [],
      },
    },
  });

  it('flips enabled and persists the change to config.json', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jinn-solvernet-cfg-'));
    const configPath = join(dir, 'config.json');
    writeConfig(configPath, baseConfig());

    const app = new Hono();
    addSetupRoutes(app, { configPath });

    const res = await app.request('/v1/setup/solvernets/prediction', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as {
      ok: boolean;
      restartRequired: boolean;
      name: string;
      config: { enabled: boolean; solverType: string };
    };
    expect(body.ok).toBe(true);
    expect(body.restartRequired).toBe(true);
    expect(body.config.enabled).toBe(true);
    expect(body.config.solverType).toBe('prediction.v0'); // unchanged

    const persisted = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(persisted.solverNets.prediction.enabled).toBe(true);
    expect(persisted.solverNets.prediction.solverType).toBe('prediction.v0');
    // Other top-level keys are preserved by persistTopLevelConfigValue
    expect(persisted.network).toBe('testnet');
  });

  it('returns 404 when the SolverNet has no on-disk config and no default block exists', async () => {
    // Task 22 of spec/2026-05-05-solvernet-creation-and-launch.md dropped
    // the `solverNets.prediction` default seed (Decision 5 — registry-only
    // catalog). Operators join SolverNets through the launched-record
    // surface; the legacy POST /v1/setup/solvernets seed-from-default
    // behavior is gone.
    const dir = mkdtempSync(join(tmpdir(), 'jinn-solvernet-cfg-'));
    const configPath = join(dir, 'config.json');

    const app = new Hono();
    addSetupRoutes(app, { configPath });

    const res = await app.request('/v1/setup/solvernets/prediction', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });

    expect(res.status).toBe(404);
  });

  it('returns 404 for a legacy config that omits solverNets (no default seed)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jinn-solvernet-cfg-'));
    const configPath = join(dir, 'config.json');
    writeConfig(configPath, { network: 'testnet', rpcUrl: 'https://example/rpc' });

    const app = new Hono();
    addSetupRoutes(app, { configPath });

    const res = await app.request('/v1/setup/solvernets/prediction', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ role: 'evaluating' }),
    });

    expect(res.status).toBe(404);
  });

  it('swaps solverType and accepts both enabled+solverType in one call', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jinn-solvernet-cfg-'));
    const configPath = join(dir, 'config.json');
    writeConfig(configPath, baseConfig());

    const app = new Hono();
    addSetupRoutes(app, { configPath });

    const res = await app.request('/v1/setup/solvernets/prediction', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true, solverType: 'prediction.v1' }),
    });

    expect(res.status).toBe(200);
    const persisted = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(persisted.solverNets.prediction.enabled).toBe(true);
    expect(persisted.solverNets.prediction.solverType).toBe('prediction.v1');
  });

  it('rejects an unknown solverType so config does not silently break the runtime', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jinn-solvernet-cfg-'));
    const configPath = join(dir, 'config.json');
    writeConfig(configPath, baseConfig());

    const app = new Hono();
    addSetupRoutes(app, { configPath });

    const res = await app.request('/v1/setup/solvernets/prediction', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ solverType: 'prediction.v99' }),
    });

    expect(res.status).toBe(400);
    const persisted = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(persisted.solverNets.prediction.solverType).toBe('prediction.v0');
  });

  it('returns 404 when the solvernet name is not configured', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jinn-solvernet-cfg-'));
    const configPath = join(dir, 'config.json');
    writeConfig(configPath, baseConfig());

    const app = new Hono();
    addSetupRoutes(app, { configPath });

    const res = await app.request('/v1/setup/solvernets/portfolio', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    });

    expect(res.status).toBe(404);
    const body = await res.json() as { error: string; available: string[] };
    expect(body.error).toBe('solvernet_not_found');
    expect(body.available).toEqual(['prediction']);
  });

  it('accepts a roles array and persists it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jinn-solvernet-cfg-'));
    const configPath = join(dir, 'config.json');
    writeConfig(configPath, baseConfig());
    let observed: Record<string, Record<string, unknown>> | undefined;

    const app = new Hono();
    addSetupRoutes(app, {
      configPath,
      onSolverNetsUpdated: (solverNets) => {
        observed = solverNets;
      },
    });

    const res = await app.request('/v1/setup/solvernets/prediction', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ roles: ['solving', 'evaluating'] }),
    });

    expect(res.status).toBe(200);
    const persisted = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(persisted.solverNets.prediction.roles).toEqual(['solving', 'evaluating']);
    expect(observed?.prediction?.roles).toEqual(['solving', 'evaluating']);
  });

  it('accepts the legacy singular role field and promotes it to roles', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jinn-solvernet-cfg-'));
    const configPath = join(dir, 'config.json');
    writeConfig(configPath, baseConfig());

    const app = new Hono();
    addSetupRoutes(app, { configPath });

    const res = await app.request('/v1/setup/solvernets/prediction', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ role: 'evaluating' }),
    });

    expect(res.status).toBe(200);
    const persisted = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(persisted.solverNets.prediction.roles).toEqual(['evaluating']);
    // Legacy `role` is dropped when `roles` is set so the persisted shape
    // is canonical and there is exactly one source of truth.
    expect(persisted.solverNets.prediction.role).toBeUndefined();
  });

  it('rejects an empty roles array', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jinn-solvernet-cfg-'));
    const configPath = join(dir, 'config.json');
    writeConfig(configPath, baseConfig());

    const app = new Hono();
    addSetupRoutes(app, { configPath });

    const res = await app.request('/v1/setup/solvernets/prediction', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ roles: [] }),
    });

    expect(res.status).toBe(400);
  });

  it('rejects a roles array with an unknown role', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jinn-solvernet-cfg-'));
    const configPath = join(dir, 'config.json');
    writeConfig(configPath, baseConfig());

    const app = new Hono();
    addSetupRoutes(app, { configPath });

    const res = await app.request('/v1/setup/solvernets/prediction', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ roles: ['solving', 'creator'] }),
    });

    expect(res.status).toBe(400);
  });

  it('accepts harness, model, and plugins together', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jinn-solvernet-cfg-'));
    const configPath = join(dir, 'config.json');
    writeConfig(configPath, baseConfig());

    const app = new Hono();
    addSetupRoutes(app, { configPath });

    const res = await app.request('/v1/setup/solvernets/prediction', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        harness: 'claude-code-learner',
        model: 'claude-haiku-4-5-20251001',
        plugins: ['jinn-prediction-plugin'],
      }),
    });

    expect(res.status).toBe(200);
    const persisted = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(persisted.solverNets.prediction.harness).toBe('claude-code-learner');
    expect(persisted.solverNets.prediction.model).toBe('claude-haiku-4-5-20251001');
    expect(persisted.solverNets.prediction.plugins).toEqual(['jinn-prediction-plugin']);
  });

  it('rejects an unknown role', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jinn-solvernet-cfg-'));
    const configPath = join(dir, 'config.json');
    writeConfig(configPath, baseConfig());

    const app = new Hono();
    addSetupRoutes(app, { configPath });

    const res = await app.request('/v1/setup/solvernets/prediction', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ role: 'creator' }),
    });

    expect(res.status).toBe(400);
  });

  it('overwrites roles with the operator-supplied set (legacy launching dropped)', async () => {
    // Task 22 of spec/2026-05-05-solvernet-creation-and-launch.md retired
    // the `'launching'` operator role; the previous "preserve launching"
    // semantic no longer applies — operator role patches are authoritative
    // and the role array is overwritten with the supplied roles.
    const dir = mkdtempSync(join(tmpdir(), 'jinn-solvernet-cfg-'));
    const configPath = join(dir, 'config.json');
    writeConfig(configPath, {
      network: 'testnet',
      rpcUrl: 'https://example/rpc',
      solverNets: {
        prediction: {
          enabled: true,
          solverType: 'prediction.v0',
          roles: ['solving'],
          harness: 'claude-code-learner',
          plugins: [],
        },
      },
    });

    const app = new Hono();
    addSetupRoutes(app, { configPath });

    const res = await app.request('/v1/setup/solvernets/prediction', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true, roles: ['evaluating'] }),
    });

    expect(res.status).toBe(200);
    const persisted = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect([...persisted.solverNets.prediction.roles].sort()).toEqual(['evaluating']);
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
    addSetupRoutes(app, { configPath });

    const res = await app.request('/v1/setup/network', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rpcUrl: 'https://my-tenderly.example.com/abc' }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; restartRequired: boolean; rpcUrl: string };
    expect(body.ok).toBe(true);
    expect(body.restartRequired).toBe(true);
    expect(body.rpcUrl).toBe('https://my-tenderly.example.com/abc');

    const persisted = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(persisted.rpcUrl).toBe('https://my-tenderly.example.com/abc');
    expect(persisted.network).toBe('testnet');
  });

  it('reverts to default when rpcUrl is null', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jinn-network-cfg-'));
    const configPath = join(dir, 'config.json');
    writeConfig(configPath, { network: 'testnet', rpcUrl: 'https://custom.example' });

    const app = new Hono();
    addSetupRoutes(app, {
      configPath,
      defaultRpcUrlForChain: () => 'https://sepolia.base.org',
    });

    const res = await app.request('/v1/setup/network', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rpcUrl: null }),
    });

    expect(res.status).toBe(200);
    const persisted = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(persisted.rpcUrl).toBe('https://sepolia.base.org');
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
});

describe('POST /v1/operator/join/:cid', () => {
  // Operator participation flow keyed by manifestCid (Task 21).
  // Spec: spec/2026-05-05-solvernet-creation-and-launch.md §12.
  const writeConfig = (path: string, body: unknown): void => {
    require('node:fs').writeFileSync(path, JSON.stringify(body, null, 2) + '\n');
  };

  it('writes a manifest-keyed entry to config.joinedSolverNets', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jinn-operator-join-'));
    const configPath = join(dir, 'config.json');
    writeConfig(configPath, { network: 'testnet' });

    const app = new Hono();
    addSetupRoutes(app, { configPath });

    const res = await app.request('/v1/operator/join/bafybeiaaa', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Prediction',
        roles: ['solver'],
        harness: 'claude-code-learner',
        model: 'claude-haiku-4-5-20251001',
        plugins: ['jinn-prediction-plugin'],
      }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      restartRequired: boolean;
      manifestCid: string;
      config: Record<string, unknown>;
    };
    expect(body.ok).toBe(true);
    expect(body.restartRequired).toBe(true);
    expect(body.manifestCid).toBe('bafybeiaaa');

    const persisted = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(persisted.joinedSolverNets.bafybeiaaa).toEqual({
      manifestCid: 'bafybeiaaa',
      name: 'Prediction',
      roles: ['solver'],
      harness: 'claude-code-learner',
      model: 'claude-haiku-4-5-20251001',
      plugins: ['jinn-prediction-plugin'],
    });
    // Other top-level keys are preserved by persistTopLevelConfigValue.
    expect(persisted.network).toBe('testnet');
  });

  it('persists evaluator-only entries without harness/model/plugins', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jinn-operator-join-eval-'));
    const configPath = join(dir, 'config.json');
    writeConfig(configPath, {});

    const app = new Hono();
    addSetupRoutes(app, { configPath });

    const res = await app.request('/v1/operator/join/bafybeibbb', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Prediction',
        roles: ['evaluator'],
      }),
    });

    expect(res.status).toBe(200);
    const persisted = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(persisted.joinedSolverNets.bafybeibbb).toEqual({
      manifestCid: 'bafybeibbb',
      name: 'Prediction',
      roles: ['evaluator'],
    });
  });

  it('deduplicates roles in the canonical order', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jinn-operator-join-dedup-'));
    const configPath = join(dir, 'config.json');
    writeConfig(configPath, {});

    const app = new Hono();
    addSetupRoutes(app, { configPath });

    const res = await app.request('/v1/operator/join/bafybeiccc', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ roles: ['solver', 'evaluator', 'solver'] }),
    });

    expect(res.status).toBe(200);
    const persisted = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(persisted.joinedSolverNets.bafybeiccc.roles).toEqual(['solver', 'evaluator']);
  });

  it('rejects an empty roles array', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jinn-operator-join-empty-'));
    const configPath = join(dir, 'config.json');
    writeConfig(configPath, {});

    const app = new Hono();
    addSetupRoutes(app, { configPath });

    const res = await app.request('/v1/operator/join/bafybeiddd', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ roles: [] }),
    });

    expect(res.status).toBe(400);
  });

  it('rejects unknown role values', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jinn-operator-join-bad-role-'));
    const configPath = join(dir, 'config.json');
    writeConfig(configPath, {});

    const app = new Hono();
    addSetupRoutes(app, { configPath });

    const res = await app.request('/v1/operator/join/bafybeieee', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ roles: ['solver', 'launcher'] }),
    });

    expect(res.status).toBe(400);
  });

  it('rejects malformed JSON body', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jinn-operator-join-malformed-'));
    const configPath = join(dir, 'config.json');
    writeConfig(configPath, {});

    const app = new Hono();
    addSetupRoutes(app, { configPath });

    const res = await app.request('/v1/operator/join/bafybeifff', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not json',
    });

    expect(res.status).toBe(400);
  });

  it('overwrites an existing manifest-keyed entry on re-join', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jinn-operator-join-overwrite-'));
    const configPath = join(dir, 'config.json');
    writeConfig(configPath, {
      joinedSolverNets: {
        bafybeiggg: { manifestCid: 'bafybeiggg', roles: ['solver'] },
      },
    });

    const app = new Hono();
    addSetupRoutes(app, { configPath });

    const res = await app.request('/v1/operator/join/bafybeiggg', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ roles: ['solver', 'evaluator'] }),
    });

    expect(res.status).toBe(200);
    const persisted = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(persisted.joinedSolverNets.bafybeiggg.roles).toEqual(['solver', 'evaluator']);
  });
});

describe('DELETE /v1/operator/join/:cid', () => {
  const writeConfig = (path: string, body: unknown): void => {
    require('node:fs').writeFileSync(path, JSON.stringify(body, null, 2) + '\n');
  };

  it('removes the entry and returns 200', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jinn-operator-leave-'));
    const configPath = join(dir, 'config.json');
    writeConfig(configPath, {
      joinedSolverNets: {
        bafybeihhh: { manifestCid: 'bafybeihhh', roles: ['solver'] },
        bafybeiiii: { manifestCid: 'bafybeiiii', roles: ['evaluator'] },
      },
    });

    const app = new Hono();
    addSetupRoutes(app, { configPath });

    const res = await app.request('/v1/operator/join/bafybeihhh', {
      method: 'DELETE',
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; restartRequired: boolean };
    expect(body.ok).toBe(true);
    expect(body.restartRequired).toBe(true);

    const persisted = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(persisted.joinedSolverNets.bafybeihhh).toBeUndefined();
    // Other entries are preserved.
    expect(persisted.joinedSolverNets.bafybeiiii).toBeDefined();
  });

  it('returns 404 when the entry does not exist', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jinn-operator-leave-404-'));
    const configPath = join(dir, 'config.json');
    writeConfig(configPath, { joinedSolverNets: {} });

    const app = new Hono();
    addSetupRoutes(app, { configPath });

    const res = await app.request('/v1/operator/join/bafybeijjj', {
      method: 'DELETE',
    });

    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('join_not_found');
  });

  it('returns 404 when the config has no joinedSolverNets at all', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jinn-operator-leave-empty-'));
    const configPath = join(dir, 'config.json');
    writeConfig(configPath, { network: 'testnet' });

    const app = new Hono();
    addSetupRoutes(app, { configPath });

    const res = await app.request('/v1/operator/join/bafybeikkk', {
      method: 'DELETE',
    });

    expect(res.status).toBe(404);
  });
});
