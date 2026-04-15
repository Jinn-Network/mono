#!/usr/bin/env tsx
/**
 * Deploy Mech — Deploy a mech contract for a service that doesn't have one
 *
 * Usage:
 *   npx tsx scripts/deploy-mech.ts                              # auto-detect service
 *   npx tsx scripts/deploy-mech.ts --service-config-id=sc-xxx   # specific service
 *   npx tsx scripts/deploy-mech.ts --dry-run                    # check without deploying
 *
 * Flow:
 *   1. Scan .operate/services/ for configs with empty MECH_TO_CONFIG
 *   2. Read config → extract serviceId, serviceSafe, agentEoa
 *   3. Decrypt agent private key from .operate/keys/
 *   4. Check Master Safe balance → fund agent EOA if needed (FundDistributor)
 *   5. Deploy mech via service Safe (MechMarketplace.create)
 *   6. Update config with new mech address
 *
 * Requires: OPERATE_PASSWORD, RPC_URL in environment (or .env)
 */

// Route pino logs to stderr so stdout is clean for script output
process.env.FORCE_STDERR = 'true';

import 'dotenv/config';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ethers } from 'ethers';
import { getMasterPrivateKey, getMasterSafe, getMiddlewarePath } from '../src/env/operate-profile.js';
import { decryptKeystoreV3 } from '../src/env/keystore-decrypt.js';
import { deployMechViaSafe, buildMechToConfigValue } from '../src/worker/stolas/StolasMechDeployer.js';
import { maybeDistributeFunds } from '../src/worker/funding/FundDistributor.js';
import type { ServiceInfo } from '../src/worker/ServiceConfigReader.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── CLI Args ──────────────────────────────────────────────────────────────────

interface Args {
  serviceConfigId?: string;
  dryRun: boolean;
}

function parseArgs(): Args {
  const args: Args = { dryRun: false };
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith('--service-config-id=')) {
      args.serviceConfigId = arg.split('=')[1];
    } else if (arg === '--dry-run') {
      args.dryRun = true;
    } else if (arg === '--help' || arg === '-h') {
      console.log(`
Deploy Mech — Deploy a mech contract for a service without one

Usage:
  npx tsx scripts/deploy-mech.ts [OPTIONS]

Options:
  --service-config-id=sc-xxx   Deploy mech for a specific service config
  --dry-run                     Check status without deploying
  --help, -h                    Show this help
`);
      process.exit(0);
    }
  }
  return args;
}

// ─── Service Discovery ─────────────────────────────────────────────────────────

interface ServiceCandidate {
  serviceConfigId: string;
  serviceId: number;
  serviceSafeAddress: string;
  agentEoaAddress: string;
  chain: string;
  configPath: string;
  rpcUrl: string;
}

function findServicesNeedingMech(middlewarePath: string): ServiceCandidate[] {
  const servicesDir = join(middlewarePath, '.operate', 'services');
  if (!existsSync(servicesDir)) {
    console.error(`  Services directory not found: ${servicesDir}`);
    return [];
  }

  const candidates: ServiceCandidate[] = [];
  const dirs = readdirSync(servicesDir, { withFileTypes: true })
    .filter(d => d.isDirectory() && d.name.startsWith('sc-'));

  for (const dir of dirs) {
    const configPath = join(servicesDir, dir.name, 'config.json');
    if (!existsSync(configPath)) continue;

    try {
      const raw = readFileSync(configPath, 'utf-8');
      const config = JSON.parse(raw);
      const mechToConfig = config.env_variables?.MECH_TO_CONFIG?.value;

      // Skip services that already have a mech
      if (mechToConfig && mechToConfig.trim() !== '') continue;

      const homeChain = config.home_chain || 'base';
      const chainData = config.chain_configs?.[homeChain]?.chain_data;
      const rpcUrl = config.chain_configs?.[homeChain]?.ledger_config?.rpc;

      if (!chainData?.multisig || !chainData?.instances?.[0] || !chainData?.token) continue;

      candidates.push({
        serviceConfigId: dir.name,
        serviceId: chainData.token,
        serviceSafeAddress: chainData.multisig,
        agentEoaAddress: chainData.instances[0],
        chain: homeChain,
        configPath,
        rpcUrl: rpcUrl || process.env.RPC_URL || '',
      });
    } catch {
      continue;
    }
  }

  return candidates;
}

// ─── Agent Key Decryption ──────────────────────────────────────────────────────

function decryptAgentKey(middlewarePath: string, agentAddress: string, serviceConfigId: string): string {
  const password = process.env.OPERATE_PASSWORD;
  if (!password) {
    throw new Error('OPERATE_PASSWORD not set. Required to decrypt agent key.');
  }

  // Try keys.json first (has raw private key) — most reliable source
  const keysJsonPath = join(middlewarePath, '.operate', 'services', serviceConfigId, 'keys.json');
  if (existsSync(keysJsonPath)) {
    try {
      const keys = JSON.parse(readFileSync(keysJsonPath, 'utf-8'));
      if (Array.isArray(keys) && keys[0]?.private_key?.startsWith('0x')) {
        return keys[0].private_key;
      }
    } catch { /* fall through */ }
  }

  // Fallback: .operate/keys/<address> (encrypted keystore V3)
  const keyPath = join(middlewarePath, '.operate', 'keys', agentAddress);
  if (!existsSync(keyPath)) {
    throw new Error(`Agent key file not found: ${keyPath} (and no keys.json)`);
  }

  const keyData = JSON.parse(readFileSync(keyPath, 'utf-8'));
  const privateKeyField = keyData.private_key;

  if (typeof privateKeyField === 'string' && privateKeyField.startsWith('0x')) {
    return privateKeyField;
  }

  if (typeof privateKeyField === 'string' && privateKeyField.startsWith('{')) {
    return decryptKeystoreV3(privateKeyField, password);
  }

  throw new Error(`Unrecognized key format for ${agentAddress}`);
}

// ─── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs();

  console.log('\n┌──────────────────────────────────────────────────────┐');
  console.log('│  Deploy Mech — MechMarketplace.create() via Safe    │');
  console.log('└──────────────────────────────────────────────────────┘\n');

  // Find middleware path
  const middlewarePath = getMiddlewarePath();
  if (!middlewarePath) {
    console.error('  Could not find .operate directory. Set OPERATE_PROFILE_DIR if needed.');
    process.exit(1);
  }

  console.log(`  .operate path: ${join(middlewarePath, '.operate')}`);

  // Find services needing mech
  const candidates = findServicesNeedingMech(middlewarePath);
  if (candidates.length === 0) {
    console.log('  All services already have mech contracts. Nothing to do.');
    process.exit(0);
  }

  console.log(`  Found ${candidates.length} service(s) without mech:\n`);
  for (const c of candidates) {
    console.log(`    ${c.serviceConfigId}  service #${c.serviceId}  safe=${c.serviceSafeAddress.slice(0, 10)}...  agent=${c.agentEoaAddress.slice(0, 10)}...`);
  }

  // Select service
  let target: ServiceCandidate;
  if (args.serviceConfigId) {
    const match = candidates.find(c => c.serviceConfigId === args.serviceConfigId);
    if (!match) {
      console.error(`\n  Service ${args.serviceConfigId} not found or already has a mech.`);
      process.exit(1);
    }
    target = match;
  } else {
    target = candidates[0];
  }

  console.log(`\n  Target: service #${target.serviceId} (${target.serviceConfigId})`);
  console.log(`  Service Safe: ${target.serviceSafeAddress}`);
  console.log(`  Agent EOA:    ${target.agentEoaAddress}`);

  // RPC URL
  const rpcUrl = target.rpcUrl || process.env.RPC_URL;
  if (!rpcUrl) {
    console.error('\n  RPC_URL not set. Add it to .env or set the environment variable.');
    process.exit(1);
  }

  const provider = new ethers.JsonRpcProvider(rpcUrl);

  // Check balances
  const masterSafeAddress = getMasterSafe(target.chain);
  if (!masterSafeAddress) {
    console.error('\n  Master Safe address not found in .operate/wallets/ethereum.json');
    process.exit(1);
  }

  const [masterSafeBalance, agentBalance, safeBalance] = await Promise.all([
    provider.getBalance(masterSafeAddress),
    provider.getBalance(target.agentEoaAddress),
    provider.getBalance(target.serviceSafeAddress),
  ]);

  console.log(`\n  Balances:`);
  console.log(`    Master Safe (${masterSafeAddress.slice(0, 10)}...): ${ethers.formatEther(masterSafeBalance)} ETH`);
  console.log(`    Agent EOA:   ${ethers.formatEther(agentBalance)} ETH`);
  console.log(`    Service Safe: ${ethers.formatEther(safeBalance)} ETH`);

  if (args.dryRun) {
    console.log('\n  [DRY RUN] Would deploy mech here. Exiting.');
    process.exit(0);
  }

  // Decrypt agent key
  console.log('\n  Decrypting agent key...');
  const agentPrivateKey = decryptAgentKey(middlewarePath, target.agentEoaAddress, target.serviceConfigId);
  console.log('  Agent key decrypted.');

  // Fund agent EOA if needed
  const minAgentGas = ethers.parseEther('0.001');
  if (agentBalance < minAgentGas) {
    console.log('\n  Agent EOA needs funding for gas...');

    if (masterSafeBalance >= ethers.parseEther('0.003')) {
      // Normal path: distribute from Master Safe via FundDistributor
      console.log('  Distributing from Master Safe...');
      const svcInfo: ServiceInfo = {
        serviceConfigId: target.serviceConfigId,
        serviceName: `jinn-stolas-${target.serviceId}`,
        serviceSafeAddress: target.serviceSafeAddress,
        agentEoaAddress: target.agentEoaAddress,
        chain: target.chain,
        serviceId: target.serviceId,
      };

      const fundResult = await maybeDistributeFunds([svcInfo], rpcUrl);
      if (fundResult.error) {
        console.error(`\n  Fund distribution error: ${fundResult.error}`);
        process.exit(1);
      }
      if (fundResult.funded.length > 0) {
        console.log(`  Funded ${fundResult.funded.length} address(es). txHash: ${fundResult.txHash}`);
      }
    } else {
      // Fallback: send ETH directly from Master EOA to Agent EOA
      console.log('  Master Safe is empty. Sending ETH directly from Master EOA...');
      const masterPrivateKey = getMasterPrivateKey();
      if (!masterPrivateKey) {
        console.error('\n  Cannot decrypt Master EOA key. Set OPERATE_PASSWORD.');
        process.exit(1);
      }

      const masterWallet = new ethers.Wallet(masterPrivateKey, provider);
      const masterEoaBalance = await provider.getBalance(masterWallet.address);
      console.log(`  Master EOA (${masterWallet.address}): ${ethers.formatEther(masterEoaBalance)} ETH`);

      if (masterEoaBalance < ethers.parseEther('0.002')) {
        console.error(`\n  Master EOA has insufficient ETH (${ethers.formatEther(masterEoaBalance)}).`);
        console.error(`  Send >= 0.01 ETH to Master Safe: ${masterSafeAddress}`);
        console.error(`  Or send >= 0.002 ETH to Master EOA: ${masterWallet.address}`);
        process.exit(1);
      }

      // Send ~0.002 ETH to agent, keeping some for Master EOA gas
      const sendAmount = masterEoaBalance - ethers.parseEther('0.0003');
      console.log(`  Sending ${ethers.formatEther(sendAmount)} ETH to Agent EOA...`);

      const tx = await masterWallet.sendTransaction({
        to: target.agentEoaAddress,
        value: sendAmount,
      });
      const receipt = await tx.wait();
      console.log(`  Funded Agent EOA. txHash: ${receipt?.hash}`);
    }

    // Re-check agent balance (retry a few times — RPC may lag behind confirmed tx)
    let newAgentBalance = 0n;
    for (let attempt = 0; attempt < 5; attempt++) {
      newAgentBalance = await provider.getBalance(target.agentEoaAddress);
      if (newAgentBalance >= minAgentGas) break;
      if (attempt < 4) {
        console.log(`  Waiting for balance to reflect (attempt ${attempt + 1}/5)...`);
        await new Promise(r => setTimeout(r, 2000));
      }
    }
    console.log(`  Agent EOA balance after funding: ${ethers.formatEther(newAgentBalance)} ETH`);

    if (newAgentBalance < minAgentGas) {
      console.error(`\n  Agent EOA still has insufficient ETH for gas after retries.`);
      process.exit(1);
    }
  }

  // Deploy mech
  console.log('\n  Deploying mech contract via service Safe...');
  console.log(`    MechMarketplace.create(${target.serviceId}, NativeFactory, price=99)`);

  const mechResult = await deployMechViaSafe({
    rpcUrl,
    chain: target.chain,
    serviceId: target.serviceId,
    serviceSafeAddress: target.serviceSafeAddress,
    agentPrivateKey,
  });

  if (!mechResult.success) {
    console.error(`\n  Mech deployment failed: ${mechResult.error}`);
    process.exit(1);
  }

  console.log(`\n  Mech deployed successfully!`);
  console.log(`    Mech address: ${mechResult.mechAddress}`);
  console.log(`    Tx hash:      ${mechResult.txHash}`);

  // Update config
  const mechToConfigValue = buildMechToConfigValue(mechResult.mechAddress!);
  try {
    const raw = await fs.readFile(target.configPath, 'utf-8');
    const config = JSON.parse(raw);
    config.env_variables.MECH_TO_CONFIG.value = mechToConfigValue;
    await fs.writeFile(target.configPath, JSON.stringify(config, null, 2));
    console.log(`\n  Config updated: ${target.configPath}`);
    console.log(`    MECH_TO_CONFIG = ${mechToConfigValue}`);
  } catch (err) {
    console.error(`\n  Failed to update config: ${(err as Error).message}`);
    console.error(`  Manually set MECH_TO_CONFIG to: ${mechToConfigValue}`);
  }

  console.log('\n┌──────────────────────────────────────────────────────┐');
  console.log('│  Mech deployment complete                           │');
  console.log('└──────────────────────────────────────────────────────┘');
  console.log(`  Service: #${target.serviceId} (${target.serviceConfigId})`);
  console.log(`  Mech:    ${mechResult.mechAddress}`);
  console.log(`  Next:    Re-upload to Railway and redeploy worker\n`);
}

main().catch(err => {
  console.error('\nFatal error:', err.message || err);
  process.exit(1);
});
