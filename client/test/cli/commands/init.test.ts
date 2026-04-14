import { describe, expect, it } from 'vitest';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import init from '../../../src/cli/commands/init.js';
import type { CommandContext } from '../../../src/cli/command.js';

const KEYSTORE_FILE = 'master_keystore.json';

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
    env: { JINN_PASSWORD: 'testpw', JINN_EARNING_DIR: earningDir },
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

  it('is idempotent — second run returns the same master address', async () => {
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
});
