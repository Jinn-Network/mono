import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addSetupRoutes } from '../../src/api/setup-endpoints.js';
import { FleetStateStore } from '../../src/earning/store.js';
import { encryptMnemonic, generateMnemonic } from '../../src/earning/wallet.js';

describe('GET /v1/auth/claude', () => {
  it('returns a probe result with authenticated boolean and context', async () => {
    const app = new Hono();
    addSetupRoutes(app);
    const res = await app.request('/v1/auth/claude');
    expect(res.status).toBe(200);
    const body = await res.json() as { authenticated: boolean; context: string };
    expect(typeof body.authenticated).toBe('boolean');
    expect(typeof body.context).toBe('string');
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
