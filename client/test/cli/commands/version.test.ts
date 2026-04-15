import { describe, expect, it } from 'vitest';
import version from '../../../src/cli/commands/version.js';
import type { CommandContext } from '../../../src/cli/command.js';
import { loadConfig } from '../../../src/config.js';
import { getChainConfig } from '../../../src/earning/contracts.js';

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

    const config = loadConfig();
    const chain = config.network === 'testnet' ? 'base-sepolia' : 'base';
    const chainConfig = getChainConfig(chain, {
      testnetL2DeploymentPath: config.testnetL2DeploymentPath,
      testnetL2TokenDeploymentPath: config.testnetL2TokenDeploymentPath,
      testnetMechDeploymentPath: config.testnetMechDeploymentPath,
      testnetStolasDeploymentPath: config.testnetStolasDeploymentPath,
    });
    const bond = parsed.tokens.bond as { symbol: string; address: string; decimals: number };
    expect(bond.symbol).not.toMatch(/^0x/i);
    expect(bond.symbol).not.toBe(bond.address);
    expect(bond.symbol).toBe(chain === 'base' ? 'OLAS' : 'stOLAS');
    expect(bond.address.toLowerCase()).toBe(chainConfig.olasToken.toLowerCase());
    expect(bond.address).toMatch(/^0x[a-fA-F0-9]{40}$/);
  });

  it('exits 0 and writes nothing else on success', async () => {
    const { ctx, writes, exits } = makeCtx();
    await version.run(ctx);
    expect(writes).toHaveLength(1);
    expect(exits).toEqual([]);
  });

  it('emits invalid_invocation for bad flags', async () => {
    const { ctx, writes, exits } = makeCtx(['--bogus']);
    await version.run(ctx);
    const parsed = JSON.parse(writes[writes.length - 1]);
    expect(parsed.code).toBe('invalid_invocation');
    expect(exits).toEqual([11]);
  });
});
