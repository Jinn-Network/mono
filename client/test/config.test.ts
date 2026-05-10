import { mkdtemp, rm, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_TESTNET_SUBGRAPH_URL, loadConfig, buildConfigProvenance } from '../src/config.js';

describe('loadConfig RPC override handling', () => {
  const dirs: string[] = [];
  const originalBaseRpcUrl = process.env['BASE_RPC_URL'];
  const originalBaseSepoliaRpcUrl = process.env['BASE_SEPOLIA_RPC_URL'];
  const originalJinnRpcUrl = process.env['JINN_RPC_URL'];
  const originalJinnNetwork = process.env['JINN_NETWORK'];
  const originalJinnL2ProofRpcUrl = process.env['JINN_L2_PROOF_RPC_URL'];
  const originalJinnSubgraphUrl = process.env['JINN_SUBGRAPH_URL'];
  const originalTestnetL2Deployment = process.env['JINN_TESTNET_L2_DEPLOYMENT'];
  const originalTestnetTokenDeployment = process.env['JINN_TESTNET_TOKEN_DEPLOYMENT'];
  const originalOperatorDonationEnabled = process.env['JINN_OPERATOR_DONATION_ENABLED'];

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

    if (originalJinnL2ProofRpcUrl === undefined) {
      delete process.env['JINN_L2_PROOF_RPC_URL'];
    } else {
      process.env['JINN_L2_PROOF_RPC_URL'] = originalJinnL2ProofRpcUrl;
    }

    if (originalJinnSubgraphUrl === undefined) {
      delete process.env['JINN_SUBGRAPH_URL'];
    } else {
      process.env['JINN_SUBGRAPH_URL'] = originalJinnSubgraphUrl;
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

    if (originalOperatorDonationEnabled === undefined) {
      delete process.env['JINN_OPERATOR_DONATION_ENABLED'];
    } else {
      process.env['JINN_OPERATOR_DONATION_ENABLED'] = originalOperatorDonationEnabled;
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

  it('defaults testnet to the public task subgraph URL', async () => {
    const configPath = await writeConfigFile({ network: 'testnet' });
    delete process.env['JINN_SUBGRAPH_URL'];
    delete process.env['JINN_NETWORK'];

    const config = loadConfig(configPath);

    expect(config.subgraphUrl).toBe(DEFAULT_TESTNET_SUBGRAPH_URL);
  });

  it('does not default the testnet task subgraph on mainnet', async () => {
    const configPath = await writeConfigFile({ network: 'mainnet' });
    delete process.env['JINN_SUBGRAPH_URL'];
    delete process.env['JINN_NETWORK'];

    const config = loadConfig(configPath);

    expect(config.subgraphUrl).toBeUndefined();
  });

  it('lets JINN_SUBGRAPH_URL override the public task subgraph default', async () => {
    const configPath = await writeConfigFile({ network: 'testnet' });
    process.env['JINN_SUBGRAPH_URL'] = 'https://subgraph.override.example/graphql';
    delete process.env['JINN_NETWORK'];

    const config = loadConfig(configPath);

    expect(config.subgraphUrl).toBe('https://subgraph.override.example/graphql');
  });

  it('defaults operator donation to disabled when operator config exists', async () => {
    const configPath = await writeConfigFile({
      operator: { publicEndpoint: 'https://op.example.com' },
    });

    const config = loadConfig(configPath);

    expect(config.operator?.donation.enabled).toBe(false);
  });

  it('allows env to enable operator donation', async () => {
    const configPath = await writeConfigFile({
      operator: { publicEndpoint: 'https://op.example.com' },
    });
    process.env['JINN_OPERATOR_DONATION_ENABLED'] = 'true';

    const config = loadConfig(configPath);

    expect(config.operator?.donation.enabled).toBe(true);
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

  it('defaults tasks to an empty list', () => {
    return writeConfigFile({}).then((configPath) => {
      const config = loadConfig(configPath);
      expect(config.tasks).toEqual([]);
    });
  });

  it('preserves portfolio.v0 Task fields (window, spec, eligibility) through config parsing', async () => {
    const configPath = await writeConfigFile({
      network: 'testnet',
      tasks: [
        {
          id: 'portfolio-test-1',
          description: 'Achieve 5% equity return on Hyperliquid testnet.',
          solverType: 'portfolio.v0',
          window: { startTs: 1_700_000_000_000, endTs: 1_700_086_400_000 },
          spec: {
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
    const ds = config.tasks[0];

    expect(ds).toBeDefined();
    expect(ds!.id).toBe('portfolio-test-1');
    expect(ds!.window).toEqual({ startTs: 1_700_000_000_000, endTs: 1_700_086_400_000 });
    expect(ds!.solverType).toBe('portfolio.v0');
    expect(ds!.spec?.kind).toBeUndefined();
    expect(ds!.eligibility).toEqual({ minClosedTrades: 20, minTradedNotionalMultiple: 5.0 });
  });

  it('rejects partial L1 cross-chain config (distributor without ethereumRpcUrl)', async () => {
    const configPath = await writeConfigFile({
      network: 'testnet',
      jinnDistributorAddress: '0x1111111111111111111111111111111111111111',
      // ethereumRpcUrl intentionally missing
    });

    delete process.env['BASE_RPC_URL'];
    delete process.env['BASE_SEPOLIA_RPC_URL'];
    delete process.env['JINN_RPC_URL'];
    delete process.env['JINN_NETWORK'];
    delete process.env['JINN_ETHEREUM_RPC_URL'];

    let caught: any;
    try {
      loadConfig(configPath);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeDefined();
    expect(caught.code).toBe('config_invalid');
    const issues: Array<{ path: string; message: string }> = caught.details?.issues ?? [];
    const hit = issues.find((i) => i.path === 'ethereumRpcUrl');
    expect(hit).toBeDefined();
    expect(hit!.message).toMatch(/ethereumRpcUrl/);
  });

  it('accepts L1 cross-chain config when ethereumRpcUrl is set', async () => {
    const configPath = await writeConfigFile({
      network: 'testnet',
      jinnDistributorAddress: '0x1111111111111111111111111111111111111111',
      ethereumRpcUrl: 'https://sepolia.example/rpc',
      jinnL1Network: 'sepolia',
      jinnMessengerMode: 'mock',
    });

    delete process.env['BASE_RPC_URL'];
    delete process.env['BASE_SEPOLIA_RPC_URL'];
    delete process.env['JINN_RPC_URL'];
    delete process.env['JINN_NETWORK'];
    delete process.env['JINN_ETHEREUM_RPC_URL'];

    const config = loadConfig(configPath);
    expect(config.jinnDistributorAddress).toBe('0x1111111111111111111111111111111111111111');
    expect(config.ethereumRpcUrl).toBe('https://sepolia.example/rpc');
    expect(config.jinnL1Network).toBe('sepolia');
    expect(config.jinnMessengerMode).toBe('mock');
    expect(config.jinnClaimLoopIntervalMs).toBe(60 * 60 * 1000);
  });

  it('JINN_ETHEREUM_RPC_URL env var satisfies the L1 refine', async () => {
    const configPath = await writeConfigFile({
      network: 'testnet',
      jinnDistributorAddress: '0x1111111111111111111111111111111111111111',
    });

    delete process.env['BASE_RPC_URL'];
    delete process.env['BASE_SEPOLIA_RPC_URL'];
    delete process.env['JINN_RPC_URL'];
    delete process.env['JINN_NETWORK'];
    process.env['JINN_ETHEREUM_RPC_URL'] = 'https://sepolia.env.example/rpc';

    try {
      const config = loadConfig(configPath);
      expect(config.ethereumRpcUrl).toBe('https://sepolia.env.example/rpc');
    } finally {
      delete process.env['JINN_ETHEREUM_RPC_URL'];
    }
  });

  it('loads optional L2 proof RPC from env for canonical canaries', async () => {
    const configPath = await writeConfigFile({ network: 'testnet' });

    delete process.env['BASE_RPC_URL'];
    delete process.env['BASE_SEPOLIA_RPC_URL'];
    delete process.env['JINN_RPC_URL'];
    delete process.env['JINN_NETWORK'];
    process.env['JINN_L2_PROOF_RPC_URL'] = 'https://base-sepolia-proof.example/rpc';

    const config = loadConfig(configPath);
    expect(config.l2ProofRpcUrl).toBe('https://base-sepolia-proof.example/rpc');
  });

  it('rejects malformed jinnDistributorAddress', async () => {
    const configPath = await writeConfigFile({
      network: 'testnet',
      jinnDistributorAddress: 'not-an-address',
      ethereumRpcUrl: 'https://sepolia.example/rpc',
    });
    expect(() => loadConfig(configPath)).toThrow();
  });

  it('loads testnet artifact override paths from config and env', async () => {
    const configPath = await writeConfigFile({
      network: 'testnet',
      testnetL2DeploymentPath: '/tmp/from-file-l2.json',
      testnetL2TokenDeploymentPath: '/tmp/from-file-token.json',
    });

    process.env['JINN_TESTNET_L2_DEPLOYMENT'] = '/tmp/from-env-l2.json';
    process.env['JINN_TESTNET_TOKEN_DEPLOYMENT'] = '/tmp/from-env-token.json';
    delete process.env['BASE_RPC_URL'];
    delete process.env['BASE_SEPOLIA_RPC_URL'];
    delete process.env['JINN_RPC_URL'];
    delete process.env['JINN_NETWORK'];

    const config = loadConfig(configPath);

    expect(config.testnetL2DeploymentPath).toBe('/tmp/from-env-l2.json');
    expect(config.testnetL2TokenDeploymentPath).toBe('/tmp/from-env-token.json');
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

describe('loadConfig solverNets roles migration', () => {
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function writeConfigFile(contents: Record<string, unknown>): Promise<string> {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'jinn-config-'));
    dirs.push(dir);
    const configPath = path.join(dir, 'config.json');
    await writeFile(configPath, JSON.stringify(contents, null, 2));
    return configPath;
  }

  it('migrates a legacy `role: solving` field to `roles: [solving]`', async () => {
    const configPath = await writeConfigFile({
      network: 'testnet',
      rpcUrl: 'https://example/rpc',
      solverNets: {
        prediction: {
          enabled: true,
          solverType: 'prediction.v1',
          role: 'solving',
          harness: 'claude-code-learner',
          plugins: [],
        },
      },
    });
    const cfg = loadConfig(configPath);
    expect(cfg.solverNets['prediction']?.roles).toEqual(['solving']);
    expect(cfg.solverNets['prediction']?.harness).toBe('claude-code');
    // Loader output is the canonical shape — the singular `role` does not
    // re-appear after migration.
    expect((cfg.solverNets['prediction'] as Record<string, unknown>)?.['role']).toBeUndefined();
  });

  it('migrates a legacy `role: evaluating` field to `roles: [evaluating]`', async () => {
    const configPath = await writeConfigFile({
      network: 'testnet',
      rpcUrl: 'https://example/rpc',
      solverNets: {
        prediction: {
          enabled: true,
          solverType: 'prediction.v1',
          role: 'evaluating',
          harness: 'claude-code-learner',
          plugins: [],
        },
      },
    });
    const cfg = loadConfig(configPath);
    expect(cfg.solverNets['prediction']?.roles).toEqual(['evaluating']);
  });

  it('round-trips an explicit `roles: [solving]` config', async () => {
    const configPath = await writeConfigFile({
      network: 'testnet',
      rpcUrl: 'https://example/rpc',
      solverNets: {
        prediction: {
          enabled: true,
          solverType: 'prediction.v1',
          roles: ['solving'],
          harness: 'claude-code-learner',
          plugins: [],
        },
      },
    });
    const cfg = loadConfig(configPath);
    expect(cfg.solverNets['prediction']?.roles).toEqual(['solving']);
  });

  it('persists both roles when the operator opts into Solver and Evaluator', async () => {
    const configPath = await writeConfigFile({
      network: 'testnet',
      rpcUrl: 'https://example/rpc',
      solverNets: {
        prediction: {
          enabled: true,
          solverType: 'prediction.v1',
          roles: ['solving', 'evaluating'],
          harness: 'claude-code-learner',
          plugins: [],
        },
      },
    });
    const cfg = loadConfig(configPath);
    expect(cfg.solverNets['prediction']?.roles).toEqual(['solving', 'evaluating']);
  });

  it('prefers `roles` over a stale legacy `role` when both are present', async () => {
    const configPath = await writeConfigFile({
      network: 'testnet',
      rpcUrl: 'https://example/rpc',
      solverNets: {
        prediction: {
          enabled: true,
          solverType: 'prediction.v1',
          role: 'evaluating', // legacy stale field
          roles: ['solving'],
          harness: 'claude-code-learner',
          plugins: [],
        },
      },
    });
    const cfg = loadConfig(configPath);
    expect(cfg.solverNets['prediction']?.roles).toEqual(['solving']);
  });

  it('rejects an empty roles array', async () => {
    const configPath = await writeConfigFile({
      network: 'testnet',
      rpcUrl: 'https://example/rpc',
      solverNets: {
        prediction: {
          enabled: true,
          solverType: 'prediction.v1',
          roles: [],
          harness: 'claude-code-learner',
          plugins: [],
        },
      },
    });
    let captured: unknown;
    try {
      loadConfig(configPath);
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeDefined();
    // The loader wraps zod errors in ConfigLoadError with structured details;
    // assert that the underlying validation issue mentions the constraint
    // that we care about (the operator should see "at least one role").
    const issues = ((captured as { details?: { issues?: Array<{ message: string }> } }).details?.issues) ?? [];
    expect(issues.some((issue) => /at least one role/i.test(issue.message))).toBe(true);
  });

  it('deduplicates roles entries', async () => {
    const configPath = await writeConfigFile({
      network: 'testnet',
      rpcUrl: 'https://example/rpc',
      solverNets: {
        prediction: {
          enabled: true,
          solverType: 'prediction.v1',
          roles: ['solving', 'solving', 'evaluating'],
          harness: 'claude-code-learner',
          plugins: [],
        },
      },
    });
    const cfg = loadConfig(configPath);
    expect(cfg.solverNets['prediction']?.roles).toEqual(['solving', 'evaluating']);
  });

  it('default config has empty solverNets when the on-disk config omits the field', async () => {
    // Per Decision 5 of spec/2026-05-05-solvernet-creation-and-launch.md
    // (Task 22), the prediction default block was removed. Fresh installs
    // start with `solverNets: {}` and join SolverNets via the registry.
    // We point the loader at an empty config file so the assertion is
    // independent of any `~/.jinn-client/config.json` on the dev machine.
    const configPath = await writeConfigFile({ network: 'testnet' });
    const cfg = loadConfig(configPath);
    expect(cfg.solverNets).toEqual({});
  });
});

describe('config: legacy launching role removal', () => {
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function writeConfigFile(contents: Record<string, unknown>): Promise<string> {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'jinn-config-'));
    dirs.push(dir);
    const configPath = path.join(dir, 'config.json');
    await writeFile(configPath, JSON.stringify(contents, null, 2));
    return configPath;
  }

  it('strips legacy "launching" entries when paired with a valid role', async () => {
    // Task 22 of spec/2026-05-05-solvernet-creation-and-launch.md dropped
    // `'launching'` from the operator role enum. Configs that still carry
    // it alongside a valid role are accepted (with `'launching'` stripped)
    // so existing operator config files keep loading.
    const configPath = await writeConfigFile({
      network: 'testnet',
      rpcUrl: 'https://example/rpc',
      solverNets: {
        prediction: {
          enabled: true,
          solverType: 'prediction.v1',
          roles: ['solving', 'launching'],
          harness: 'claude-code-learner',
          model: 'claude-haiku-4-5-20251001',
          plugins: [],
        },
      },
    });
    const cfg = loadConfig(configPath);
    expect(cfg.solverNets['prediction']?.roles).toEqual(['solving']);
  });

  it('rejects roles: ["launching"] standalone (now invalid — leaves no roles)', async () => {
    const configPath = await writeConfigFile({
      network: 'testnet',
      rpcUrl: 'https://example/rpc',
      solverNets: {
        prediction: {
          enabled: true,
          solverType: 'prediction.v1',
          roles: ['launching'],
          harness: 'claude-code-learner',
          model: 'claude-haiku-4-5-20251001',
          plugins: [],
        },
      },
    });
    expect(() => loadConfig(configPath)).toThrow();
  });

  it('rejects empty roles array', async () => {
    const configPath = await writeConfigFile({
      network: 'testnet',
      rpcUrl: 'https://example/rpc',
      solverNets: {
        prediction: {
          enabled: true,
          solverType: 'prediction.v1',
          roles: [],
          harness: 'claude-code-learner',
          model: 'claude-haiku-4-5-20251001',
          plugins: [],
        },
      },
    });
    expect(() => loadConfig(configPath)).toThrow();
  });
});

describe('buildConfigProvenance', () => {
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function writeConfigFile(contents: Record<string, unknown>): Promise<string> {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'jinn-provenance-'));
    dirs.push(dir);
    const configPath = path.join(dir, 'config.json');
    await writeFile(configPath, JSON.stringify(contents, null, 2));
    return configPath;
  }

  it('returns configLoaded=true and configPath set when a config file is present', async () => {
    const configPath = await writeConfigFile({ network: 'testnet' });
    const config = loadConfig(configPath);
    const prov = buildConfigProvenance(configPath, config, {});
    expect(prov.configLoaded).toBe(true);
    expect(prov.configPath).toBe(configPath);
  });

  it('returns configLoaded=false and configPath=null when no config file exists', () => {
    const config = loadConfig();
    const nonExistentPath = path.join(os.tmpdir(), 'jinn-no-such-config-' + Date.now() + '.json');
    const prov = buildConfigProvenance(nonExistentPath, config, {});
    expect(prov.configLoaded).toBe(false);
    expect(prov.configPath).toBeNull();
  });

  it('surfaces env overrides by name with value "set"', async () => {
    const configPath = await writeConfigFile({ network: 'testnet' });
    const config = loadConfig(configPath);
    const prov = buildConfigProvenance(configPath, config, {
      JINN_RPC_URL: 'http://fake',
      JINN_EARNING_DIR: '/tmp/earning',
    });
    expect(prov.envOverrides['JINN_RPC_URL']).toBe('set');
    expect(prov.envOverrides['JINN_EARNING_DIR']).toBe('set');
  });

  it('does NOT include JINN_PASSWORD in envOverrides even when set', async () => {
    const configPath = await writeConfigFile({ network: 'testnet' });
    const config = loadConfig(configPath);
    const prov = buildConfigProvenance(configPath, config, {
      JINN_PASSWORD: 'super-secret',
      JINN_RPC_URL: 'http://fake',
    });
    expect('JINN_PASSWORD' in prov.envOverrides).toBe(false);
    expect(prov.envOverrides['JINN_RPC_URL']).toBe('set');
  });

  it('does not include unset env vars in envOverrides', async () => {
    const configPath = await writeConfigFile({ network: 'testnet' });
    const config = loadConfig(configPath);
    const prov = buildConfigProvenance(configPath, config, {});
    expect(Object.keys(prov.envOverrides)).toHaveLength(0);
  });

  it('reflects resolved network, earningDir, dbPath, runtimeMode', async () => {
    const configPath = await writeConfigFile({ network: 'mainnet' });
    const config = loadConfig(configPath);
    const prov = buildConfigProvenance(configPath, config, {});
    expect(prov.network).toBe('mainnet');
    expect(typeof prov.earningDir).toBe('string');
    expect(typeof prov.dbPath).toBe('string');
    expect(prov.runtimeMode).toBeNull(); // not set in config or env
  });
});

describe('harness.mode config field', () => {
  it('defaults harness.mode to "train"', () => {
    const config = loadConfig();
    expect(config.harness?.mode).toBe('train');
  });

  it('accepts harness.mode = "frozen"', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'jinn-config-'));
    const configPath = path.join(dir, 'config.json');
    await writeFile(configPath, JSON.stringify({ harness: { mode: 'frozen' } }, null, 2));
    const config = loadConfig(configPath);
    expect(config.harness?.mode).toBe('frozen');
    await rm(dir, { recursive: true, force: true });
  });

  it('rejects invalid harness.mode values', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'jinn-config-'));
    const configPath = path.join(dir, 'config.json');
    await writeFile(configPath, JSON.stringify({ harness: { mode: 'eval' } }, null, 2));
    expect(() => loadConfig(configPath)).toThrow();
    await rm(dir, { recursive: true, force: true });
  });
});

describe('operator config (jinn-mono-vy37.1.3)', () => {
  const dirs: string[] = [];
  const ENV_KEYS = [
    'JINN_OPERATOR_PUBLIC_ENDPOINT',
    'JINN_OPERATOR_DEFAULT_PRICE_USDC',
  ] as const;
  const saved: Record<string, string | undefined> = {};

  for (const k of ENV_KEYS) saved[k] = process.env[k];

  afterEach(async () => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function writeOpConfigFile(contents: Record<string, unknown>): Promise<string> {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'jinn-config-'));
    dirs.push(dir);
    const configPath = path.join(dir, 'config.json');
    await writeFile(configPath, JSON.stringify(contents, null, 2));
    return configPath;
  }

  it('parses operator block with defaults', async () => {
    for (const k of ENV_KEYS) delete process.env[k];
    const configPath = await writeOpConfigFile({
      operator: { publicEndpoint: 'https://op.example.com' },
    });
    const cfg = loadConfig(configPath);
    expect(cfg.operator?.publicEndpoint).toBe('https://op.example.com');
    expect(cfg.operator?.defaultPriceUsdc).toBe('0');
    expect(cfg.operator?.perArtifactTypePrice).toEqual({});
  });

  it('accepts donation-mode operator config without publicEndpoint', async () => {
    for (const k of ENV_KEYS) delete process.env[k];
    const configPath = await writeOpConfigFile({
      operator: { donation: { enabled: true } },
    });
    const cfg = loadConfig(configPath);
    expect(cfg.operator?.publicEndpoint).toBeUndefined();
    expect(cfg.operator?.defaultPriceUsdc).toBe('0');
    expect(cfg.operator?.donation.enabled).toBe(true);
  });

  it('honours per-artifact-type prices from the file', async () => {
    for (const k of ENV_KEYS) delete process.env[k];
    const configPath = await writeOpConfigFile({
      operator: {
        publicEndpoint: 'https://op.example.com',
        defaultPriceUsdc: '0.001',
        perArtifactTypePrice: { design_document: '0.5' },
      },
    });
    const cfg = loadConfig(configPath);
    expect(cfg.operator?.defaultPriceUsdc).toBe('0.001');
    expect(cfg.operator?.perArtifactTypePrice).toEqual({ design_document: '0.5' });
  });

  it('env JINN_OPERATOR_PUBLIC_ENDPOINT overrides file', async () => {
    for (const k of ENV_KEYS) delete process.env[k];
    const configPath = await writeOpConfigFile({
      operator: { publicEndpoint: 'https://from-file.example.com' },
    });
    process.env['JINN_OPERATOR_PUBLIC_ENDPOINT'] = 'https://from-env.example.com';
    const cfg = loadConfig(configPath);
    expect(cfg.operator?.publicEndpoint).toBe('https://from-env.example.com');
  });

  it('env JINN_OPERATOR_DEFAULT_PRICE_USDC overrides file', async () => {
    for (const k of ENV_KEYS) delete process.env[k];
    const configPath = await writeOpConfigFile({
      operator: {
        publicEndpoint: 'https://op.example.com',
        defaultPriceUsdc: '0.001',
      },
    });
    process.env['JINN_OPERATOR_DEFAULT_PRICE_USDC'] = '0.005';
    const cfg = loadConfig(configPath);
    expect(cfg.operator?.defaultPriceUsdc).toBe('0.005');
  });

  it('rejects malformed defaultPriceUsdc', async () => {
    for (const k of ENV_KEYS) delete process.env[k];
    const configPath = await writeOpConfigFile({
      operator: {
        publicEndpoint: 'https://op.example.com',
        defaultPriceUsdc: 'free',
      },
    });
    expect(() => loadConfig(configPath)).toThrow();
  });

  it('rejects non-URL publicEndpoint', async () => {
    for (const k of ENV_KEYS) delete process.env[k];
    const configPath = await writeOpConfigFile({
      operator: { publicEndpoint: 'not-a-url' },
    });
    expect(() => loadConfig(configPath)).toThrow();
  });
});

describe('capture config', () => {
  const dirs: string[] = [];
  const ENV_KEYS = [
    'JINN_CAPTURES_LLM_PROXY_ENABLED',
    'JINN_CAPTURES_LLM_PROXY_PORT',
  ] as const;
  const saved: Record<string, string | undefined> = {};

  for (const k of ENV_KEYS) saved[k] = process.env[k];

  afterEach(async () => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function writeCaptureConfigFile(contents: Record<string, unknown>): Promise<string> {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'jinn-config-'));
    dirs.push(dir);
    const configPath = path.join(dir, 'config.json');
    await writeFile(configPath, JSON.stringify(contents, null, 2));
    return configPath;
  }

  it('defaults the LLM proxy off', () => {
    for (const k of ENV_KEYS) delete process.env[k];
    const cfg = loadConfig();
    expect(cfg.captures.llmProxy).toEqual({ enabled: false, port: 7342 });
  });

  it('loads LLM proxy config from file', async () => {
    for (const k of ENV_KEYS) delete process.env[k];
    const configPath = await writeCaptureConfigFile({
      captures: { llmProxy: { enabled: true, port: 7450 } },
    });
    const cfg = loadConfig(configPath);
    expect(cfg.captures.llmProxy).toEqual({ enabled: true, port: 7450 });
  });

  it('overrides LLM proxy config from env', async () => {
    for (const k of ENV_KEYS) delete process.env[k];
    const configPath = await writeCaptureConfigFile({
      captures: { llmProxy: { enabled: false, port: 7450 } },
    });
    process.env['JINN_CAPTURES_LLM_PROXY_ENABLED'] = 'yes';
    process.env['JINN_CAPTURES_LLM_PROXY_PORT'] = '7451';
    const cfg = loadConfig(configPath);
    expect(cfg.captures.llmProxy).toEqual({ enabled: true, port: 7451 });
  });
});
