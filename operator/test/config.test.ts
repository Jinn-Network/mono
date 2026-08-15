import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_TESTNET_DISCOVERY_URL,
  DEFAULT_TESTNET_RPC_URLS,
  DEFAULT_MAINNET_RPC_URLS,
  loadConfig,
  buildConfigProvenance,
} from '../src/config.js';
import { phaseDTransitionUsageSnapshot } from '../src/compatibility/phase-d-transition-usage.js';

/**
 * Issue #911 — ≥5 distinct free RPC providers default per supported chain.
 * Structural invariants: every default list ships ≥5 distinct, parseable URLs,
 * with the no-auth publicnode endpoint pinned to slot 0 (the #835 slot-0 guard).
 */
describe('default RPC provider lists (#911)', () => {
  const assertChain = (list: readonly string[], slot0Substr?: string) => {
    expect(list.length).toBeGreaterThanOrEqual(5);
    expect(new Set(list).size).toBe(list.length); // distinct
    for (const u of list) {
      expect(new URL(u).host.length).toBeGreaterThan(0); // parseable
    }
    if (slot0Substr !== undefined) {
      expect(list[0]).toContain(slot0Substr);
    }
  };

  it('Base Sepolia (84532) ships ≥5 distinct free providers, publicnode at slot 0', () => {
    assertChain(DEFAULT_TESTNET_RPC_URLS, 'base-sepolia.publicnode.com');
  });

  it('Base mainnet (8453) ships ≥5 distinct free providers, mainnet.base.org at slot 0', () => {
    assertChain(DEFAULT_MAINNET_RPC_URLS, 'mainnet.base.org');
  });
});

describe('loadConfig RPC override handling', () => {
  const dirs: string[] = [];
  const originalBaseRpcUrl = process.env['BASE_RPC_URL'];
  const originalBaseSepoliaRpcUrl = process.env['BASE_SEPOLIA_RPC_URL'];
  const originalJinnRpcUrl = process.env['JINN_RPC_URL'];
  const originalJinnNetwork = process.env['JINN_NETWORK'];
  const originalJinnSubgraphUrl = process.env['JINN_SUBGRAPH_URL'];
  const originalJinnDiscoveryMode = process.env['JINN_DISCOVERY_MODE'];
  const originalJinnDiscoveryUrl = process.env['JINN_DISCOVERY_URL'];
  const originalJinnDiscoveryFallback = process.env['JINN_DISCOVERY_FALLBACK'];
  const originalJinnTaskDiscoveryAllowedTaskIds = process.env['JINN_TASK_DISCOVERY_ALLOWED_TASK_IDS'];
  const originalTestnetL2Deployment = process.env['JINN_TESTNET_L2_DEPLOYMENT'];
  const originalTestnetTokenDeployment = process.env['JINN_TESTNET_TOKEN_DEPLOYMENT'];
  const originalOperatorDonationEnabled = process.env['JINN_OPERATOR_DONATION_ENABLED'];
  const originalWatchdogAutoRestart = process.env['JINN_WATCHDOG_AUTO_RESTART'];
  const originalRewardClaimIntervalMs = process.env['JINN_REWARD_CLAIM_INTERVAL_MS'];

  afterEach(async () => {
    if (originalWatchdogAutoRestart === undefined) {
      delete process.env['JINN_WATCHDOG_AUTO_RESTART'];
    } else {
      process.env['JINN_WATCHDOG_AUTO_RESTART'] = originalWatchdogAutoRestart;
    }

    if (originalRewardClaimIntervalMs === undefined) {
      delete process.env['JINN_REWARD_CLAIM_INTERVAL_MS'];
    } else {
      process.env['JINN_REWARD_CLAIM_INTERVAL_MS'] = originalRewardClaimIntervalMs;
    }

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

    if (originalJinnTaskDiscoveryAllowedTaskIds === undefined) {
      delete process.env['JINN_TASK_DISCOVERY_ALLOWED_TASK_IDS'];
    } else {
      process.env['JINN_TASK_DISCOVERY_ALLOWED_TASK_IDS'] = originalJinnTaskDiscoveryAllowedTaskIds;
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

  it('parses JINN_TASK_DISCOVERY_ALLOWED_TASK_IDS for live gate task narrowing', async () => {
    const configPath = await writeConfigFile({ network: 'testnet' });

    process.env['JINN_TASK_DISCOVERY_ALLOWED_TASK_IDS'] = '4249, 4250 , ,4251';

    const config = loadConfig(configPath);

    expect(config.taskDiscoveryAllowedTaskIds).toEqual(['4249', '4250', '4251']);
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
    // #911: ≥5 distinct free providers, publicnode slot 0, base.org last.
    expect(config.rpcUrls.length).toBeGreaterThanOrEqual(5);
    expect(config.rpcUrls[0]).toBe('https://base-sepolia.publicnode.com');
    expect(config.rpcUrls[config.rpcUrls.length - 1]).toBe('https://sepolia.base.org');
    expect(config.rpcUrls).toEqual([...DEFAULT_TESTNET_RPC_URLS]);
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

  it('accepts archiveRpcUrl as an array (AC1)', async () => {
    const configPath = await writeConfigFile({
      network: 'testnet',
      rpcUrl: 'https://primary.example',
      archiveRpcUrl: ['https://archive-a.example', 'https://archive-b.example'],
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

  it('config-less first run defaults to testnet with the Ponder discovery default (#1239)', async () => {
    // Empty {} config file = no `network` key, which reproduces the config-less
    // first-run state (`merged.network === undefined`) deterministically, without
    // depending on ~/.jinn-client/config.json in CI. Regression for #1239.
    const configPath = await writeConfigFile({});
    delete process.env['JINN_NETWORK'];
    delete process.env['JINN_DISCOVERY_MODE'];
    delete process.env['JINN_DISCOVERY_URL'];
    delete process.env['BASE_RPC_URL'];
    delete process.env['BASE_SEPOLIA_RPC_URL'];
    delete process.env['JINN_RPC_URL'];

    const config = loadConfig(configPath);

    expect(config.network).toBe('testnet'); // AC1
    expect(config.discovery?.mode).toBe('http'); // AC2
    expect(config.discovery?.url).toBe(DEFAULT_TESTNET_DISCOVERY_URL); // AC2
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

  it('defaults faucet topup cap to 10 and cooldown to 24h (issue #560)', () => {
    delete process.env['JINN_FAUCET_DAILY_TOPUP_CAP'];
    delete process.env['JINN_FAUCET_TOPUP_COOLDOWN_MS'];
    const config = loadConfig();
    expect(config.faucetDailyTopupCap).toBe(10);
    expect(config.faucetTopupCooldownMs).toBe(24 * 60 * 60 * 1000);
  });

  // #2407 / spec §11: overturns the manual-claim-from-the-app rationale this
  // default previously carried (config.ts:97-99's prior comment) — that
  // premise leaves with the SPA per OPERATOR-APP-SPEC.md's 2026-08-04
  // amendment (§2.7): a manual claim action shipped and stays, but
  // off-by-default was silently costing operators money and contradicted
  // the spec's own §2.7 framing of rewards as collected automatically.
  it('defaults reward auto-claim to ON (600000ms) in standard staking mode', () => {
    delete process.env['JINN_REWARD_CLAIM_INTERVAL_MS'];
    const config = loadConfig();
    expect(config.rewardClaimIntervalMs).toBe(600_000);
  });

  it('respects an explicit opt-out via JINN_REWARD_CLAIM_INTERVAL_MS=0', () => {
    process.env['JINN_REWARD_CLAIM_INTERVAL_MS'] = '0';
    const config = loadConfig();
    expect(config.rewardClaimIntervalMs).toBe(0);
  });

  it('keeps reward auto-claim overridable to a different explicit interval', () => {
    process.env['JINN_REWARD_CLAIM_INTERVAL_MS'] = '900000';
    const config = loadConfig();
    expect(config.rewardClaimIntervalMs).toBe(900_000);
  });

  it('overrides faucet topup cap and cooldown from env (issue #560)', () => {
    process.env['JINN_FAUCET_DAILY_TOPUP_CAP'] = '3';
    process.env['JINN_FAUCET_TOPUP_COOLDOWN_MS'] = '60000';
    try {
      const config = loadConfig();
      expect(config.faucetDailyTopupCap).toBe(3);
      expect(config.faucetTopupCooldownMs).toBe(60000);
    } finally {
      delete process.env['JINN_FAUCET_DAILY_TOPUP_CAP'];
      delete process.env['JINN_FAUCET_TOPUP_COOLDOWN_MS'];
    }
  });

  it('rejects a non-positive faucet topup cap (issue #560)', async () => {
    const configPath = await writeConfigFile({ faucetDailyTopupCap: 0 });
    expect(() => loadConfig(configPath)).toThrow();
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

  it('defaults Base mainnet L2 RPC to the ≥5-provider free chain (#911)', async () => {
    const configPath = await writeConfigFile({ network: 'mainnet' });

    delete process.env['BASE_RPC_URL'];
    delete process.env['BASE_SEPOLIA_RPC_URL'];
    delete process.env['JINN_RPC_URL'];
    delete process.env['JINN_NETWORK'];

    const config = loadConfig(configPath);

    expect(config.rpcUrl).toBe('https://mainnet.base.org');
    expect(config.rpcUrls.length).toBeGreaterThanOrEqual(5);
    expect(config.rpcUrls).toEqual([...DEFAULT_MAINNET_RPC_URLS]);
  });

  it('defaults watchdogAutoRestart to false when unset', async () => {
    const configPath = await writeConfigFile({ network: 'testnet' });
    delete process.env['JINN_WATCHDOG_AUTO_RESTART'];

    const config = loadConfig(configPath);
    expect(config.watchdogAutoRestart).toBe(false);
  });

  it('enables watchdogAutoRestart from a truthy JINN_WATCHDOG_AUTO_RESTART env', async () => {
    const configPath = await writeConfigFile({ network: 'testnet' });
    process.env['JINN_WATCHDOG_AUTO_RESTART'] = '1';

    expect(loadConfig(configPath).watchdogAutoRestart).toBe(true);
  });

  it('treats falsy JINN_WATCHDOG_AUTO_RESTART values as off', async () => {
    for (const value of ['0', 'false', 'no']) {
      const configPath = await writeConfigFile({ network: 'testnet' });
      process.env['JINN_WATCHDOG_AUTO_RESTART'] = value;
      expect(loadConfig(configPath).watchdogAutoRestart).toBe(false);
    }
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
describe('loadConfig v1 SolverNet keys migrate into executionWiring', () => {
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

  it('migrates a v1 solverNets entry into executionWiring at load time', async () => {
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
    expect((cfg as unknown as Record<string, unknown>).solverNets).toBeUndefined();
    expect((cfg as unknown as Record<string, unknown>).joinedSolverNets).toBeUndefined();
    expect(cfg.executionWiring?.some((entry) => entry.workKind === 'prediction.v1')).toBe(true);
  });

  it('prefers joinedSolverNets over solverNets when both are present on a v1 file', async () => {
    const configPath = await writeConfigFile({
      network: 'testnet',
      solverNets: { prediction: { solverType: 'prediction.v1', roles: ['solving'] } },
      joinedSolverNets: {
        bafkreireal: {
          manifestCid: 'bafkreireal',
          name: 'real-net',
          roles: ['solver'],
          harness: 'claude-code',
          contract: { id: 'prediction', version: 'v1' },
          plugins: [],
        },
      },
    });
    const cfg = loadConfig(configPath);
    expect(cfg.executionWiring?.some((entry) => entry.workKind === 'prediction.v1')).toBe(true);
    expect((cfg as unknown as Record<string, unknown>).joinedSolverNets).toBeUndefined();
  });

  it('produces empty executionWiring when no v1 SolverNet block is on disk', async () => {
    const configPath = await writeConfigFile({ network: 'testnet' });
    const cfg = loadConfig(configPath);
    expect(cfg.executionWiring ?? []).toEqual([]);
  });

  it('persists the v2 rewrite and prunes retired SolverNet keys from disk', async () => {
    const configPath = await writeConfigFile({
      network: 'testnet',
      rpcUrl: 'https://example/rpc',
      solverNets: {
        prediction: {
          enabled: false,
          solverType: 'prediction.v1',
          harness: 'claude-code',
          plugins: [],
          taskGenerator: { enabled: true },
        },
      },
    });
    loadConfig(configPath);
    const onDisk = JSON.parse(await readFile(configPath, 'utf-8')) as Record<string, unknown>;
    expect(onDisk.solverNets).toBeUndefined();
    expect(onDisk.joinedSolverNets).toBeUndefined();
    expect(onDisk.configShapeVersion).toBe(2);
    expect(Array.isArray(onDisk.executionWiring)).toBe(true);
  });

  it('does not resurrect retired keys on a second load', async () => {
    const configPath = await writeConfigFile({
      network: 'testnet',
      rpcUrl: 'https://example/rpc',
      solverNets: { prediction: { solverType: 'prediction.v1', roles: ['solving'] } },
    });
    loadConfig(configPath);
    const afterFirst = await readFile(configPath, 'utf-8');
    loadConfig(configPath);
    const afterSecond = await readFile(configPath, 'utf-8');
    expect(afterSecond).toBe(afterFirst);
    const onDisk = JSON.parse(afterSecond) as Record<string, unknown>;
    expect(onDisk.solverNets).toBeUndefined();
    expect(onDisk.joinedSolverNets).toBeUndefined();
  });

  it('does not persist transient env overrides into the config file', async () => {
    const configPath = await writeConfigFile({
      network: 'testnet',
      rpcUrl: 'https://example/rpc',
      solverNets: { prediction: { solverType: 'prediction.v1', roles: ['solving'] } },
    });
    const prev = process.env['JINN_RPC_URL'];
    process.env['JINN_RPC_URL'] = 'https://env-injected/rpc';
    try {
      loadConfig(configPath);
    } finally {
      if (prev === undefined) delete process.env['JINN_RPC_URL'];
      else process.env['JINN_RPC_URL'] = prev;
    }
    const onDisk = JSON.parse(await readFile(configPath, 'utf-8')) as Record<string, unknown>;
    expect(onDisk.rpcUrl).toBe('https://example/rpc');
    expect(onDisk.solverNets).toBeUndefined();
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

describe('mineableTraces.share config field (mono#1714 single sharing consent)', () => {
  afterEach(() => {
    delete process.env['JINN_SHARE_CONSENT'];
    delete process.env['JINN_MINEABLE_PUBLISH_CONSENT'];
  });

  it('defaults to share: false (nothing leaves the machine)', () => {
    const config = loadConfig();
    expect(config.mineableTraces?.share).toBe(false);
  });

  it('accepts share: true from a config file', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'jinn-config-'));
    const configPath = path.join(dir, 'config.json');
    await writeFile(configPath, JSON.stringify({ mineableTraces: { share: true } }, null, 2));
    const config = loadConfig(configPath);
    expect(config.mineableTraces?.share).toBe(true);
    await rm(dir, { recursive: true, force: true });
  });

  it('rejects invalid share values', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'jinn-config-'));
    const configPath = path.join(dir, 'config.json');
    await writeFile(configPath, JSON.stringify({ mineableTraces: { share: 'yes' } }, null, 2));
    expect(() => loadConfig(configPath)).toThrow();
    await rm(dir, { recursive: true, force: true });
  });

  it('JINN_SHARE_CONSENT env var overrides the file', async () => {
    process.env['JINN_SHARE_CONSENT'] = 'true';
    const config = loadConfig();
    expect(config.mineableTraces?.share).toBe(true);
  });

  it('migrates legacy publishConsent: true to share', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'jinn-config-'));
    const configPath = path.join(dir, 'config.json');
    await writeFile(
      configPath,
      JSON.stringify({ mineableTraces: { consent: 'retain_local', publishConsent: true } }, null, 2),
    );
    const config = loadConfig(configPath);
    expect(config.mineableTraces?.share).toBe(true);
    await rm(dir, { recursive: true, force: true });
  });

  it('migrates legacy retain_local-only (publishConsent false) to share: false', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'jinn-config-'));
    const configPath = path.join(dir, 'config.json');
    await writeFile(
      configPath,
      JSON.stringify({ mineableTraces: { consent: 'retain_local', publishConsent: false } }, null, 2),
    );
    const config = loadConfig(configPath);
    expect(config.mineableTraces?.share).toBe(false);
    await rm(dir, { recursive: true, force: true });
  });

  it('migrates legacy JINN_MINEABLE_PUBLISH_CONSENT env to share', () => {
    process.env['JINN_MINEABLE_PUBLISH_CONSENT'] = '1';
    const config = loadConfig();
    expect(config.mineableTraces?.share).toBe(true);
  });
});

describe('harvest.sources config field (Task 9)', () => {
  afterEach(() => {
    delete process.env['JINN_HARVEST_SOURCES'];
  });

  it('defaults to ["commits"]', () => {
    const config = loadConfig();
    expect(config.harvest.sources).toEqual(['commits']);
  });

  it('accepts sources: ["commits", "sessions"] from a config file', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'jinn-config-'));
    const configPath = path.join(dir, 'config.json');
    await writeFile(configPath, JSON.stringify({ harvest: { sources: ['commits', 'sessions'] } }, null, 2));
    const config = loadConfig(configPath);
    expect(config.harvest.sources).toEqual(['commits', 'sessions']);
    await rm(dir, { recursive: true, force: true });
  });

  it('rejects invalid source values', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'jinn-config-'));
    const configPath = path.join(dir, 'config.json');
    await writeFile(configPath, JSON.stringify({ harvest: { sources: ['commits', 'bogus'] } }, null, 2));
    expect(() => loadConfig(configPath)).toThrow();
    await rm(dir, { recursive: true, force: true });
  });

  it('JINN_HARVEST_SOURCES env var overrides the file (comma-separated)', () => {
    process.env['JINN_HARVEST_SOURCES'] = 'commits,sessions';
    const config = loadConfig();
    expect(config.harvest.sources).toEqual(['commits', 'sessions']);
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
    'JINN_HERMES_BASE_URL',
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
      hermesBaseUrl: 'http://127.0.0.1:11434/v1',
    });
    const cfg = loadConfig(configPath);
    expect(cfg.hermesPath).toBe('/usr/local/bin/hermes');
    expect(cfg.hermesModel).toBe('anthropic/claude-opus-4.6');
    expect(cfg.hermesProvider).toBe('anthropic');
    expect(cfg.hermesBaseUrl).toBe('http://127.0.0.1:11434/v1');
  });

  it('env vars override hermes config values', async () => {
    const configPath = await writeConfigFile({ network: 'testnet' });
    process.env['JINN_HERMES_PATH'] = '/opt/hermes/bin/hermes';
    process.env['JINN_HERMES_BASE_URL'] = 'http://localhost:11434/v1';
    const cfg = loadConfig(configPath);
    expect(cfg.hermesPath).toBe('/opt/hermes/bin/hermes');
    expect(cfg.hermesBaseUrl).toBe('http://localhost:11434/v1');
  });

  it.each([
    ['http://2130706433:11434/v1', 'http://127.0.0.1:11434/v1'],
    ['http://127.0.0.1:11434\\@api.openai.com/v1', 'http://127.0.0.1:11434/@api.openai.com/v1'],
  ])('canonicalizes Hermes local provider base URL before use: %s', async (input, expected) => {
    const configPath = await writeConfigFile({
      network: 'testnet',
      hermesBaseUrl: input,
    });

    const cfg = loadConfig(configPath);

    expect(cfg.hermesBaseUrl).toBe(expected);
  });

  it.each([
    'https://api.openai.com/v1',
    'http://user:pass@127.0.0.1:11434/v1',
    'http://127.0.0.1:11434/v1?api_key=secret',
    'http://127.0.0.1:11434/v1#secret',
  ])('rejects unsafe Hermes local provider base URLs: %s', async (hermesBaseUrl) => {
    const configPath = await writeConfigFile({
      network: 'testnet',
      hermesBaseUrl,
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
      issue.path === 'hermesBaseUrl' && /must be a local/i.test(issue.message)
    )).toBe(true);
  });
});


describe('engine.knowledgeAutoload (#1393)', () => {
  const dirs: string[] = [];
  const originalEnv = process.env['JINN_ENGINE_KNOWLEDGE_AUTOLOAD'];

  afterEach(async () => {
    if (originalEnv === undefined) {
      delete process.env['JINN_ENGINE_KNOWLEDGE_AUTOLOAD'];
    } else {
      process.env['JINN_ENGINE_KNOWLEDGE_AUTOLOAD'] = originalEnv;
    }
    await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
    dirs.length = 0;
  });

  const writeConfig = async (body: Record<string, unknown>): Promise<string> => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'jinn-config-test-'));
    dirs.push(dir);
    const configPath = path.join(dir, 'config.json');
    await writeFile(configPath, JSON.stringify(body));
    return configPath;
  };

  it('defaults to true when neither file nor env sets it', async () => {
    delete process.env['JINN_ENGINE_KNOWLEDGE_AUTOLOAD'];
    const config = loadConfig(await writeConfig({}));
    expect(config.engine.knowledgeAutoload).toBe(true);
  });

  it('respects engine.knowledgeAutoload: false from the config file', async () => {
    delete process.env['JINN_ENGINE_KNOWLEDGE_AUTOLOAD'];
    const config = loadConfig(await writeConfig({ engine: { knowledgeAutoload: false } }));
    expect(config.engine.knowledgeAutoload).toBe(false);
  });

  it('JINN_ENGINE_KNOWLEDGE_AUTOLOAD=0 overrides a file-set true', async () => {
    process.env['JINN_ENGINE_KNOWLEDGE_AUTOLOAD'] = '0';
    const config = loadConfig(await writeConfig({ engine: { knowledgeAutoload: true } }));
    expect(config.engine.knowledgeAutoload).toBe(false);
  });

  it('JINN_ENGINE_KNOWLEDGE_AUTOLOAD=true enables it over a file-set false', async () => {
    process.env['JINN_ENGINE_KNOWLEDGE_AUTOLOAD'] = 'true';
    const config = loadConfig(await writeConfig({ engine: { knowledgeAutoload: false } }));
    expect(config.engine.knowledgeAutoload).toBe(true);
  });
});

describe('Phase D legacy wiring diagnostics', () => {
  it('records an accepted legacy wiring/model/plugin/credential configuration', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'jinn-config-phase-d-'));
    const configPath = path.join(directory, 'config.json');
    try {
      await writeFile(configPath, JSON.stringify({
        configShapeVersion: 2,
        dbPath: ':memory:',
        executionWiring: [{
          workKind: 'prediction.v1',
          harness: 'claude-code',
          model: 'claude-haiku-4-5-20251001',
          plugins: ['learner'],
          credentialRef: 'anthropic-default',
          isolationPolicy: 'process',
        }],
      }));
      const before = phaseDTransitionUsageSnapshot()
        .find((row) => row.signal === 'legacy-wiring-config-field')?.count ?? 0;
      loadConfig(configPath);
      const after = phaseDTransitionUsageSnapshot()
        .find((row) => row.signal === 'legacy-wiring-config-field')?.count ?? 0;
      expect(after).toBe(before);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
