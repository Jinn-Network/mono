import { describe, expect, it } from 'vitest';
import version from '../../../src/cli/commands/version.js';
import { loadConfig } from '../../../src/config.js';
import { getChainConfig } from '../../../src/earning/contracts.js';
import { makeCommandCtx } from '@test/cli.js';

describe('version command', () => {
  it('emits a JSON object with schemaVersion, client, protocol, network, tokens', async () => {
    const { ctx, writes } = makeCommandCtx();
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
    const { ctx, writes, exits } = makeCommandCtx();
    await version.run(ctx);
    expect(writes).toHaveLength(1);
    expect(exits).toEqual([]);
  });

  it('emits invalid_invocation for bad flags', async () => {
    const { ctx, writes, exits } = makeCommandCtx({ argv: ['--bogus'] });
    await version.run(ctx);
    const parsed = JSON.parse(writes[writes.length - 1]);
    expect(parsed.code).toBe('invalid_invocation');
    expect(exits).toEqual([11]);
  });

  it('resolves a non-unknown deployment digest for zero-config testnet operators', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const prev = { ...process.env };
    const tmp = mkdtempSync(join(tmpdir(), 'jinn-version-home-'));
    process.env.HOME = tmp;
    process.env.JINN_NETWORK = 'testnet';
    try {
      const { ctx, writes } = makeCommandCtx();
      await version.run(ctx);
      const parsed = JSON.parse(writes[0]);
      expect(parsed.network).toBe('testnet');
      expect(parsed.deployments.artifacts.length).toBeGreaterThan(0);
      expect(parsed.deployments.digest).not.toBe('unknown');
      expect(parsed.deployments.digest).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      process.env = prev;
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('--human output starts with "Jinn client" and includes the commit line', async () => {
    const { ctx, writes } = makeCommandCtx({ argv: ['--human'] });
    await version.run(ctx);
    const out = writes.join('');
    expect(out.startsWith('Jinn client ')).toBe(true);
    expect(out).toMatch(/^Commit: /m);
    expect(out).toMatch(/^Deployments: /m);
    expect(out).toMatch(/^Tokens: /m);
  });
});
