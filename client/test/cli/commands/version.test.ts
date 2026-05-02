import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import version from '../../../src/cli/commands/version.js';
import { loadConfig } from '../../../src/config.js';
import { getChainConfig } from '../../../src/earning/contracts.js';
import { makeCommandCtx } from '@test/cli.js';

function makeTempConfig(contents: Record<string, unknown> = {}): { configPath: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'jinn-version-config-'));
  const configDir = join(dir, '.jinn-client');
  mkdirSync(configDir, { recursive: true });
  const configPath = join(configDir, 'config.json');
  writeFileSync(configPath, JSON.stringify(contents), 'utf-8');
  return {
    configPath,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

describe('version command', () => {
  it('emits a JSON object with schemaVersion, client, protocol, network, tokens', async () => {
    const { configPath, cleanup } = makeTempConfig();
    try {
      const { ctx, writes } = makeCommandCtx({ argv: ['--config', configPath] });
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

      const config = loadConfig(configPath);
      const chain = config.network === 'testnet' ? 'base-sepolia' : 'base';
      const chainConfig = getChainConfig(chain, {
        testnetL2DeploymentPath: config.testnetL2DeploymentPath,
        testnetL2TokenDeploymentPath: config.testnetL2TokenDeploymentPath,
        testnetMechDeploymentPath: config.testnetMechDeploymentPath,
        testnetStolasDeploymentPath: config.testnetStolasDeploymentPath,
        testnetClaimRegistryDeploymentPath: config.testnetClaimRegistryDeploymentPath,
      });
      const bond = parsed.tokens.bond as { symbol: string; address: string; decimals: number };
      expect(bond.symbol).not.toMatch(/^0x/i);
      expect(bond.symbol).not.toBe(bond.address);
      expect(bond.symbol).toBe(chain === 'base' ? 'OLAS' : 'stOLAS');
      expect(bond.address.toLowerCase()).toBe(chainConfig.olasToken.toLowerCase());
      expect(bond.address).toMatch(/^0x[a-fA-F0-9]{40}$/);
    } finally {
      cleanup();
    }
  });

  it('exits 0 and writes nothing else on success', async () => {
    const { configPath, cleanup } = makeTempConfig();
    try {
      const { ctx, writes, exits } = makeCommandCtx({ argv: ['--config', configPath] });
      await version.run(ctx);
      expect(writes).toHaveLength(1);
      expect(exits).toEqual([]);
    } finally {
      cleanup();
    }
  });

  it('emits invalid_invocation for bad flags', async () => {
    const { ctx, writes, exits } = makeCommandCtx({ argv: ['--bogus'] });
    await version.run(ctx);
    const parsed = JSON.parse(writes[writes.length - 1]);
    expect(parsed.code).toBe('invalid_invocation');
    expect(exits).toEqual([11]);
  });

  it('resolves a non-unknown deployment digest for zero-config testnet operators', async () => {
    const { configPath, cleanup } = makeTempConfig({ network: 'testnet' });
    try {
      const { ctx, writes } = makeCommandCtx({ argv: ['--config', configPath] });
      await version.run(ctx);
      const parsed = JSON.parse(writes[0]);
      expect(parsed.network).toBe('testnet');
      expect(parsed.deployments.artifacts.length).toBeGreaterThan(0);
      expect(parsed.deployments.digest).not.toBe('unknown');
      expect(parsed.deployments.digest).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      cleanup();
    }
  });

  it('--human output starts with "Jinn client" and includes the commit line', async () => {
    const { configPath, cleanup } = makeTempConfig();
    try {
      const { ctx, writes } = makeCommandCtx({ argv: ['--config', configPath, '--human'] });
      await version.run(ctx);
      const out = writes.join('');
      expect(out.startsWith('Jinn client ')).toBe(true);
      expect(out).toMatch(/^Commit: /m);
      expect(out).toMatch(/^Deployments: /m);
      expect(out).toMatch(/^Tokens: /m);
    } finally {
      cleanup();
    }
  });
});
