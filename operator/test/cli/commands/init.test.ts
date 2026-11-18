import { describe, expect, it } from 'vitest';
import { closeSync, mkdtempSync, existsSync, openSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import init from '../../../src/cli/commands/init.js';
import { FleetStateStore } from '../../../src/earning/store.js';
import { decryptMnemonic } from '../../../src/earning/wallet.js';
import { makeCommandCtx } from '@test/cli.js';

const KEYSTORE_FILE = 'master_keystore.json';
const STATE_FILE = 'earning_state.json';

function makeInitCtx(overrides: { argv?: string[]; env?: Record<string, string> } = {}): {
  ctx: import('../../../src/cli/command.js').CommandContext; writes: string[];
} {
  // JINN_NETWORK=testnet isolates the chain picked by init from the
  // developer's real ~/.jinn-client/config.json if it exists.
  const earningDir = mkdtempSync(join(tmpdir(), 'jinn-init-test-'));
  const { ctx, writes } = makeCommandCtx({
    argv: overrides.argv,
    env: {
      JINN_PASSWORD: 'testpw',
      JINN_EARNING_DIR: earningDir,
      JINN_NETWORK: 'testnet',
      ...overrides.env,
    },
  });
  return { ctx, writes };
}

describe('init command', () => {
  it('creates a keystore and emits the master address', async () => {
    const { ctx, writes } = makeInitCtx();
    await init.run(ctx);
    const parsed = JSON.parse(writes[writes.length - 1]);
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.master).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(existsSync(join(ctx.env['JINN_EARNING_DIR']!, KEYSTORE_FILE))).toBe(true);
  });

  // Two scrypt-keyed mnemonic encrypt/decrypt rounds make this test slow
  // enough to flake at the default 5 s timeout on contended CI workers.
  it('is idempotent — second run returns the same master address', { timeout: 20_000 }, async () => {
    const { ctx: ctx1, writes: w1 } = makeInitCtx();
    await init.run(ctx1);
    const first = JSON.parse(w1[w1.length - 1]).master;

    // Reuse the same earning dir
    const { ctx: ctx2 } = makeInitCtx({ env: ctx1.env });
    const writes2: string[] = [];
    ctx2.writer.write = (s: string) => {
      writes2.push(s);
      return true;
    };
    await init.run(ctx2);
    const second = JSON.parse(writes2[writes2.length - 1]).master;
    expect(second).toBe(first);
  });

  it('writes earning_state.json with the same master_address as the keystore', async () => {
    const { readFileSync } = await import('node:fs');
    const { ctx, writes } = makeInitCtx();
    await init.run(ctx);
    const parsed = JSON.parse(writes[writes.length - 1]);
    const stateFile = join(ctx.env['JINN_EARNING_DIR']!, STATE_FILE);
    expect(existsSync(stateFile)).toBe(true);
    const state = JSON.parse(readFileSync(stateFile, 'utf8'));
    expect(state.master_address).toBe(parsed.master);
    expect(state.chain).toBe('base-sepolia');
  });

  it('payload includes a next-step hint pointing at fund-requirements', async () => {
    const { ctx, writes } = makeInitCtx();
    await init.run(ctx);
    const parsed = JSON.parse(writes[writes.length - 1]);
    expect(parsed.nextStep?.cli).toBe('jinn fund-requirements');
    expect(typeof parsed.nextStep?.purpose).toBe('string');
  });

  it('--human output includes a backup warning', async () => {
    const { ctx, writes } = makeInitCtx({ argv: ['--human'] });
    await init.run(ctx);
    const out = writes.join('');
    expect(out).toMatch(/Next: jinn fund-requirements/);
    expect(out).toMatch(/Backup:/);
  });

  it('emits invalid_invocation for bad flags', async () => {
    const { ctx, writes } = makeInitCtx({ argv: ['--humna'] });
    const exits: number[] = [];
    ctx.exit = (code: number) => { exits.push(code); };
    await init.run(ctx);
    const parsed = JSON.parse(writes[writes.length - 1]);
    expect(parsed.code).toBe('invalid_invocation');
    expect(exits).toEqual([11]);
  });

  // #5390: `jinn quickstart` and `jinn run` run init in their own process and hand it the
  // password they resolved in JINN_PASSWORD. A --password-fd on the outer command line is
  // theirs; init must not read it (the outer verb already drained it).
  it('run in-process, uses JINN_PASSWORD and not a --password-fd only the process argv carries', { timeout: 20_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jinn-init-fd-'));
    const fdPath = join(dir, 'fd-password');
    writeFileSync(fdPath, 'fd-secret\n', { mode: 0o600 });
    const fd = openSync(fdPath, 'r');
    const originalArgv = process.argv;
    process.argv = [originalArgv[0]!, 'jinn', 'quickstart', '--password-fd', String(fd)];
    try {
      const { ctx, writes } = makeInitCtx({ argv: ['--json'] });
      await init.run(ctx);
      expect(JSON.parse(writes[writes.length - 1]).master).toMatch(/^0x[0-9a-fA-F]{40}$/);
      const keystore = await new FleetStateStore(ctx.env['JINN_EARNING_DIR']!).loadMnemonicKeystore();
      await expect(decryptMnemonic(keystore, 'testpw')).resolves.toEqual(expect.any(String));
    } finally {
      process.argv = originalArgv;
      closeSync(fd);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
