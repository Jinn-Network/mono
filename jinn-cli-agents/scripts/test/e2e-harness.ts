#!/usr/bin/env npx tsx
/**
 * E2E Test Harness — VNet Lifecycle CLI
 *
 * Manages Tenderly Virtual TestNets for end-to-end testing of jinn-node.
 *
 * Commands:
 *   create              Create a new VNet, output admin RPC URL
 *   fund <addr>         Fund address with ETH + OLAS
 *   mine [n]            Mine n blocks (default 1)
 *   time-warp <seconds> Advance time + mine a block
 *   checkpoint          Call checkpoint() on staking contract (fund OLAS if needed)
 *   seed-activity       Set Safe nonce + marketplace delivery count for activity check
 *   seed-acl <dir>      Seed credential bridge ACL with all agent addresses from .operate/keys/
 *   preflight           Hard E2E gate (Node22+nvm, local stack, GitHub token, ACL, stale requests)
 *   cleanup             Delete all stale e2e-test-* VNets
 *   status              Check VNet health + quota status
 *
 * Usage:
 *   yarn test:e2e:vnet create
 *   yarn test:e2e:vnet fund 0x1234... --eth 0.1 --olas 20
 *   yarn test:e2e:vnet time-warp 259200    # 72 hours
 *   yarn test:e2e:vnet checkpoint --staking 0x0dfa... --key 0xabc...
 *   yarn test:e2e:vnet seed-activity 0xSafe... --staking 0x0dfa... --value 1000
 *   yarn test:e2e:vnet status
 */

import dotenv from 'dotenv';
import { execSync } from 'child_process';
import { promises as fs } from 'fs';
import { resolve } from 'path';
import { createTenderlyClient, ethToWei } from '../lib/tenderly.js';

const MONOREPO_ROOT = resolve(import.meta.dirname, '..', '..');
const E2E_ENV_FILE = resolve(MONOREPO_ROOT, '.env.e2e');
const E2E_ACL_FILE = resolve(MONOREPO_ROOT, '.env.e2e.acl.json');
const LOCAL_PONDER_GRAPHQL_URL = 'http://localhost:42069/graphql';
const LOCAL_CONTROL_GRAPHQL_URL = 'http://localhost:4001/graphql';
const LOCAL_GATEWAY_HEALTH_URL = 'http://localhost:3001/health';

// Load env files in priority order (later overrides earlier):
// 1. .env — base monorepo creds (Supabase, etc.)
// 2. .env.test — Tenderly creds
// 3. .env.e2e — VNet RPC_URL from "vnet create" (highest priority)
dotenv.config({ path: resolve(MONOREPO_ROOT, '.env'), quiet: true });
dotenv.config({ path: resolve(MONOREPO_ROOT, '.env.test'), override: true, quiet: true });
dotenv.config({ path: E2E_ENV_FILE, override: true, quiet: true });
const OLAS_TOKEN_ADDRESS = '0x54330d28ca3357F294334BDC454a032e7f353416';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function parseArgs(args: string[]): { positional: string[]; flags: Record<string, string> } {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      const [key, val] = args[i].split('=');
      if (val !== undefined) {
        flags[key.slice(2)] = val;
      } else if (i + 1 < args.length && !args[i + 1].startsWith('--')) {
        flags[key.slice(2)] = args[++i];
      } else {
        flags[key.slice(2)] = 'true';
      }
    } else {
      positional.push(args[i]);
    }
  }
  return { positional, flags };
}

async function getRpcUrl(flags: Record<string, string>): Promise<string> {
  if (flags['rpc-url']) return flags['rpc-url'];
  if (process.env.RPC_URL) return process.env.RPC_URL;

  try {
    const envContent = await fs.readFile(E2E_ENV_FILE, 'utf-8');
    const match = envContent.match(/^RPC_URL=(.+)$/m);
    if (match) return match[1].trim();
  } catch { /* .env.e2e doesn't exist yet */ }

  throw new Error('No RPC URL found. Pass --rpc-url, set RPC_URL env, or run "create" first.');
}

async function rpcCall(rpcUrl: string, method: string, params: unknown[] = []): Promise<any> {
  const resp = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`RPC ${method} failed: HTTP ${resp.status} — ${text}`);
  }
  const json = await resp.json();
  if (json.error) throw new Error(`RPC ${method} error: ${JSON.stringify(json.error)}`);
  return json.result;
}

/**
 * Write .env.e2e from scratch (not append). Each `create` starts a clean session.
 */
async function writeEnvE2e(vars: Record<string, string>): Promise<void> {
  const lines = Object.entries(vars).map(([k, v]) => `${k}=${v}`);
  await fs.writeFile(E2E_ENV_FILE, lines.join('\n') + '\n');
}

async function readEnvE2eVar(key: string): Promise<string | undefined> {
  try {
    const envContent = await fs.readFile(E2E_ENV_FILE, 'utf-8');
    const match = envContent.match(new RegExp(`^${key}=(.+)$`, 'm'));
    if (match) return match[1].trim();
  } catch {
    // Ignore if file doesn't exist.
  }
  return undefined;
}

function normalizeAddress(address: string): string {
  const lower = address.toLowerCase();
  return lower.startsWith('0x') ? lower : `0x${lower}`;
}

function assertNode22ViaNvm(): void {
  const major = Number(process.versions.node.split('.')[0] || '0');
  if (major !== 22) {
    throw new Error(`Node 22 is required for E2E preflight. Current: ${process.version}`);
  }
  if (!process.env.NVM_BIN) {
    throw new Error('nvm must be active (NVM_BIN is missing). Run: nvm use');
  }
  console.log(`Node runtime: ${process.version} (nvm active)`);
}

async function postGraphql(
  url: string,
  query: string,
  variables?: Record<string, unknown>,
): Promise<any> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`${url} returned HTTP ${response.status}: ${body.slice(0, 240)}`);
  }
  const json = await response.json();
  if (Array.isArray(json?.errors) && json.errors.length > 0) {
    throw new Error(`${url} GraphQL errors: ${JSON.stringify(json.errors).slice(0, 240)}`);
  }
  return json;
}

async function assertGraphqlHealthy(name: string, url: string, query: string): Promise<void> {
  const result = await postGraphql(url, query);
  if (!result?.data) {
    throw new Error(`${name} health check returned no data`);
  }
  console.log(`${name} health: OK (${url})`);
}

async function assertHttpHealthy(name: string, url: string): Promise<void> {
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`${name} health failed: HTTP ${response.status} ${body.slice(0, 240)}`);
  }
  console.log(`${name} health: OK (${url})`);
}

async function assertGithubTokenValid(): Promise<void> {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    throw new Error('GITHUB_TOKEN is not set');
  }
  const response = await fetch('https://api.github.com/user', {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'jinn-e2e-preflight',
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (response.status !== 200) {
    const body = await response.text();
    throw new Error(`GITHUB_TOKEN validation failed: HTTP ${response.status} ${body.slice(0, 240)}`);
  }
  const json = await response.json();
  const login = typeof json?.login === 'string' ? json.login : '(unknown)';
  console.log(`GitHub token check: OK (user=${login})`);
}

async function discoverAgentEoas(cloneDir: string): Promise<string[]> {
  const servicesDir = resolve(cloneDir, '.operate', 'services');
  const addresses = new Set<string>();
  let serviceDirs: string[];
  try {
    serviceDirs = (await fs.readdir(servicesDir, { withFileTypes: true }))
      .filter(d => d.isDirectory())
      .map(d => d.name);
  } catch {
    throw new Error(`Cannot read ${servicesDir} — run setup first.`);
  }

  for (const dir of serviceDirs) {
    try {
      const configPath = resolve(servicesDir, dir, 'config.json');
      const config = JSON.parse(await fs.readFile(configPath, 'utf-8'));
      const chainConfigs = config?.chain_configs;
      if (!chainConfigs || typeof chainConfigs !== 'object') continue;
      for (const chainConfig of Object.values(chainConfigs) as any[]) {
        const instances = chainConfig?.chain_data?.instances;
        if (Array.isArray(instances) && instances.length > 0 && typeof instances[0] === 'string') {
          addresses.add(normalizeAddress(instances[0]));
        }
      }
    } catch {
      // Skip malformed service configs.
    }
  }

  const result = Array.from(addresses);
  if (result.length === 0) {
    throw new Error(`No agent EOAs discovered in ${servicesDir}`);
  }
  return result;
}

async function assertAclSeededForAgents(cloneDir: string): Promise<string[]> {
  const agentEoas = await discoverAgentEoas(cloneDir);
  let acl: { grants?: Record<string, any> };
  try {
    acl = JSON.parse(await fs.readFile(E2E_ACL_FILE, 'utf-8'));
  } catch {
    throw new Error(`ACL file missing or invalid: ${E2E_ACL_FILE}. Run: yarn test:e2e:vnet seed-acl "${cloneDir}"`);
  }

  const grants = acl.grants || {};
  const grantsByAddress = new Map<string, any>();
  for (const [address, value] of Object.entries(grants)) {
    grantsByAddress.set(normalizeAddress(address), value);
  }

  const requiredProviders = ['umami', 'supabase'];
  const missing: string[] = [];

  for (const address of agentEoas) {
    const grant = grantsByAddress.get(address);
    if (!grant) {
      missing.push(`${address} (missing grant entry)`);
      continue;
    }
    for (const provider of requiredProviders) {
      if (!grant[provider] || grant[provider].active === false) {
        missing.push(`${address} (missing/inactive ${provider})`);
      }
    }
  }

  if (missing.length > 0) {
    throw new Error(
      'ACL is not seeded for current agent EOAs:\n' +
      missing.map(item => `  - ${item}`).join('\n') +
      `\nRun: yarn test:e2e:vnet seed-acl "${cloneDir}"`
    );
  }

  console.log(`ACL check: OK (${agentEoas.length} agent EOA(s) covered)`);
  return agentEoas;
}

async function getUndeliveredRequestsForWorkstream(workstreamId: string): Promise<string[]> {
  const query = `
    query PendingRequests($workstreamId: String!, $limit: Int!) {
      requests(
        where: { workstreamId: $workstreamId, delivered: false }
        orderBy: "blockTimestamp"
        orderDirection: "asc"
        limit: $limit
      ) {
        items { id }
      }
    }
  `;
  const json = await postGraphql(LOCAL_PONDER_GRAPHQL_URL, query, {
    workstreamId,
    limit: 25,
  });
  const items = Array.isArray(json?.data?.requests?.items) ? json.data.requests.items : [];
  return items
    .map((item: any) => String(item?.id || '').trim())
    .filter((id: string) => id.length > 0);
}

export interface HardPreflightOptions {
  cloneDir?: string;
  workstreamId?: string;
  allowStaleRequests?: boolean;
}

export async function runHardPreflightGate(options: HardPreflightOptions): Promise<void> {
  console.log('Running E2E hard preflight gate...');
  assertNode22ViaNvm();

  await assertGraphqlHealthy('Ponder (:42069)', LOCAL_PONDER_GRAPHQL_URL, '{ _meta { status } }');
  await assertGraphqlHealthy('Control API (:4001)', LOCAL_CONTROL_GRAPHQL_URL, '{ __typename }');
  await assertHttpHealthy('Gateway (:3001)', LOCAL_GATEWAY_HEALTH_URL);
  await assertGithubTokenValid();

  const fromEnv = await readEnvE2eVar('CLONE_DIR');
  const cloneDirInput = options.cloneDir || process.env.CLONE_DIR || fromEnv;
  if (!cloneDirInput) {
    throw new Error('Clone directory is required. Pass --cwd or set CLONE_DIR in .env.e2e');
  }
  const cloneDir = resolve(cloneDirInput);
  await assertAclSeededForAgents(cloneDir);

  // Soft check: Postgres for venture permission testing (advisory, not required)
  const aclDbUrl = process.env.E2E_ACL_DATABASE_URL;
  if (aclDbUrl) {
    try {
      const pg = await import('pg');
      const pool = new pg.default.Pool({ connectionString: aclDbUrl, connectionTimeoutMillis: 5000 });
      const { rows } = await pool.query('SELECT COUNT(*)::int AS count FROM credential_policies');
      await pool.end();
      console.log(`Postgres ACL check: OK (${rows[0].count} credential policies seeded)`);
    } catch (err: any) {
      console.warn(`Postgres ACL check: WARN — ${err.message}`);
      console.warn('  Venture permission tests may fail. Restart stack: yarn test:e2e:stack');
    }
  } else {
    console.log('Postgres ACL check: SKIP (E2E_ACL_DATABASE_URL not set — venture tests unavailable)');
  }

  if (options.workstreamId && !options.allowStaleRequests) {
    const pending = await getUndeliveredRequestsForWorkstream(options.workstreamId);
    if (pending.length > 0) {
      throw new Error(
        `Workstream ${options.workstreamId} has ${pending.length} undelivered request(s): ${pending.join(', ')}\n` +
        'Use a fresh workstream, clear stale requests, or pass --allow-stale for explicit override.'
      );
    }
    console.log(`Stale request guard: OK (no undelivered requests in ${options.workstreamId})`);
  }

  console.log('Hard preflight gate: PASS');
}

// ─── Commands ────────────────────────────────────────────────────────────────

export async function cmdCreate(flags: Record<string, string>): Promise<{ rpcUrl: string; vnetId: string }> {
  const client = createTenderlyClient();

  // Cleanup old VNets first
  console.log('Cleaning up stale VNets...');
  const deleted = await client.cleanupOldVnets({ maxAgeMs: 3600000 });
  if (deleted > 0) console.log(`  Deleted ${deleted} stale VNets`);

  // Create new VNet
  console.log('Creating new VNet (Base fork)...');
  const vnet = await client.createVnet(8453);

  // Get current block
  const blockHex = await rpcCall(vnet.adminRpcUrl, 'eth_blockNumber');
  const blockNumber = parseInt(blockHex, 16);

  // Write to .env.e2e
  await writeEnvE2e({
    RPC_URL: vnet.adminRpcUrl,
    VNET_ID: vnet.id,
    CHAIN_ID: '8453',
  });

  const result = {
    vnetId: vnet.id,
    adminRpcUrl: vnet.adminRpcUrl,
    blockNumber,
    envFile: E2E_ENV_FILE,
  };

  console.log('\nVNet created:');
  console.log(JSON.stringify(result, null, 2));
  console.log(`\nConfig written to ${E2E_ENV_FILE}`);

  return { rpcUrl: vnet.adminRpcUrl, vnetId: vnet.id };
}

async function cmdFund(positional: string[], flags: Record<string, string>) {
  const address = positional[0];
  if (!address) throw new Error('Usage: fund <address> [--eth <amount>] [--olas <amount>]');

  const rpcUrl = await getRpcUrl(flags);
  const ethAmount = flags.eth || '0';
  const olasAmount = flags.olas || '0';
  if (parseFloat(ethAmount) === 0 && parseFloat(olasAmount) === 0) {
    throw new Error('Specify at least one of --eth <amount> or --olas <amount>');
  }

  // Fund ETH (skip if 0)
  // tenderly_setBalance sets ABSOLUTE balance, so we read current + add requested
  if (parseFloat(ethAmount) > 0) {
    const currentHex = await rpcCall(rpcUrl, 'eth_getBalance', [address, 'latest']);
    const currentWei = BigInt(currentHex);
    const addWei = BigInt(ethToWei(ethAmount));
    const totalWei = currentWei + addWei;
    console.log(`Funding ${address} with ${ethAmount} ETH (current: ${Number(currentWei) / 1e18} ETH)...`);
    await rpcCall(rpcUrl, 'tenderly_setBalance', [[address], `0x${totalWei.toString(16)}`]);
    console.log('  ETH funded');
  }

  // Fund OLAS (skip if 0)
  // tenderly_setErc20Balance sets ABSOLUTE balance, so we read current + add requested
  if (parseFloat(olasAmount) > 0) {
    // Read current OLAS balance via ERC20 balanceOf
    const balanceOfData = `0x70a08231000000000000000000000000${address.slice(2).toLowerCase()}`;
    const currentHex = await rpcCall(rpcUrl, 'eth_call', [
      { to: OLAS_TOKEN_ADDRESS, data: balanceOfData },
      'latest',
    ]);
    const currentWei = BigInt(currentHex);
    const addWei = BigInt(ethToWei(olasAmount)); // OLAS has 18 decimals like ETH
    const totalWei = currentWei + addWei;
    console.log(`Funding ${address} with ${olasAmount} OLAS (current: ${Number(currentWei / BigInt(1e14)) / 1e4} OLAS)...`);
    await rpcCall(rpcUrl, 'tenderly_setErc20Balance', [
      OLAS_TOKEN_ADDRESS,
      [address],
      `0x${totalWei.toString(16)}`,
    ]);
    console.log('  OLAS funded');
  }

  console.log('\nDone.');
}

async function cmdMine(positional: string[], flags: Record<string, string>) {
  const count = parseInt(positional[0] || '1', 10);
  const rpcUrl = await getRpcUrl(flags);

  console.log(`Mining ${count} block(s)...`);
  for (let i = 0; i < count; i++) {
    await rpcCall(rpcUrl, 'evm_mine');
  }

  const blockHex = await rpcCall(rpcUrl, 'eth_blockNumber');
  console.log(`Done. Current block: ${parseInt(blockHex, 16)}`);
}

async function cmdTimeWarp(positional: string[], flags: Record<string, string>) {
  const seconds = parseInt(positional[0], 10);
  if (!seconds || seconds <= 0) throw new Error('Usage: time-warp <seconds>');

  const rpcUrl = await getRpcUrl(flags);

  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  console.log(`Warping time forward by ${seconds}s (${hours}h ${minutes}m)...`);

  await rpcCall(rpcUrl, 'evm_increaseTime', [`0x${seconds.toString(16)}`]);
  await rpcCall(rpcUrl, 'evm_mine');

  const blockHex = await rpcCall(rpcUrl, 'eth_blockNumber');
  console.log(`Done. Current block: ${parseInt(blockHex, 16)}`);
}

// Minimal staking contract ABI for checkpoint
const STAKING_ABI = [
  'function checkpoint() returns (uint256[], uint256[], uint256[], uint256[])',
  'function availableRewards() view returns (uint256)',
  'function tsCheckpoint() view returns (uint256)',
  'function getNextRewardCheckpointTimestamp() view returns (uint256)',
  'function calculateStakingReward(uint256 serviceId) view returns (uint256)',
  'function getServiceIds() view returns (uint256[])',
];

async function cmdCheckpoint(flags: Record<string, string>) {
  const stakingAddr = flags['staking'];
  const privateKey = flags['key'];
  if (!stakingAddr || !privateKey) {
    throw new Error('Usage: checkpoint --staking <address> --key <private-key>');
  }

  const rpcUrl = await getRpcUrl(flags);

  // Dynamic import — ethers is only needed for this command
  const { ethers } = await import('ethers');
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const wallet = new ethers.Wallet(privateKey, provider);
  const staking = new ethers.Contract(stakingAddr, STAKING_ABI, wallet);

  // 1. Read pre-checkpoint state
  console.log('Staking contract state (pre-checkpoint):');
  const availableRewards = await staking.availableRewards();
  const tsCheckpoint = await staking.tsCheckpoint();
  const nextCheckpoint = await staking.getNextRewardCheckpointTimestamp();
  const serviceIds: bigint[] = await staking.getServiceIds();

  console.log(`  Available rewards: ${ethers.formatEther(availableRewards)} OLAS`);
  console.log(`  Last checkpoint:   ${new Date(Number(tsCheckpoint) * 1000).toISOString()}`);
  console.log(`  Next eligible:     ${new Date(Number(nextCheckpoint) * 1000).toISOString()}`);
  console.log(`  Staked services:   [${serviceIds.map(id => id.toString()).join(', ')}]`);

  // 2. Fund staking contract with OLAS if rewards are empty
  if (availableRewards === 0n) {
    const fundAmount = ethers.parseEther('10000'); // 10,000 OLAS
    console.log(`\nNo rewards available — funding staking contract with 10,000 OLAS...`);
    await rpcCall(rpcUrl, 'tenderly_setErc20Balance', [
      OLAS_TOKEN_ADDRESS,
      [stakingAddr],
      `0x${fundAmount.toString(16)}`,
    ]);
    const newRewards = await staking.availableRewards();
    console.log(`  Available rewards now: ${ethers.formatEther(newRewards)} OLAS`);
  }

  // 3. Pre-checkpoint reward estimates per service
  console.log('\nPre-checkpoint reward estimates:');
  for (const serviceId of serviceIds) {
    const reward = await staking.calculateStakingReward(serviceId);
    console.log(`  Service ${serviceId}: ${ethers.formatEther(reward)} OLAS`);
  }

  // 4. Call checkpoint
  console.log('\nCalling checkpoint()...');
  const tx = await staking.checkpoint();
  const receipt = await tx.wait();
  console.log(`  TX: ${receipt.hash}`);
  console.log(`  Gas used: ${receipt.gasUsed.toString()}`);

  // 5. Parse return values from checkpoint event logs
  // checkpoint() returns (serviceIds, eligibleServiceIds, eligibleServiceRewards, evictServiceIds)
  // We read them from post-state since return values aren't in receipt
  console.log('\nPost-checkpoint state:');
  const postRewards = await staking.availableRewards();
  console.log(`  Available rewards: ${ethers.formatEther(postRewards)} OLAS`);

  let anyRewards = false;
  for (const serviceId of serviceIds) {
    const reward = await staking.calculateStakingReward(serviceId);
    const status = reward > 0n ? 'REWARDED' : 'no reward';
    console.log(`  Service ${serviceId}: ${ethers.formatEther(reward)} OLAS (${status})`);
    if (reward > 0n) anyRewards = true;
  }

  if (anyRewards) {
    console.log('\nCheckpoint successful — at least one service has rewards.');
  } else {
    console.log('\nWARNING: No services received rewards. Check activity checker requirements.');
  }
}

// Minimal activity checker ABI
const ACTIVITY_CHECKER_ABI = [
  'function mechMarketplace() view returns (address)',
  'function getMultisigNonces(address multisig) view returns (uint256[])',
];

async function cmdSeedActivity(positional: string[], flags: Record<string, string>) {
  const multisig = positional[0];
  const stakingAddr = flags['staking'];
  const value = parseInt(flags['value'] || '1000', 10);
  if (!multisig || !stakingAddr) {
    throw new Error('Usage: seed-activity <multisig> --staking <staking-address> [--value <n>]');
  }

  const rpcUrl = await getRpcUrl(flags);
  const { ethers } = await import('ethers');
  const provider = new ethers.JsonRpcProvider(rpcUrl);

  // 1. Query activity checker address from staking contract
  const staking = new ethers.Contract(stakingAddr, [
    'function activityChecker() view returns (address)',
  ], provider);
  const checkerAddr = await staking.activityChecker();
  console.log(`Activity checker: ${checkerAddr}`);

  // 2. Query marketplace address from activity checker
  const checker = new ethers.Contract(checkerAddr, ACTIVITY_CHECKER_ABI, provider);
  const marketplaceAddr = await checker.mechMarketplace();
  console.log(`Mech marketplace:  ${marketplaceAddr}`);

  // 3. Read current nonces
  const nonces: bigint[] = await checker.getMultisigNonces(multisig);
  console.log(`Current nonces:    [${nonces.map(n => n.toString()).join(', ')}]`);

  const valueHex = ethers.zeroPadValue(ethers.toBeHex(value), 32);

  // 4. Set Safe nonce (slot 5 in GnosisSafe)
  const safeSlot = ethers.zeroPadValue(ethers.toBeHex(5), 32);
  console.log(`\nSetting Safe nonce to ${value}...`);
  await rpcCall(rpcUrl, 'tenderly_setStorageAt', [multisig, safeSlot, valueHex]);

  // 5. Set marketplace delivery count — auto-discover storage slot
  //    Activity checker reads mapDeliveryCounts(multisig), not mapRequestCounts.
  //    Storage slot varies by contract version, so probe candidate slots.
  const marketplace = new ethers.Contract(marketplaceAddr, [
    'function mapDeliveryCounts(address) view returns (uint256)',
  ], provider);

  let deliverySlotFound = false;
  for (const candidateSlot of [8, 9, 10, 11, 12, 13, 14, 15]) {
    const slot = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ['address', 'uint256'],
        [multisig, candidateSlot]
      )
    );
    // Set probe value
    await rpcCall(rpcUrl, 'tenderly_setStorageAt', [marketplaceAddr, slot, valueHex]);
    // Check if mapDeliveryCounts reflects the change
    const check = await marketplace.mapDeliveryCounts(multisig);
    if (check === BigInt(value)) {
      console.log(`Setting delivery count to ${value} (slot ${candidateSlot})...`);
      deliverySlotFound = true;
      break;
    }
    // Revert probe
    await rpcCall(rpcUrl, 'tenderly_setStorageAt', [marketplaceAddr, slot, ethers.zeroPadValue('0x00', 32)]);
  }

  if (!deliverySlotFound) {
    console.error('ERROR: Could not discover storage slot for mapDeliveryCounts');
    console.error('  Tried slots 8-15. The MechMarketplace contract layout may have changed.');
    process.exit(1);
  }

  // 6. Verify
  const newNonces: bigint[] = await checker.getMultisigNonces(multisig);
  console.log(`\nVerified nonces:   [${newNonces.map(n => n.toString()).join(', ')}]`);

  if (newNonces[0] === BigInt(value) && newNonces[1] === BigInt(value)) {
    console.log('Activity seeded successfully.');
  } else {
    console.error('WARNING: Nonces do not match expected values!');
    process.exit(1);
  }
}

async function cmdSeedAcl(positional: string[], flags: Record<string, string>) {
  const cloneDir = positional[0] || flags['cwd'];
  if (!cloneDir) {
    throw new Error('Usage: seed-acl <clone-dir>  OR  seed-acl --cwd <clone-dir>');
  }

  const aclPath = E2E_ACL_FILE;
  const addresses = await discoverAgentEoas(cloneDir);

  // Load existing ACL or start fresh
  let acl: { grants: Record<string, any>; connections: Record<string, any> };
  try {
    acl = JSON.parse(await fs.readFile(aclPath, 'utf-8'));
  } catch {
    acl = { grants: {}, connections: {} };
  }

  // Seed each agent with credential grants (idempotent)
  const providers = [
    { name: 'umami', connectionId: 'e2e-umami' },
    { name: 'supabase', connectionId: 'e2e-supabase' },
  ];

  for (const addr of addresses) {
    if (!acl.grants[addr]) {
      acl.grants[addr] = {};
    }
    for (const { name, connectionId } of providers) {
      if (!acl.grants[addr][name]) {
        acl.grants[addr][name] = {
          nangoConnectionId: connectionId,
          pricePerAccess: '0',
          expiresAt: null,
          active: true,
        };
      }
    }
  }

  // Ensure connection entries exist
  for (const { name, connectionId } of providers) {
    if (!acl.connections[connectionId]) {
      acl.connections[connectionId] = {
        provider: name,
        metadata: { scope: 'e2e-test' },
      };
    }
  }

  await fs.writeFile(aclPath, JSON.stringify(acl, null, 2) + '\n');

  // Seed Postgres ACL if database URL is available
  const aclDbUrl = process.env.E2E_ACL_DATABASE_URL || process.env.ACL_DATABASE_URL;
  if (aclDbUrl) {
    const pg = await import('pg');
    const pool = new pg.default.Pool({ connectionString: aclDbUrl, max: 2 });
    try {
      for (const addr of addresses) {
        // Upsert operator with tier_override (not just trust_tier — calculateTrustTier reads tier_override)
        await pool.query(`
          INSERT INTO operators (address, trust_tier, tier_override, registered_at, updated_at)
          VALUES ($1, 'trusted', 'trusted', NOW(), NOW())
          ON CONFLICT (address) DO UPDATE SET
            tier_override = 'trusted',
            trust_tier = 'trusted',
            updated_at = NOW()
        `, [addr]);

        for (const { name, connectionId } of providers) {
          await pool.query(`
            INSERT INTO credential_grants
              (address, provider, nango_connection_id, price_per_access, active)
            VALUES ($1, $2, $3, '0', true)
            ON CONFLICT (address, provider) DO UPDATE SET
              nango_connection_id = EXCLUDED.nango_connection_id,
              active = true
          `, [addr, name, connectionId]);
        }
      }
      console.log(`  Postgres ACL seeded (${aclDbUrl.split('@')[1] || 'configured'})`);
    } finally {
      await pool.end();
    }
  } else {
    console.log('  (No ACL_DATABASE_URL — Postgres seeding skipped)');
  }

  console.log(`ACL seeded for ${addresses.length} agent(s):`);
  for (const addr of addresses) {
    console.log(`  ${addr}`);
  }
  console.log(`File: ${aclPath}`);
}

async function cmdPreflight(positional: string[], flags: Record<string, string>) {
  const cloneDir = positional[0] || flags['cwd'] || process.env.CLONE_DIR || await readEnvE2eVar('CLONE_DIR');
  const workstreamId = flags['workstream'] || positional[1];
  const allowStaleRequests = flags['allow-stale'] === 'true';

  await runHardPreflightGate({
    cloneDir,
    workstreamId,
    allowStaleRequests,
  });
}

export async function cmdCleanup(flags: Record<string, string>): Promise<void> {
  const dryRun = flags['dry-run'] === 'true';
  const maxAgeHours = parseInt(flags['max-age-hours'] || '1', 10);

  const client = createTenderlyClient();

  console.log(`${dryRun ? '[DRY RUN] ' : ''}Cleaning up VNets older than ${maxAgeHours}h...`);
  const deleted = await client.cleanupOldVnets({
    maxAgeMs: maxAgeHours * 3600000,
    dryRun,
  });

  console.log(`${dryRun ? 'Would delete' : 'Deleted'} ${deleted} VNets.`);

  // Clean up clone directory if saved in .env.e2e
  const cloneDir = process.env.CLONE_DIR;
  if (cloneDir) {
    try {
      await fs.access(cloneDir);
      if (dryRun) {
        console.log(`[DRY RUN] Would remove clone: ${cloneDir}`);
      } else {
        console.log(`Removing clone: ${cloneDir}...`);
        await fs.rm(cloneDir, { recursive: true, force: true });
        console.log('  Clone removed.');
      }
    } catch {
      // Directory doesn't exist, nothing to clean
    }
  }

  // ── Poetry virtualenvs ──
  // Each E2E clone gets a temp path → unique Poetry virtualenv hash → ~2 GB.
  // These accumulate across runs and are never cleaned. Only preserve the
  // virtualenv for the host's jinn-node directory.
  try {
    const poetryVenvDir = `${process.env.HOME}/Library/Caches/pypoetry/virtualenvs`;
    const entries = await fs.readdir(poetryVenvDir);
    const staleVenvs = entries.filter(e => e.startsWith('jinn-node-python-deps-'));

    // Determine which virtualenv hash belongs to the host jinn-node
    // (poetry hashes the parent dir path — skip the one matching our monorepo)
    let hostVenvPrefix: string | null = null;
    try {
      const jinnNodeDir = resolve(MONOREPO_ROOT, 'jinn-node');
      const poetryEnvList = execSync(`poetry env list --full-path`, {
        cwd: jinnNodeDir,
        encoding: 'utf-8',
        timeout: 10000,
      }).trim();
      // Output: /path/to/jinn-node-python-deps-HASH-py3.11 (Activated)
      const match = poetryEnvList.match(/(jinn-node-python-deps-[^\s/]+)/);
      if (match) hostVenvPrefix = match[1];
    } catch {
      // Poetry not available or no env — skip host detection
    }

    const toRemove = staleVenvs.filter(e => !hostVenvPrefix || e !== hostVenvPrefix);
    if (toRemove.length > 0) {
      console.log(`\nCleaning stale Poetry virtualenvs (${toRemove.length} found)...`);
      for (const venv of toRemove) {
        const venvPath = resolve(poetryVenvDir, venv);
        if (dryRun) {
          console.log(`  [DRY RUN] Would remove: ${venv}`);
        } else {
          await fs.rm(venvPath, { recursive: true, force: true });
          console.log(`  Removed: ${venv}`);
        }
      }
    }
  } catch {
    // Poetry cache dir doesn't exist or not on macOS
  }

  // ── Docker cleanup ──
  // Stop and remove E2E Postgres container
  try {
    const containerName = 'e2e-postgres';
    if (dryRun) {
      console.log(`[DRY RUN] Would stop/remove Docker container: ${containerName}`);
    } else {
      console.log(`\nCleaning Docker resources...`);
      try {
        execSync(`docker rm -f ${containerName} 2>/dev/null`, { encoding: 'utf-8', timeout: 10000 });
        console.log(`  Removed container: ${containerName}`);
      } catch {
        // Container doesn't exist
      }
    }
    // Remove stale jinn-node:e2e image
    if (dryRun) {
      console.log(`[DRY RUN] Would remove Docker image: jinn-node:e2e`);
    } else {
      try {
        execSync(`docker rmi jinn-node:e2e 2>/dev/null`, { encoding: 'utf-8', timeout: 30000 });
        console.log(`  Removed image: jinn-node:e2e`);
      } catch {
        // Image doesn't exist
      }
    }
  } catch {
    // Docker not available
  }

  // ── Local stack PIDs ──
  // Kill any lingering Ponder / Control API / Gateway processes from .env.e2e
  for (const pidKey of ['E2E_PID_PONDER', 'E2E_PID_CONTROL_API', 'E2E_PID_GATEWAY']) {
    const pid = process.env[pidKey];
    if (pid) {
      try {
        process.kill(parseInt(pid, 10), 'SIGTERM');
        if (!dryRun) console.log(`  Killed ${pidKey}: ${pid}`);
      } catch {
        // Process already dead
      }
    }
  }

  // ── ACL file ──
  if (!dryRun) {
    try {
      await fs.access(E2E_ACL_FILE);
      await fs.unlink(E2E_ACL_FILE);
      console.log(`Removed ${E2E_ACL_FILE}`);
    } catch {
      // File doesn't exist
    }
  }

  // ── E2E log directory ──
  const logDir = process.env.E2E_LOG_DIR || '/tmp/jinn-e2e-logs';
  try {
    await fs.access(logDir);
    if (dryRun) {
      console.log(`[DRY RUN] Would remove log dir: ${logDir}`);
    } else {
      await fs.rm(logDir, { recursive: true, force: true });
      console.log(`Removed log dir: ${logDir}`);
    }
  } catch {
    // Directory doesn't exist
  }

  // Clean .env.e2e last (since it contains CLONE_DIR and PIDs we just used)
  if (!dryRun) {
    try {
      await fs.access(E2E_ENV_FILE);
      await fs.unlink(E2E_ENV_FILE);
      console.log(`Removed ${E2E_ENV_FILE}`);
    } catch {
      // File doesn't exist
    }
  }
}

async function cmdStatus(flags: Record<string, string>) {
  let rpcUrl: string;
  try {
    rpcUrl = await getRpcUrl(flags);
  } catch {
    console.log('No VNet configured. Run "create" first.');
    return;
  }

  // Read VNet ID from .env.e2e
  let vnetId = 'unknown';
  try {
    const envContent = await fs.readFile(E2E_ENV_FILE, 'utf-8');
    const match = envContent.match(/^VNET_ID=(.+)$/m);
    if (match) vnetId = match[1].trim();
  } catch { /* no file */ }

  console.log(`VNet ID: ${vnetId}`);
  console.log(`RPC URL: ${rpcUrl}`);

  // Test read
  try {
    const blockHex = await rpcCall(rpcUrl, 'eth_blockNumber');
    console.log(`Current block: ${parseInt(blockHex, 16)}`);
    console.log('Reads: OK');
  } catch (e: any) {
    console.log(`Reads: FAILED — ${e.message}`);
    return;
  }

  // Test write (mine a block)
  try {
    await rpcCall(rpcUrl, 'evm_mine');
    console.log('Writes: OK');
  } catch (e: any) {
    if (e.message.includes('403') || e.message.includes('quota')) {
      console.log('Writes: QUOTA EXHAUSTED — create a new VNet');
    } else {
      console.log(`Writes: FAILED — ${e.message}`);
    }
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const command = positional.shift();

  switch (command) {
    case 'create':
      return cmdCreate(flags);
    case 'fund':
      return cmdFund(positional, flags);
    case 'mine':
      return cmdMine(positional, flags);
    case 'time-warp':
      return cmdTimeWarp(positional, flags);
    case 'checkpoint':
      return cmdCheckpoint(flags);
    case 'seed-activity':
      return cmdSeedActivity(positional, flags);
    case 'seed-acl':
      return cmdSeedAcl(positional, flags);
    case 'preflight':
      return cmdPreflight(positional, flags);
    case 'cleanup':
      return cmdCleanup(flags);
    case 'status':
      return cmdStatus(flags);
    default:
      console.error(`Unknown command: ${command || '(none)'}`);
      console.error('\nUsage: e2e-harness.ts <command> [options]');
      console.error('Commands: create, fund, mine, time-warp, checkpoint, seed-activity, seed-acl, preflight, cleanup, status');
      process.exit(1);
  }
}

// Only run CLI when executed directly (not when imported as library)
const isDirectRun = process.argv[1]?.includes('e2e-harness');
if (isDirectRun) {
  main().catch(e => {
    console.error('FAILED:', e.message || e);
    process.exit(1);
  });
}
