import { mkdtemp, rm, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_TESTNET_DISCOVERY_URL,
  DEFAULT_TESTNET_ETHEREUM_RPC_URL,
  loadConfig,
  buildConfigProvenance,
  migrateLegacySolverNets,
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

  it('defaults testnet to Base Sepolia rpcUrl chain (AC2)', async () => {
    const configPath = await writeConfigFile({ network: 'testnet' });
    delete process.env['BASE_RPC_URL'];
    delete process.env['BASE_SEPOLIA_RPC_URL'];
    delete process.env['JINN_RPC_URL'];
    delete process.env['JINN_NETWORK'];

    const config = loadConfig(configPath);

    // AC2 (issue #592): testnet default is a two-provider fallback chain.
    // Publicnode is no-auth, no shared-key quota cliff (avoids the Tenderly
    // shared-quota cliff of 2026-05-24 that took out every default-config
    // daemon at once). sepolia.base.org sits at slot 2 as a free backup.
    // `config.rpcUrl` is the head URL for display continuity; `config.rpcUrls`
    // is the full chain used by buildFallbackTransport().
    expect(config.rpcUrl).toBe('https://base-sepolia.publicnode.com');
    expect(config.rpcUrls).toEqual([
      'https://base-sepolia.publicnode.com',
      'https://sepolia.base.org',
    ]);
  });

  it('accepts rpcUrl as an array in the config file (AC1)', async () => {
    const configPath = await writeConfigFile({
      network: 'testnet',
      rpcUrl: ['https://a.example', 'https://b.example'],
    });
    delete process.env['BASE_RPC_URL'];
    delete process.env['BASE_SEPOLIA_RPC_URL'];
    delete process.env['JINN_RPC_URL'];
    delete process.env['JINN_NETWORK'];

    const config = loadConfig(configPath);

    expect(config.rpcUrl).toBe('https://a.example');
    expect(config.rpcUrls).toEqual(['https://a.example', 'https://b.example']);
  });

  it('keeps a single-string rpcUrl as a one-element rpcUrls array (AC1 back-compat)', async () => {
    const configPath = await writeConfigFile({
      network: 'testnet',
      rpcUrl: 'https://a.example',
    });
    delete process.env['BASE_RPC_URL'];
    delete process.env['BASE_SEPOLIA_RPC_URL'];
    delete process.env['JINN_RPC_URL'];
    delete process.env['JINN_NETWORK'];

    const config = loadConfig(configPath);

    expect(config.rpcUrl).toBe('https://a.example');
    expect(config.rpcUrls).toEqual(['https://a.example']);
  });

  it('splits JINN_RPC_URL on commas (AC1)', async () => {
    const configPath = await writeConfigFile({ network: 'testnet' });
    delete process.env['BASE_RPC_URL'];
    delete process.env['BASE_SEPOLIA_RPC_URL'];
    delete process.env['JINN_NETWORK'];
    process.env['JINN_RPC_URL'] = 'https://a.example, https://b.example';

    const config = loadConfig(configPath);

    expect(config.rpcUrl).toBe('https://a.example');
    expect(config.rpcUrls).toEqual(['https://a.example', 'https://b.example']);
  });

  it('splits BASE_SEPOLIA_RPC_URL on commas on testnet (AC5)', async () => {
    const configPath = await writeConfigFile({ network: 'testnet' });
    delete process.env['BASE_RPC_URL'];
    delete process.env['JINN_RPC_URL'];
    delete process.env['JINN_NETWORK'];
    process.env['BASE_SEPOLIA_RPC_URL'] = 'https://a.example,https://b.example';

    const config = loadConfig(configPath);

    expect(config.rpcUrls.length).toBe(2);
    expect(config.rpcUrls[0]).toBe('https://a.example');
    expect(config.rpcUrls[1]).toBe('https://b.example');
  });

  it('accepts ethereumRpcUrl as a comma-separated env var (AC1)', async () => {
    const configPath = await writeConfigFile({ network: 'testnet' });
    delete process.env['BASE_RPC_URL'];
    delete process.env['BASE_SEPOLIA_RPC_URL'];
    delete process.env['JINN_RPC_URL'];
    delete process.env['JINN_NETWORK'];
    process.env['JINN_ETHEREUM_RPC_URL'] = 'https://x.example,https://y.example';

    const config = loadConfig(configPath);

    expect(config.ethereumRpcUrl).toBe('https://x.example');
    expect(config.ethereumRpcUrls).toEqual(['https://x.example', 'https://y.example']);

    delete process.env['JINN_ETHEREUM_RPC_URL'];
  });

  it('accepts archiveRpcUrl and l2ProofRpcUrl as arrays (AC1)', async () => {
    const configPath = await writeConfigFile({
      network: 'testnet',
      rpcUrl: 'https://primary.example',
      archiveRpcUrl: ['https://archive-a.example', 'https://archive-b.example'],
      l2ProofRpcUrl: ['https://proof-a.example', 'https://proof-b.example'],
    });
    delete process.env['BASE_RPC_URL'];
    delete process.env['BASE_SEPOLIA_RPC_URL'];
    delete process.env['JINN_RPC_URL'];
    delete process.env['JINN_NETWORK'];

    const config = loadConfig(configPath);

    expect(config.archiveRpcUrl).toBe('https://archive-a.example');
    expect(config.archiveRpcUrls).toEqual([
      'https://archive-a.example',
      'https://archive-b.example',
    ]);
    expect(config.l2ProofRpcUrl).toBe('https://proof-a.example');
    expect(config.l2ProofRpcUrls).toEqual([
      'https://proof-a.example',
      'https://proof-b.example',
    ]);
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
describe('loadConfig legacy solverNets migration via loader', () => {
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

  it('migrates a legacy solverNets entry into joinedSolverNets at load time', async () => {
    const configPath = await writeConfigFile({
      network: 'testnet',
      rpcUrl: 'https://example/rpc',
      solverNets: {
        prediction: {
          enabled: true,
          solverType: 'prediction.v1',
          roles: ['solving'],
          harness: 'claude-code',
          plugins: [],
        },
      },
    });
    const cfg = loadConfig(configPath);
    // The validated config has no `solverNets` field at all.
    expect((cfg as unknown as Record<string, unknown>).solverNets).toBeUndefined();
    expect(cfg.joinedSolverNets).toEqual({
      'legacy:prediction': {
        manifestCid: 'legacy:prediction',
        name: 'prediction',
        contract: { id: 'prediction', version: 'v1' },
        roles: ['solver'],
        harness: 'claude-code',
        plugins: [],
        disabledDefaultPlugins: [],
      },
    });
  });

  it('preserves an explicit joinedSolverNets entry when legacy and joined are both present', async () => {
    const configPath = await writeConfigFile({
      network: 'testnet',
      solverNets: { prediction: { solverType: 'prediction.v1', roles: ['solving'] } },
      joinedSolverNets: {
        bafkreireal: {
          manifestCid: 'bafkreireal',
          name: 'real-net',
          roles: ['solver'],
          plugins: [],
          disabledDefaultPlugins: [],
        },
      },
    });
    const cfg = loadConfig(configPath);
    expect(Object.keys(cfg.joinedSolverNets ?? {})).toEqual(
      expect.arrayContaining(['bafkreireal', 'legacy:prediction']),
    );
  });

  it('produces an empty joinedSolverNets when no legacy block is on disk', async () => {
    const configPath = await writeConfigFile({ network: 'testnet' });
    const cfg = loadConfig(configPath);
    expect(cfg.joinedSolverNets ?? {}).toEqual({});
  });

  it('migrates the dual-role legacy shape to roles: [solver, evaluator]', async () => {
    const configPath = await writeConfigFile({
      network: 'testnet',
      solverNets: {
        'swe-rebench-v2': {
          solverType: 'swe-rebench-v2.v1',
          roles: ['solving', 'evaluating'],
          harness: 'hermes-agent',
          model: 'minimax-m2.7',
          plugins: ['bundled:swe-rebench-v2-runtime'],
        },
      },
    });
    const cfg = loadConfig(configPath);
    expect(cfg.joinedSolverNets?.['legacy:swe-rebench-v2']).toEqual({
      manifestCid: 'legacy:swe-rebench-v2',
      name: 'swe-rebench-v2',
      contract: { id: 'swe-rebench-v2', version: 'v1' },
      roles: ['solver', 'evaluator'],
      harness: 'hermes-agent',
      model: 'minimax-m2.7',
      plugins: ['bundled:swe-rebench-v2-runtime'],
      disabledDefaultPlugins: [],
    });
  });

  it('strips legacy "launching" role on migration', async () => {
    const configPath = await writeConfigFile({
      network: 'testnet',
      solverNets: {
        prediction: {
          solverType: 'prediction.v1',
          roles: ['solving', 'launching'],
        },
      },
    });
    const cfg = loadConfig(configPath);
    expect(cfg.joinedSolverNets?.['legacy:prediction']?.roles).toEqual(['solver']);
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

describe('migrateLegacySolverNets', () => {
  it('migrates a single legacy solverNets entry into joinedSolverNets keyed by `legacy:<name>`', () => {
    const raw: Record<string, unknown> = {
      solverNets: {
        prediction: {
          enabled: true,
          solverType: 'prediction.v1',
          roles: ['solving'],
          harness: 'claude-code',
          plugins: [],
          taskGenerator: { enabled: true },
        },
      },
    };
    const migrated = migrateLegacySolverNets(raw);
    expect(migrated).toBe(1);
    expect(raw.solverNets).toBeUndefined();
    expect(raw.joinedSolverNets).toEqual({
      'legacy:prediction': {
        manifestCid: 'legacy:prediction',
        name: 'prediction',
        contract: { id: 'prediction', version: 'v1' },
        roles: ['solver'],
        harness: 'claude-code',
        plugins: [],
        disabledDefaultPlugins: [],
      },
    });
  });

  it('returns 0 and does not mutate when no legacy block exists', () => {
    const raw: Record<string, unknown> = { joinedSolverNets: { existing: { manifestCid: 'cid1', roles: ['solver'] } } };
    const before = JSON.stringify(raw);
    expect(migrateLegacySolverNets(raw)).toBe(0);
    expect(JSON.stringify(raw)).toBe(before);
  });

  it('maps the legacy "evaluating" role to "evaluator"', () => {
    const raw: Record<string, unknown> = {
      solverNets: {
        'swe-rebench-v2': {
          enabled: true,
          solverType: 'swe-rebench-v2.v1',
          roles: ['solving', 'evaluating'],
          harness: 'hermes-agent',
          model: 'minimax-m2.7',
          plugins: ['bundled:swe-rebench-v2-runtime'],
        },
      },
    };
    expect(migrateLegacySolverNets(raw)).toBe(1);
    expect(raw.joinedSolverNets).toEqual({
      'legacy:swe-rebench-v2': {
        manifestCid: 'legacy:swe-rebench-v2',
        name: 'swe-rebench-v2',
        contract: { id: 'swe-rebench-v2', version: 'v1' },
        roles: ['solver', 'evaluator'],
        harness: 'hermes-agent',
        model: 'minimax-m2.7',
        plugins: ['bundled:swe-rebench-v2-runtime'],
        disabledDefaultPlugins: [],
      },
    });
  });

  it('preserves a pre-existing joinedSolverNets entry under the same synthetic key (does not overwrite)', () => {
    const raw: Record<string, unknown> = {
      solverNets: {
        prediction: { solverType: 'prediction.v1', roles: ['solving'], harness: 'claude-code' },
      },
      joinedSolverNets: {
        'legacy:prediction': {
          manifestCid: 'legacy:prediction',
          name: 'preserved',
          roles: ['solver'],
        },
      },
    };
    migrateLegacySolverNets(raw);
    // The pre-existing entry wins; the legacy block does not clobber it.
    expect((raw.joinedSolverNets as Record<string, { name: string }>)['legacy:prediction'].name).toBe('preserved');
  });

  it('handles an empty solverNets object as a no-op migration (no entries to convert)', () => {
    const raw: Record<string, unknown> = { solverNets: {} };
    expect(migrateLegacySolverNets(raw)).toBe(0);
    expect(raw.solverNets).toBeUndefined();
    expect(raw.joinedSolverNets).toBeUndefined();
  });

  it('defaults roles to ["solver"] when the legacy entry has no roles field', () => {
    const raw: Record<string, unknown> = {
      solverNets: { prediction: { solverType: 'prediction.v1', harness: 'claude-code' } },
    };
    migrateLegacySolverNets(raw);
    expect((raw.joinedSolverNets as Record<string, { roles: string[] }>)['legacy:prediction'].roles).toEqual(['solver']);
  });

  it('drops legacy "launching" roles during migration (operator config no longer carries them)', () => {
    const raw: Record<string, unknown> = {
      solverNets: { prediction: { solverType: 'prediction.v1', roles: ['solving', 'launching'] } },
    };
    migrateLegacySolverNets(raw);
    expect((raw.joinedSolverNets as Record<string, { roles: string[] }>)['legacy:prediction'].roles).toEqual(['solver']);
  });

  it('falls back to id=<name>, version="v1" when solverType is malformed', () => {
    const raw: Record<string, unknown> = {
      solverNets: { 'broken-net': { solverType: 'no-dot-version', roles: ['solving'] } },
    };
    migrateLegacySolverNets(raw);
    expect((raw.joinedSolverNets as Record<string, { contract: unknown }>)['legacy:broken-net'].contract)
      .toEqual({ id: 'broken-net', version: 'v1' });
  });
});
