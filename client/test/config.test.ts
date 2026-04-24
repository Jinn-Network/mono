import { mkdtemp, rm, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('loadConfig RPC override handling', () => {
  const dirs: string[] = [];
  const originalBaseRpcUrl = process.env['BASE_RPC_URL'];
  const originalBaseSepoliaRpcUrl = process.env['BASE_SEPOLIA_RPC_URL'];
  const originalJinnRpcUrl = process.env['JINN_RPC_URL'];
  const originalJinnNetwork = process.env['JINN_NETWORK'];
  const originalTestnetL2Deployment = process.env['JINN_TESTNET_L2_DEPLOYMENT'];
  const originalTestnetTokenDeployment = process.env['JINN_TESTNET_TOKEN_DEPLOYMENT'];
  const originalTestnetClaimRegistryDeployment = process.env['JINN_TESTNET_CLAIM_REGISTRY_DEPLOYMENT'];

  afterEach(async () => {
    if (originalBaseRpcUrl === undefined) {
      delete process.env['BASE_RPC_URL'];
    } else {
      process.env['BASE_RPC_URL'] = originalBaseRpcUrl;
    }

    if (originalBaseSepoliaRpcUrl === undefined) {
      delete process.env['BASE_SEPOLIA_RPC_URL'];
    } else {
      process.env['BASE_SEPOLIA_RPC_URL'] = originalBaseSepoliaRpcUrl;
    }

    if (originalJinnRpcUrl === undefined) {
      delete process.env['JINN_RPC_URL'];
    } else {
      process.env['JINN_RPC_URL'] = originalJinnRpcUrl;
    }

    if (originalJinnNetwork === undefined) {
      delete process.env['JINN_NETWORK'];
    } else {
      process.env['JINN_NETWORK'] = originalJinnNetwork;
    }

    if (originalTestnetL2Deployment === undefined) {
      delete process.env['JINN_TESTNET_L2_DEPLOYMENT'];
    } else {
      process.env['JINN_TESTNET_L2_DEPLOYMENT'] = originalTestnetL2Deployment;
    }

    if (originalTestnetTokenDeployment === undefined) {
      delete process.env['JINN_TESTNET_TOKEN_DEPLOYMENT'];
    } else {
      process.env['JINN_TESTNET_TOKEN_DEPLOYMENT'] = originalTestnetTokenDeployment;
    }

    if (originalTestnetClaimRegistryDeployment === undefined) {
      delete process.env['JINN_TESTNET_CLAIM_REGISTRY_DEPLOYMENT'];
    } else {
      process.env['JINN_TESTNET_CLAIM_REGISTRY_DEPLOYMENT'] = originalTestnetClaimRegistryDeployment;
    }

    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function writeConfigFile(contents: Record<string, unknown>): Promise<string> {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'jinn-config-'));
    dirs.push(dir);

    const configPath = path.join(dir, 'config.json');
    await writeFile(configPath, JSON.stringify(contents, null, 2));

    return configPath;
  }

  it('does not let BASE_RPC_URL override an explicit testnet rpcUrl', async () => {
    const configPath = await writeConfigFile({
      network: 'testnet',
      rpcUrl: 'https://base-sepolia.file.example',
    });

    process.env['BASE_RPC_URL'] = 'https://base-mainnet.env.example';
    delete process.env['BASE_SEPOLIA_RPC_URL'];
    delete process.env['JINN_RPC_URL'];
    delete process.env['JINN_NETWORK'];

    const config = loadConfig(configPath);

    expect(config.network).toBe('testnet');
    expect(config.rpcUrl).toBe('https://base-sepolia.file.example');
  });

  it('uses BASE_SEPOLIA_RPC_URL for testnet without touching mainnet BASE_RPC_URL', async () => {
    const configPath = await writeConfigFile({
      network: 'testnet',
      rpcUrl: 'https://base-sepolia.file.example',
    });

    process.env['BASE_RPC_URL'] = 'https://base-mainnet.env.example';
    process.env['BASE_SEPOLIA_RPC_URL'] = 'https://base-sepolia.env.example';
    delete process.env['JINN_RPC_URL'];
    delete process.env['JINN_NETWORK'];

    const config = loadConfig(configPath);

    expect(config.network).toBe('testnet');
    expect(config.rpcUrl).toBe('https://base-sepolia.env.example');
  });

  it('keeps BASE_RPC_URL override for mainnet', async () => {
    const configPath = await writeConfigFile({
      network: 'mainnet',
      rpcUrl: 'https://base-mainnet.file.example',
    });

    process.env['BASE_RPC_URL'] = 'https://base-mainnet.env.example';
    delete process.env['BASE_SEPOLIA_RPC_URL'];
    delete process.env['JINN_RPC_URL'];
    delete process.env['JINN_NETWORK'];

    const config = loadConfig(configPath);

    expect(config.network).toBe('mainnet');
    expect(config.rpcUrl).toBe('https://base-mainnet.env.example');
  });

  it('lets JINN_RPC_URL override all network-specific rpc env vars', async () => {
    const configPath = await writeConfigFile({
      network: 'testnet',
      rpcUrl: 'https://base-sepolia.file.example',
    });

    process.env['BASE_RPC_URL'] = 'https://base-mainnet.env.example';
    process.env['BASE_SEPOLIA_RPC_URL'] = 'https://base-sepolia.env.example';
    process.env['JINN_RPC_URL'] = 'https://universal.env.example';
    delete process.env['JINN_NETWORK'];

    const config = loadConfig(configPath);

    expect(config.network).toBe('testnet');
    expect(config.rpcUrl).toBe('https://universal.env.example');
  });

  it('defaults stakingMode to standard', () => {
    const config = loadConfig();
    expect(config.stakingMode).toBe('standard');
  });

  it('defaults testnet to Base Sepolia rpcUrl', async () => {
    const configPath = await writeConfigFile({ network: 'testnet' });
    delete process.env['BASE_RPC_URL'];
    delete process.env['BASE_SEPOLIA_RPC_URL'];
    delete process.env['JINN_RPC_URL'];
    delete process.env['JINN_NETWORK'];

    const config = loadConfig(configPath);

    expect(config.rpcUrl).toBe('https://sepolia.base.org');
  });

  it('accepts self-bond stakingMode from env', () => {
    process.env['JINN_STAKING_MODE'] = 'self-bond';
    const config = loadConfig();
    expect(config.stakingMode).toBe('self-bond');
    delete process.env['JINN_STAKING_MODE'];
  });

  it('defaults targetServices to 1', () => {
    const config = loadConfig();
    expect(config.targetServices).toBe(1);
  });

  it('defaults desiredStates to an empty list', () => {
    return writeConfigFile({}).then((configPath) => {
      const config = loadConfig(configPath);
      expect(config.desiredStates).toEqual([]);
    });
  });

  it('preserves portfolio.v0 RestorationJob fields (window, spec, eligibility) through config parsing', async () => {
    const configPath = await writeConfigFile({
      network: 'testnet',
      desiredStates: [
        {
          id: 'portfolio-test-1',
          description: 'Achieve 5% equity return on Hyperliquid testnet.',
          window: { startTs: 1_700_000_000_000, endTs: 1_700_086_400_000 },
          spec: {
            kind: 'portfolio.v0',
            account: { venue: 'hyperliquid-testnet', masterAddress: '0xdeadbeef' },
            target: { metric: 'equity_return_pct', minReturnPct: 5 },
            constraint: { maxDrawdownPct: 10 },
          },
          eligibility: { minClosedTrades: 20, minTradedNotionalMultiple: 5.0 },
        },
      ],
    });

    delete process.env['BASE_RPC_URL'];
    delete process.env['BASE_SEPOLIA_RPC_URL'];
    delete process.env['JINN_RPC_URL'];
    delete process.env['JINN_NETWORK'];

    const config = loadConfig(configPath);
    const ds = config.desiredStates[0];

    expect(ds).toBeDefined();
    expect(ds!.id).toBe('portfolio-test-1');
    expect(ds!.window).toEqual({ startTs: 1_700_000_000_000, endTs: 1_700_086_400_000 });
    expect(ds!.spec).toMatchObject({ kind: 'portfolio.v0' });
    expect(ds!.eligibility).toEqual({ minClosedTrades: 20, minTradedNotionalMultiple: 5.0 });
  });

  it('loads testnet artifact override paths from config and env', async () => {
    const configPath = await writeConfigFile({
      network: 'testnet',
      testnetL2DeploymentPath: '/tmp/from-file-l2.json',
      testnetL2TokenDeploymentPath: '/tmp/from-file-token.json',
      testnetClaimRegistryDeploymentPath: '/tmp/from-file-claim-registry.json',
    });

    process.env['JINN_TESTNET_L2_DEPLOYMENT'] = '/tmp/from-env-l2.json';
    process.env['JINN_TESTNET_TOKEN_DEPLOYMENT'] = '/tmp/from-env-token.json';
    process.env['JINN_TESTNET_CLAIM_REGISTRY_DEPLOYMENT'] = '/tmp/from-env-claim-registry.json';
    delete process.env['BASE_RPC_URL'];
    delete process.env['BASE_SEPOLIA_RPC_URL'];
    delete process.env['JINN_RPC_URL'];
    delete process.env['JINN_NETWORK'];

    const config = loadConfig(configPath);

    expect(config.testnetL2DeploymentPath).toBe('/tmp/from-env-l2.json');
    expect(config.testnetL2TokenDeploymentPath).toBe('/tmp/from-env-token.json');
    expect(config.testnetClaimRegistryDeploymentPath).toBe('/tmp/from-env-claim-registry.json');
  });

  it('identityRegistryAddress is undefined by default', () => {
    const config = loadConfig();
    expect(config.identityRegistryAddress).toBeUndefined();
  });

  it('validationRegistryAddress is undefined by default', () => {
    const config = loadConfig();
    expect(config.validationRegistryAddress).toBeUndefined();
  });

  it('accepts identityRegistryAddress from config file', async () => {
    const configPath = await writeConfigFile({
      identityRegistryAddress: '0x1234567890abcdef1234567890abcdef12345678',
    });
    const config = loadConfig(configPath);
    expect(config.identityRegistryAddress).toBe('0x1234567890abcdef1234567890abcdef12345678');
  });

  it('accepts validationRegistryAddress from config file', async () => {
    const configPath = await writeConfigFile({
      validationRegistryAddress: '0xabcdef1234567890abcdef1234567890abcdef12',
    });
    const config = loadConfig(configPath);
    expect(config.validationRegistryAddress).toBe('0xabcdef1234567890abcdef1234567890abcdef12');
  });

  it('reads identityRegistryAddress from env var', () => {
    process.env['JINN_IDENTITY_REGISTRY_ADDRESS'] = '0xaabbccdd00000000000000000000000000000001';
    try {
      const config = loadConfig();
      expect(config.identityRegistryAddress).toBe('0xaabbccdd00000000000000000000000000000001');
    } finally {
      delete process.env['JINN_IDENTITY_REGISTRY_ADDRESS'];
    }
  });

  it('reads validationRegistryAddress from env var', () => {
    process.env['JINN_VALIDATION_REGISTRY_ADDRESS'] = '0xaabbccdd00000000000000000000000000000002';
    try {
      const config = loadConfig();
      expect(config.validationRegistryAddress).toBe('0xaabbccdd00000000000000000000000000000002');
    } finally {
      delete process.env['JINN_VALIDATION_REGISTRY_ADDRESS'];
    }
  });

  it('reputationEnabled defaults to false', () => {
    const config = loadConfig();
    expect(config.reputationEnabled).toBe(false);
  });

  it('accepts reputationEnabled=true from env var', () => {
    process.env['JINN_REPUTATION_ENABLED'] = '1';
    try {
      const config = loadConfig();
      expect(config.reputationEnabled).toBe(true);
    } finally {
      delete process.env['JINN_REPUTATION_ENABLED'];
    }
  });
});
