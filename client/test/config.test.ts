import { mkdtemp, rm, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_TESTNET_DISCOVERY_URL,
  DEFAULT_TESTNET_ETHEREUM_RPC_URL,
  loadConfig,
  buildConfigProvenance,
} from '../src/config.js';

describe('loadConfig RPC override handling', () => {
  const dirs: string[] = [];
  const originalBaseRpcUrl = process.env['BASE_RPC_URL'];
  const originalBaseSepoliaRpcUrl = process.env['BASE_SEPOLIA_RPC_URL'];
  const originalJinnRpcUrl = process.env['JINN_RPC_URL'];
  const originalJinnNetwork = process.env['JINN_NETWORK'];
  const originalJinnL2ProofRpcUrl = process.env['JINN_L2_PROOF_RPC_URL'];
  const originalJinnSubgraphUrl = process.env['JINN_SUBGRAPH_URL'];
  const originalJinnDiscoveryMode = process.env['JINN_DISCOVERY_MODE'];
  const originalJinnDiscoveryUrl = process.env['JINN_DISCOVERY_URL'];
  const originalJinnDiscoveryFallback = process.env['JINN_DISCOVERY_FALLBACK'];
  const originalJinnEthereumRpcUrl = process.env['JINN_ETHEREUM_RPC_URL'];
  const originalJinnClaimSubmissionMode = process.env['JINN_CLAIM_SUBMISSION_MODE'];
  const originalJinnClaimLoopEnabled = process.env['JINN_CLAIM_LOOP_ENABLED'];
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

    if (originalJinnDiscoveryMode === undefined) {
      delete process.env['JINN_DISCOVERY_MODE'];
    } else {
      process.env['JINN_DISCOVERY_MODE'] = originalJinnDiscoveryMode;
    }

    if (originalJinnDiscoveryUrl === undefined) {
      delete process.env['JINN_DISCOVERY_URL'];
    } else {
      process.env['JINN_DISCOVERY_URL'] = originalJinnDiscoveryUrl;
    }

    if (originalJinnDiscoveryFallback === undefined) {
      delete process.env['JINN_DISCOVERY_FALLBACK'];
    } else {
      process.env['JINN_DISCOVERY_FALLBACK'] = originalJinnDiscoveryFallback;
    }

    if (originalJinnEthereumRpcUrl === undefined) {
      delete process.env['JINN_ETHEREUM_RPC_URL'];
    } else {
      process.env['JINN_ETHEREUM_RPC_URL'] = originalJinnEthereumRpcUrl;
    }

    if (originalJinnClaimSubmissionMode === undefined) {
      delete process.env['JINN_CLAIM_SUBMISSION_MODE'];
    } else {
      process.env['JINN_CLAIM_SUBMISSION_MODE'] = originalJinnClaimSubmissionMode;
    }

    if (originalJinnClaimLoopEnabled === undefined) {
      delete process.env['JINN_CLAIM_LOOP_ENABLED'];
    } else {
      process.env['JINN_CLAIM_LOOP_ENABLED'] = originalJinnClaimLoopEnabled;
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

    // Testnet default is publicnode — no-auth, no shared-key quota cliff.
    // History: briefly flipped to a Tenderly gateway in response to the
    // 2026-05-18 sepolia.base.org rate-limit churn, but Tenderly's shared
    // project key hit its plan quota on 2026-05-24 and every default-config
    // daemon got HTTP 403 simultaneously (dashboard "Runway 0d", faucet 500s,
    // daemon hot-loops). Publicnode avoids the shared-quota cliff and is
    // symmetric with DEFAULT_TESTNET_ETHEREUM_RPC_URL. Operators with heavy
    // workloads are still nudged to bring their own key via the
    // NetworkSection panel warning. See #554.
    expect(config.rpcUrl).toBe('https://base-sepolia-rpc.publicnode.com');
  });

  it('defaults testnet discovery to the privately-operated Ponder indexer (http mode)', async () => {
    const configPath = await writeConfigFile({ network: 'testnet' });
    delete process.env['JINN_SUBGRAPH_URL'];
    delete process.env['JINN_DISCOVERY_MODE'];
    delete process.env['JINN_DISCOVERY_URL'];
    delete process.env['JINN_NETWORK'];

    const config = loadConfig(configPath);

    expect(config.discovery?.mode).toBe('http');
    expect(config.discovery?.url).toBe(DEFAULT_TESTNET_DISCOVERY_URL);
    // fallbackToOnchain is no longer defaulted on testnet (2026-05-23): silent
    // fall-through hid indexer outages and storms shared RPC. Operators opt in
    // explicitly when they need it.
    expect(config.discovery?.fallbackToOnchain).toBeUndefined();
    // No legacy subgraphUrl default any more — the Railway indexer is the default.
    expect(config.subgraphUrl).toBeUndefined();
  });

  it('does not set a discovery or subgraph default on mainnet', async () => {
    const configPath = await writeConfigFile({ network: 'mainnet' });
    delete process.env['JINN_SUBGRAPH_URL'];
    delete process.env['JINN_DISCOVERY_MODE'];
    delete process.env['JINN_DISCOVERY_URL'];
    delete process.env['JINN_NETWORK'];

    const config = loadConfig(configPath);

    expect(config.subgraphUrl).toBeUndefined();
    expect(config.discovery?.mode).toBeUndefined();
  });

  it('JINN_DISCOVERY_URL alone on testnet → that URL with mode "http"; fallback undefined (default-off)', async () => {
    const configPath = await writeConfigFile({ network: 'testnet' });
    delete process.env['JINN_DISCOVERY_MODE'];
    delete process.env['JINN_DISCOVERY_FALLBACK'];
    delete process.env['JINN_NETWORK'];
    process.env['JINN_DISCOVERY_URL'] = 'https://my-indexer.example/graphql';

    const config = loadConfig(configPath);

    expect(config.discovery?.url).toBe('https://my-indexer.example/graphql');
    expect(config.discovery?.mode).toBe('http');
    // 2026-05-23: fallback is now opt-in. Operator never set it → undefined.
    expect(config.discovery?.fallbackToOnchain).toBeUndefined();
  });

  it('JINN_DISCOVERY_URL on mainnet → mode defaulted to "http" so the URL is consulted', async () => {
    const configPath = await writeConfigFile({ network: 'mainnet' });
    delete process.env['JINN_DISCOVERY_MODE'];
    delete process.env['JINN_DISCOVERY_FALLBACK'];
    delete process.env['JINN_NETWORK'];
    process.env['JINN_DISCOVERY_URL'] = 'https://mainnet-indexer.example/graphql';

    const config = loadConfig(configPath);

    expect(config.discovery?.url).toBe('https://mainnet-indexer.example/graphql');
    expect(config.discovery?.mode).toBe('http');
  });

  it('config-file discovery: { url } without mode on testnet → url preserved, mode defaulted to "http"; fallback undefined (default-off)', async () => {
    const configPath = await writeConfigFile({
      network: 'testnet',
      discovery: { url: 'https://operator-indexer.example/graphql' },
    });
    delete process.env['JINN_DISCOVERY_MODE'];
    delete process.env['JINN_DISCOVERY_URL'];
    delete process.env['JINN_DISCOVERY_FALLBACK'];
    delete process.env['JINN_NETWORK'];

    const config = loadConfig(configPath);

    expect(config.discovery?.url).toBe('https://operator-indexer.example/graphql');
    expect(config.discovery?.mode).toBe('http');
    // 2026-05-23: fallback is now opt-in. Operator never set it → undefined.
    expect(config.discovery?.fallbackToOnchain).toBeUndefined();
  });

  it('config-file discovery: { fallbackToOnchain: true } on testnet → operator opt-in preserved', async () => {
    const configPath = await writeConfigFile({
      network: 'testnet',
      discovery: { fallbackToOnchain: true },
    });
    delete process.env['JINN_DISCOVERY_MODE'];
    delete process.env['JINN_DISCOVERY_URL'];
    delete process.env['JINN_DISCOVERY_FALLBACK'];
    delete process.env['JINN_NETWORK'];

    const config = loadConfig(configPath);

    expect(config.discovery?.mode).toBe('http');
    expect(config.discovery?.url).toBe(DEFAULT_TESTNET_DISCOVERY_URL);
    // Explicit opt-in survives the testnet default merge.
    expect(config.discovery?.fallbackToOnchain).toBe(true);
  });

  it('JINN_DISCOVERY_FALLBACK=1 with JINN_DISCOVERY_URL turns the floor on', async () => {
    const configPath = await writeConfigFile({ network: 'testnet' });
    delete process.env['JINN_DISCOVERY_MODE'];
    delete process.env['JINN_NETWORK'];
    process.env['JINN_DISCOVERY_URL'] = 'https://my-indexer.example/graphql';
    process.env['JINN_DISCOVERY_FALLBACK'] = '1';

    const config = loadConfig(configPath);

    expect(config.discovery?.mode).toBe('http');
    expect(config.discovery?.url).toBe('https://my-indexer.example/graphql');
    // Env opt-in survives the new default-off behavior.
    expect(config.discovery?.fallbackToOnchain).toBe(true);
  });

  it('config-file discovery: { fallbackToOnchain: false } without mode → fallbackToOnchain stays false', async () => {
    const configPath = await writeConfigFile({
      network: 'testnet',
      discovery: { fallbackToOnchain: false },
    });
    delete process.env['JINN_DISCOVERY_MODE'];
    delete process.env['JINN_DISCOVERY_URL'];
    delete process.env['JINN_DISCOVERY_FALLBACK'];
    delete process.env['JINN_NETWORK'];

    const config = loadConfig(configPath);

    expect(config.discovery?.fallbackToOnchain).toBe(false);
    // mode still defaulted in, url still defaulted to the testnet indexer.
    expect(config.discovery?.mode).toBe('http');
    expect(config.discovery?.url).toBe(DEFAULT_TESTNET_DISCOVERY_URL);
  });

  it('JINN_DISCOVERY_FALLBACK=0 with JINN_DISCOVERY_URL disables the floor', async () => {
    const configPath = await writeConfigFile({ network: 'testnet' });
    delete process.env['JINN_DISCOVERY_MODE'];
    delete process.env['JINN_NETWORK'];
    process.env['JINN_DISCOVERY_URL'] = 'https://my-indexer.example/graphql';
    process.env['JINN_DISCOVERY_FALLBACK'] = '0';

    const config = loadConfig(configPath);

    expect(config.discovery?.mode).toBe('http');
    expect(config.discovery?.url).toBe('https://my-indexer.example/graphql');
    expect(config.discovery?.fallbackToOnchain).toBe(false);
  });

  it('surfaces JINN_DISCOVERY_* in config provenance envOverrides', async () => {
    const configPath = await writeConfigFile({ network: 'testnet' });
    delete process.env['JINN_DISCOVERY_MODE'];
    delete process.env['JINN_DISCOVERY_FALLBACK'];
    delete process.env['JINN_NETWORK'];
    process.env['JINN_DISCOVERY_URL'] = 'https://my-indexer.example/graphql';

    const config = loadConfig(configPath);
    const prov = buildConfigProvenance(configPath, config);

    expect(prov.envOverrides['JINN_DISCOVERY_URL']).toBe('set');
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

  it('defaults testnet L1 RPC and enables the claim loop in emit-only mode', async () => {
    const configPath = await writeConfigFile({ network: 'testnet' });

    delete process.env['BASE_RPC_URL'];
    delete process.env['BASE_SEPOLIA_RPC_URL'];
    delete process.env['JINN_RPC_URL'];
    delete process.env['JINN_NETWORK'];
    delete process.env['JINN_ETHEREUM_RPC_URL'];
    delete process.env['JINN_CLAIM_SUBMISSION_MODE'];
    delete process.env['JINN_CLAIM_LOOP_ENABLED'];

    const config = loadConfig(configPath);

    expect(config.ethereumRpcUrl).toBe(DEFAULT_TESTNET_ETHEREUM_RPC_URL);
    expect(config.jinnClaimSubmissionMode).toBe('emit-only');
    expect(config.jinnClaimLoopEnabled).toBe(true);
  });

  it('preserves an explicit testnet claim-loop opt-out', async () => {
    const configPath = await writeConfigFile({
      network: 'testnet',
      jinnClaimLoopEnabled: false,
    });

    delete process.env['JINN_NETWORK'];
    delete process.env['JINN_CLAIM_LOOP_ENABLED'];

    const config = loadConfig(configPath);

    expect(config.jinnClaimSubmissionMode).toBe('emit-only');
    expect(config.jinnClaimLoopEnabled).toBe(false);
  });

  it('does not default ethereumRpcUrl on mainnet', async () => {
    const configPath = await writeConfigFile({ network: 'mainnet' });

    delete process.env['JINN_NETWORK'];
    delete process.env['JINN_ETHEREUM_RPC_URL'];

    const config = loadConfig(configPath);

    expect(config.network).toBe('mainnet');
    expect(config.ethereumRpcUrl).toBeUndefined();
    expect(config.jinnClaimLoopEnabled).toBe(false);
  });

  it('loads claim submission mode and loop enabled gate from env', async () => {
    const configPath = await writeConfigFile({ network: 'testnet' });

    process.env['JINN_CLAIM_SUBMISSION_MODE'] = 'submit';
    process.env['JINN_CLAIM_LOOP_ENABLED'] = 'yes';

    const config = loadConfig(configPath);

    expect(config.jinnClaimSubmissionMode).toBe('submit');
    expect(config.jinnClaimLoopEnabled).toBe(true);
  });

  it('rejects mainnet partial L1 cross-chain config (distributor without ethereumRpcUrl)', async () => {
    const configPath = await writeConfigFile({
      network: 'mainnet',
      jinnClaimSubmissionMode: 'submit',
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

  it('does not require ethereumRpcUrl for emit-only config', async () => {
    const configPath = await writeConfigFile({
      network: 'mainnet',
      jinnClaimSubmissionMode: 'emit-only',
      jinnDistributorAddress: '0x1111111111111111111111111111111111111111',
    });

    delete process.env['JINN_NETWORK'];
    delete process.env['JINN_ETHEREUM_RPC_URL'];

    const config = loadConfig(configPath);

    expect(config.jinnClaimSubmissionMode).toBe('emit-only');
    expect(config.ethereumRpcUrl).toBeUndefined();
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

describe('spendCaps config', () => {
  it('accepts a per-credential spendCaps map', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'jinn-cfg-spend-'));
    const configPath = path.join(dir, 'config.json');
    await writeFile(configPath, JSON.stringify({ spendCaps: { 'anthropic:api-key': 20 } }));
    const cfg = loadConfig(configPath);
    expect(cfg.spendCaps).toEqual({ 'anthropic:api-key': 20 });
    await rm(dir, { recursive: true, force: true });
  });

  it('rejects a non-positive cap', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'jinn-cfg-spend-bad-'));
    const configPath = path.join(dir, 'config.json');
    await writeFile(configPath, JSON.stringify({ spendCaps: { 'anthropic:api-key': 0 } }));
    expect(() => loadConfig(configPath)).toThrow();
    await rm(dir, { recursive: true, force: true });
  });

  it('defaults spendCaps to undefined', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'jinn-cfg-spend-none-'));
    const configPath = path.join(dir, 'config.json');
    await writeFile(configPath, JSON.stringify({}));
    const cfg = loadConfig(configPath);
    expect(cfg.spendCaps).toBeUndefined();
    await rm(dir, { recursive: true, force: true });
  });
});

describe('hermes config keys', () => {
  const dirs: string[] = [];
  const HERMES_ENV_KEYS = [
    'JINN_HERMES_PATH',
    'JINN_HERMES_MODEL',
    'JINN_HERMES_PROVIDER',
    'JINN_HERMES_DOCTOR_TIMEOUT_MS',
  ] as const;
  const saved: Record<string, string | undefined> = {};
  for (const k of HERMES_ENV_KEYS) saved[k] = process.env[k];

  afterEach(async () => {
    for (const k of HERMES_ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function writeConfigFile(contents: Record<string, unknown>): Promise<string> {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'jinn-hermes-config-'));
    dirs.push(dir);
    const configPath = path.join(dir, 'config.json');
    await writeFile(configPath, JSON.stringify(contents, null, 2));
    return configPath;
  }

  it('loads hermesPath / hermesModel / hermesProvider from config file', async () => {
    const configPath = await writeConfigFile({
      network: 'testnet',
      hermesPath: '/usr/local/bin/hermes',
      hermesModel: 'anthropic/claude-opus-4.6',
      hermesProvider: 'anthropic',
    });
    const cfg = loadConfig(configPath);
    expect(cfg.hermesPath).toBe('/usr/local/bin/hermes');
    expect(cfg.hermesModel).toBe('anthropic/claude-opus-4.6');
    expect(cfg.hermesProvider).toBe('anthropic');
  });

  it('env vars override hermes config values', async () => {
    const configPath = await writeConfigFile({ network: 'testnet' });
    process.env['JINN_HERMES_PATH'] = '/opt/hermes/bin/hermes';
    const cfg = loadConfig(configPath);
    expect(cfg.hermesPath).toBe('/opt/hermes/bin/hermes');
  });
});

describe('codex local provider config keys', () => {
  const dirs: string[] = [];
  const CODEX_ENV_KEYS = [
    'JINN_CODEX_MODEL',
    'JINN_CODEX_BASE_URL',
  ] as const;
  const saved: Record<string, string | undefined> = {};
  for (const k of CODEX_ENV_KEYS) saved[k] = process.env[k];

  afterEach(async () => {
    for (const k of CODEX_ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function writeConfigFile(contents: Record<string, unknown>): Promise<string> {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'jinn-codex-config-'));
    dirs.push(dir);
    const configPath = path.join(dir, 'config.json');
    await writeFile(configPath, JSON.stringify(contents, null, 2));
    return configPath;
  }

  it('loads local Codex provider config from file', async () => {
    const configPath = await writeConfigFile({
      network: 'testnet',
      codexModel: 'llama3.1',
      codexBaseUrl: 'http://127.0.0.1:11434/v1',
    });

    const cfg = loadConfig(configPath);

    expect(cfg.codexModel).toBe('llama3.1');
    expect(cfg.codexBaseUrl).toBe('http://127.0.0.1:11434/v1');
  });

  it('env vars override Codex provider config values', async () => {
    const configPath = await writeConfigFile({
      network: 'testnet',
      codexModel: 'gpt-5.4-mini',
      codexBaseUrl: 'http://127.0.0.1:11434/v1',
    });
    process.env['JINN_CODEX_MODEL'] = 'qwen2.5-coder';
    process.env['JINN_CODEX_BASE_URL'] = 'http://localhost:1234/v1';

    const cfg = loadConfig(configPath);

    expect(cfg.codexModel).toBe('qwen2.5-coder');
    expect(cfg.codexBaseUrl).toBe('http://localhost:1234/v1');
  });

  it('rejects remote Codex provider base URLs', async () => {
    const configPath = await writeConfigFile({
      network: 'testnet',
      codexBaseUrl: 'https://api.openai.com/v1',
    });

    let caught: any;
    try {
      loadConfig(configPath);
    } catch (err) {
      caught = err;
    }
    expect(caught?.code).toBe('config_invalid');
    const issues: Array<{ path: string; message: string }> = caught.details?.issues ?? [];
    expect(issues.some((issue) =>
      issue.path === 'codexBaseUrl' && /must be a local/i.test(issue.message)
    )).toBe(true);
  });

  it('rejects credentials embedded in Codex provider base URLs', async () => {
    const configPath = await writeConfigFile({
      network: 'testnet',
      codexBaseUrl: 'http://user:pass@127.0.0.1:11434/v1',
    });

    let caught: any;
    try {
      loadConfig(configPath);
    } catch (err) {
      caught = err;
    }
    expect(caught?.code).toBe('config_invalid');
    const issues: Array<{ path: string; message: string }> = caught.details?.issues ?? [];
    expect(issues.some((issue) =>
      issue.path === 'codexBaseUrl' && /must be a local/i.test(issue.message)
    )).toBe(true);
  });
});
