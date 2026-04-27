import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import auth from '../../../src/cli/commands/auth.js';
import { makeCommandCtx } from '@test/cli.js';

describe('auth command', () => {
  it('has name "auth" and a summary', () => {
    expect(auth.name).toBe('auth');
    expect(typeof auth.summary).toBe('string');
    expect(auth.summary.length).toBeGreaterThan(0);
  });

  it('emits invalid_invocation with exit 11 for bad flags', async () => {
    const { ctx, writes, exits } = makeCommandCtx({ argv: ['--bogus'] });
    await auth.run(ctx);
    const parsed = JSON.parse(writes[writes.length - 1]!);
    expect(parsed.code).toBe('invalid_invocation');
    expect(exits).toEqual([11]);
  });

  it('emits either a success result or invalid_invocation on non-TTY (no flags)', async () => {
    const { ctx, writes, exits } = makeCommandCtx({ tty: false });
    await auth.run(ctx);
    expect(writes.length).toBeGreaterThanOrEqual(1);
    const parsed = JSON.parse(writes[writes.length - 1]!);
    if (exits.length === 0) {
      // Authenticated: success result
      expect(parsed.schemaVersion).toBe(1);
      expect(typeof parsed.authenticated).toBe('boolean');
      expect(parsed.authenticated).toBe(true);
      expect(typeof parsed.context).toBe('string');
      expect(typeof parsed.detail).toBe('string');
    } else {
      // Not authenticated on non-TTY: invalid_invocation
      expect(parsed.code).toBe('invalid_invocation');
      expect(exits).toEqual([11]);
    }
  });

  it('persists a testnet rpcUrl when JINN_NETWORK=testnet and config is fresh', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jinn-auth-config-'));
    const configPath = join(dir, 'config.json');
    const prev = process.env.JINN_NETWORK;
    process.env.JINN_NETWORK = 'testnet';
    try {
      const { ctx } = makeCommandCtx({
        argv: ['--mode', 'bare', '--config', configPath],
        tty: false,
      });
      await auth.run(ctx);
      const persisted = JSON.parse(readFileSync(configPath, 'utf-8'));
      expect(persisted).toMatchObject({
        network: 'testnet',
        rpcUrl: 'https://sepolia.base.org',
        runtimeMode: 'bare',
      });
    } finally {
      if (prev === undefined) {
        delete process.env.JINN_NETWORK;
      } else {
        process.env.JINN_NETWORK = prev;
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
