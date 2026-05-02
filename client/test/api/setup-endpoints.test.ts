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
  });

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
  });
});

describe('POST /v1/setup/drip', () => {
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
});
