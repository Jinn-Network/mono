import { describe, expect, it } from 'vitest';
import version from '../../../src/cli/commands/version.js';
import type { CommandContext } from '../../../src/cli/command.js';

function makeCtx(argv: string[] = []): { ctx: CommandContext; writes: string[]; exits: number[] } {
  const writes: string[] = [];
  const exits: number[] = [];
  const ctx: CommandContext = {
    argv,
    stdoutIsTty: false,
    writer: { write: (s: string) => { writes.push(s); return true; } },
    exit: (code: number) => { exits.push(code); },
    env: {},
  };
  return { ctx, writes, exits };
}

describe('version command', () => {
  it('emits a JSON object with schemaVersion, client, protocol, network, tokens', async () => {
    const { ctx, writes } = makeCtx();
    await version.run(ctx);
    expect(writes).toHaveLength(1);
    const parsed = JSON.parse(writes[0]);
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.client).toBeDefined();
    expect(parsed.client.version).toBeDefined();
    expect(parsed.protocol).toBeDefined();
    expect(parsed.protocol.specVersion).toBe(1);
    expect(parsed.network).toMatch(/^(testnet|mainnet)$/);
    expect(parsed.tokens).toBeDefined();
    expect(parsed.tokens.native).toBeDefined();
  });

  it('exits 0 and writes nothing else on success', async () => {
    const { ctx, writes, exits } = makeCtx();
    await version.run(ctx);
    expect(writes).toHaveLength(1);
    expect(exits).toEqual([]);
  });
});
