import { describe, expect, it } from 'vitest';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import init from '../../../src/cli/commands/init.js';
import type { CommandContext } from '../../../src/cli/command.js';

const KEYSTORE_FILE = 'master_keystore.json';
const STATE_FILE = 'earning_state.json';

function makeCtx(overrides: Partial<CommandContext> = {}): {
  ctx: CommandContext; writes: string[];
} {
  const writes: string[] = [];
  const earningDir = mkdtempSync(join(tmpdir(), 'jinn-init-test-'));
  const ctx: CommandContext = {
    argv: [],
    stdoutIsTty: false,
    writer: { write: (s: string) => { writes.push(s); return true; } },
    exit: () => { /* unused */ },
    // JINN_NETWORK=testnet isolates the chain picked by init from the
    // developer's real ~/.jinn-client/config.json if it exists.
    env: {
      JINN_PASSWORD: 'testpw',
      JINN_EARNING_DIR: earningDir,
      JINN_NETWORK: 'testnet',
    },
    ...overrides,
  };
  return { ctx, writes };
}

describe('init command', () => {
  it('creates a keystore and emits the master address', async () => {
    const { ctx, writes } = makeCtx();
    await init.run(ctx);
    const parsed = JSON.parse(writes[writes.length - 1]);
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.master).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(existsSync(join(ctx.env['JINN_EARNING_DIR']!, KEYSTORE_FILE))).toBe(true);
  });

  // Two scrypt-keyed mnemonic encrypt/decrypt rounds make this test slow
  // enough to flake at the default 5 s timeout on contended CI workers.
  it('is idempotent — second run returns the same master address', { timeout: 20_000 }, async () => {
    const { ctx: ctx1, writes: w1 } = makeCtx();
    await init.run(ctx1);
    const first = JSON.parse(w1[w1.length - 1]).master;

    // Reuse the same earning dir
    const { ctx: ctx2 } = makeCtx({ env: ctx1.env });
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
    const { ctx, writes } = makeCtx();
    await init.run(ctx);
    const parsed = JSON.parse(writes[writes.length - 1]);
    const stateFile = join(ctx.env['JINN_EARNING_DIR']!, STATE_FILE);
    expect(existsSync(stateFile)).toBe(true);
    const state = JSON.parse(readFileSync(stateFile, 'utf8'));
    expect(state.master_address).toBe(parsed.master);
    expect(state.chain).toBe('base-sepolia');
  });

  it('payload includes a next-step hint pointing at fund-requirements', async () => {
    const { ctx, writes } = makeCtx();
    await init.run(ctx);
    const parsed = JSON.parse(writes[writes.length - 1]);
    expect(parsed.nextStep?.cli).toBe('jinn fund-requirements');
    expect(typeof parsed.nextStep?.purpose).toBe('string');
  });

  it('--human output includes a backup warning', async () => {
    const { ctx, writes } = makeCtx({ argv: ['--human'] });
    await init.run(ctx);
    const out = writes.join('');
    expect(out).toMatch(/Next: jinn fund-requirements/);
    expect(out).toMatch(/Backup:/);
  });

  it('emits invalid_invocation for bad flags', async () => {
    const { ctx, writes } = makeCtx({ argv: ['--humna'] });
    const exits: number[] = [];
    ctx.exit = (code: number) => { exits.push(code); };
    await init.run(ctx);
    const parsed = JSON.parse(writes[writes.length - 1]);
    expect(parsed.code).toBe('invalid_invocation');
    expect(exits).toEqual([11]);
  });
});
