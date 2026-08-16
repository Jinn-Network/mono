import { beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../../src/config.js';
import { computeDeploymentDigest } from '../../src/cli/deployment-digest.js';

function loadTestnetConfig() {
  const prev = { ...process.env };
  // Isolate from the developer's real ~/.jinn-client/config.json.
  const tmp = mkdtempSync(join(tmpdir(), 'jinn-digest-home-'));
  const configDir = join(tmp, '.jinn-client');
  const configPath = join(configDir, 'config.json');
  mkdirSync(configDir, { recursive: true });
  writeFileSync(configPath, JSON.stringify({ network: 'testnet' }), 'utf-8');
  process.env.HOME = tmp;
  process.env.JINN_NETWORK = 'testnet';
  delete process.env.JINN_TESTNET_L2_DEPLOYMENT;
  delete process.env.JINN_TESTNET_TOKEN_DEPLOYMENT;
  delete process.env.JINN_TESTNET_MECH_DEPLOYMENT;
  delete process.env.JINN_TESTNET_STOLAS_DEPLOYMENT;
  try {
    return loadConfig(configPath);
  } finally {
    process.env = prev;
    rmSync(tmp, { recursive: true, force: true });
  }
}

describe('computeDeploymentDigest', () => {
  it('resolves bundled artifacts on testnet when no JINN_TESTNET_* env vars are set', () => {
    const config = loadTestnetConfig();
    expect(config.network).toBe('testnet');

    const { digest, artifacts } = computeDeploymentDigest(config);
    expect(artifacts.length).toBeGreaterThan(0);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    const names = artifacts.map((a) => a.name).sort();
    expect(names).toEqual(
      ['testnetL2', 'testnetL2Token', 'testnetMech', 'testnetStolas'].sort(),
    );
    for (const a of artifacts) {
      expect(a.path).toMatch(/deployments\//);
      expect(a.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('returns digest="unknown" when every candidate path is missing', () => {
    const config = loadTestnetConfig();
    const noPaths = {
      ...config,
      network: 'mainnet' as const,
      testnetL2DeploymentPath: undefined,
      testnetL2TokenDeploymentPath: undefined,
      testnetMechDeploymentPath: undefined,
      testnetStolasDeploymentPath: undefined,
    };
    const { digest, artifacts } = computeDeploymentDigest(noPaths);
    expect(digest).toBe('unknown');
    expect(artifacts).toEqual([]);
  });
});
