#!/usr/bin/env tsx
/**
 * Manage the Jinn activity checker whitelist.
 *
 * Commands:
 *   list                         Show current whitelist status for all staked mechs
 *   add <address> [address...]   Add specific mech addresses to the whitelist
 *   add --from-staking           Discover and add all mechs from staking events
 *   remove <address>             Remove a mech address from the whitelist
 *   check <address>              Check if a single address is whitelisted
 *
 * Environment:
 *   RPC_URL or BASE_RPC_URL      Required — Tenderly Base RPC
 *   OPERATE_PASSWORD              Required for add/remove (decrypts master EOA)
 *   DRY_RUN=true                  Simulate without sending transactions
 *
 * Examples:
 *   tsx scripts/activity-checker-whitelist.ts list
 *   tsx scripts/activity-checker-whitelist.ts add 0x1234... 0x5678...
 *   tsx scripts/activity-checker-whitelist.ts add --from-staking
 *   DRY_RUN=true tsx scripts/activity-checker-whitelist.ts add --from-staking
 */

import { ethers } from 'ethers';
import { readFileSync } from 'fs';
import { join } from 'path';
import { decryptKeystoreV3 } from '../jinn-node/src/env/keystore-decrypt.js';

// --- Contracts ---
const JINN_STAKING = '0x0dfaFbf570e9E813507aAE18aA08dFbA0aBc5139';
const ACTIVITY_CHECKER = '0x1dF0be586a7273a24C7b991e37FE4C0b1C622A9B';
const OPERATE_SAFE = '0x15aDF0eD29b6D76DB365670DfEeD8F9C5dAD4645';
const PUBLIC_RPC = 'https://base.publicnode.com';

const CHECKER_ABI = [
  'function addToWhitelist(address) external',
  'function removeFromWhitelist(address) external',
  'function isWhitelisted(address) view returns (bool)',
  'function owner() view returns (address)',
];

const SAFE_ABI = [
  'function nonce() view returns (uint256)',
  'function getTransactionHash(address to, uint256 value, bytes calldata data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, uint256 _nonce) view returns (bytes32)',
  'function execTransaction(address to, uint256 value, bytes calldata data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address payable refundReceiver, bytes memory signatures) public payable returns (bool success)',
  'function getOwners() view returns (address[])',
  'function getThreshold() view returns (uint256)',
];

const STAKING_ABI = [
  'function getServiceIds() view returns (uint256[])',
];

// ServiceStaked(uint256 indexed serviceId, address indexed multisig, address indexed mech, ...)
const SERVICE_STAKED_TOPIC = '0xaa6b005b4958114a0c90492461c24af6525ae0178db7fbf44125ae9217c69ccb';

// --- Helpers ---

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getProvider(): ethers.JsonRpcProvider {
  const rpc = process.env.RPC_URL || process.env.BASE_RPC_URL;
  if (!rpc) {
    console.error('RPC_URL or BASE_RPC_URL env var required');
    process.exit(1);
  }
  return new ethers.JsonRpcProvider(rpc);
}

function loadMasterKey(): string {
  const operateDir = join(process.cwd(), 'olas-operate-middleware', '.operate');
  const keystorePath = join(operateDir, 'wallets', 'ethereum.txt');
  const password = process.env.OPERATE_PASSWORD;
  if (!password) {
    throw new Error('OPERATE_PASSWORD env var required');
  }
  const keystoreJson = readFileSync(keystorePath, 'utf-8');
  return decryptKeystoreV3(keystoreJson, password);
}

async function execSafeTx(
  safe: ethers.Contract,
  signer: ethers.Wallet,
  to: string,
  data: string,
): Promise<ethers.TransactionReceipt> {
  // Use public RPC for nonce reads to avoid Tenderly cache staleness
  const publicProvider = new ethers.JsonRpcProvider(PUBLIC_RPC);
  const publicSafe = new ethers.Contract(OPERATE_SAFE, SAFE_ABI, publicProvider);
  const nonce = await publicSafe.nonce();

  const txHash = await publicSafe.getTransactionHash(
    to, 0n, data, 0, 0, 0, 0,
    ethers.ZeroAddress, ethers.ZeroAddress, nonce,
  );

  const signature = await signer.signMessage(ethers.getBytes(txHash));
  const sigBytes = ethers.getBytes(signature);
  const r = ethers.hexlify(sigBytes.slice(0, 32));
  const s = ethers.hexlify(sigBytes.slice(32, 64));
  const v = sigBytes[64] + 4; // eth_sign marker for Safe
  const adjustedSig = ethers.concat([r, s, new Uint8Array([v])]);

  const safeWithSigner = safe.connect(signer) as ethers.Contract;
  const tx = await safeWithSigner.execTransaction(
    to, 0n, data, 0, 0, 0, 0,
    ethers.ZeroAddress, ethers.ZeroAddress, adjustedSig,
    { gasLimit: 500_000 },
  );

  return await tx.wait();
}

/** Discover all unique mech addresses from ServiceStaked events on the Jinn staking contract. */
async function discoverStakedMechs(): Promise<Array<{ address: string; serviceId: number }>> {
  const publicProvider = new ethers.JsonRpcProvider(PUBLIC_RPC);
  const currentBlock = await publicProvider.getBlockNumber();

  // Jinn staking contract first had activity at block ~41,750,000
  const SCAN_START = 41_700_000;

  console.log('Scanning for ServiceStaked events on Jinn staking contract...');
  console.log(`  Staking contract: ${JINN_STAKING}`);
  console.log(`  Scanning blocks ${SCAN_START} to ${currentBlock} (50k chunks)\n`);

  const seen = new Map<string, number>(); // mech -> serviceId

  for (let start = SCAN_START; start <= currentBlock; start += 50_000) {
    const end = Math.min(start + 49_999, currentBlock);
    const payload = JSON.stringify({
      jsonrpc: '2.0',
      method: 'eth_getLogs',
      params: [{
        address: JINN_STAKING,
        topics: [SERVICE_STAKED_TOPIC],
        fromBlock: '0x' + start.toString(16),
        toBlock: '0x' + end.toString(16),
      }],
      id: 1,
    });

    const resp = await fetch(PUBLIC_RPC, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
    });
    const data = await resp.json() as any;

    for (const log of data.result || []) {
      const serviceId = parseInt(log.topics[1], 16);
      const mech = '0x' + log.topics[3].slice(-40);
      seen.set(mech, serviceId);
    }
  }

  const results = Array.from(seen.entries()).map(([address, serviceId]) => ({ address, serviceId }));
  console.log(`Found ${results.length} unique mechs.\n`);
  return results;
}

async function initSigner(provider: ethers.JsonRpcProvider) {
  const safe = new ethers.Contract(OPERATE_SAFE, SAFE_ABI, provider);

  const threshold = await safe.getThreshold();
  if (Number(threshold) !== 1) {
    console.error(`Safe threshold is ${threshold}, expected 1`);
    process.exit(1);
  }

  console.log('Decrypting master EOA key...');
  const masterKey = loadMasterKey();
  const signer = new ethers.Wallet(masterKey, provider);
  console.log(`Signer: ${signer.address}`);

  const owners = await safe.getOwners();
  if (!owners.map((o: string) => o.toLowerCase()).includes(signer.address.toLowerCase())) {
    console.error(`Signer ${signer.address} is not a Safe owner`);
    process.exit(1);
  }

  const balance = await provider.getBalance(signer.address);
  console.log(`Balance: ${ethers.formatEther(balance)} ETH\n`);
  if (balance < ethers.parseEther('0.0001')) {
    console.error('Insufficient ETH for gas');
    process.exit(1);
  }

  return { safe, signer };
}

// --- Commands ---

async function cmdList() {
  const provider = getProvider();
  const checker = new ethers.Contract(ACTIVITY_CHECKER, CHECKER_ABI, provider);

  console.log('=== Activity Checker Whitelist Status ===\n');
  console.log(`Activity Checker: ${ACTIVITY_CHECKER}`);
  console.log(`Owner:            ${await checker.owner()}\n`);

  // Get currently staked services
  const staking = new ethers.Contract(JINN_STAKING, STAKING_ABI, provider);
  const serviceIds: bigint[] = await staking.getServiceIds();
  console.log(`Currently staked services: [${serviceIds.join(', ')}]\n`);

  // Discover all mechs from events
  const mechs = await discoverStakedMechs();

  console.log('Whitelist status:');
  for (const mech of mechs) {
    const whitelisted = await checker.isWhitelisted(mech.address);
    const mark = whitelisted ? 'YES' : 'NO ';
    console.log(`  [${mark}] Service ${mech.serviceId} | ${mech.address}`);
  }
}

async function cmdAdd(addresses: string[], fromStaking: boolean) {
  const dryRun = process.env.DRY_RUN === 'true';
  const provider = getProvider();
  const checker = new ethers.Contract(ACTIVITY_CHECKER, CHECKER_ABI, provider);

  // Verify owner
  const owner = await checker.owner();
  if (owner.toLowerCase() !== OPERATE_SAFE.toLowerCase()) {
    console.error(`Activity checker owner is ${owner}, not the Operate Safe`);
    process.exit(1);
  }

  let mechs: Array<{ address: string; serviceId: number }>;

  if (fromStaking) {
    mechs = await discoverStakedMechs();
  } else {
    mechs = addresses.map(a => ({ address: a.toLowerCase(), serviceId: 0 }));
  }

  // Filter to those not yet whitelisted
  const toAdd: typeof mechs = [];
  console.log('Checking whitelist status...\n');
  for (const mech of mechs) {
    const whitelisted = await checker.isWhitelisted(mech.address);
    const label = mech.serviceId ? `Service ${mech.serviceId}` : 'Manual';
    const status = whitelisted ? 'ALREADY' : 'NEEDS ADD';
    console.log(`  ${label} | ${mech.address} | ${status}`);
    if (!whitelisted) toAdd.push(mech);
  }

  if (toAdd.length === 0) {
    console.log('\nAll addresses already whitelisted.');
    return;
  }

  console.log(`\n${toAdd.length} to add.${dryRun ? ' [DRY RUN]' : ''}\n`);
  if (dryRun) return;

  const { safe, signer } = await initSigner(provider);
  const iface = new ethers.Interface(CHECKER_ABI);
  const publicProvider = new ethers.JsonRpcProvider(PUBLIC_RPC);
  const publicChecker = new ethers.Contract(ACTIVITY_CHECKER, CHECKER_ABI, publicProvider);

  for (const mech of toAdd) {
    const calldata = iface.encodeFunctionData('addToWhitelist', [mech.address]);
    const label = mech.serviceId ? `service ${mech.serviceId}` : mech.address;
    console.log(`Adding ${label} (${mech.address})...`);

    try {
      const receipt = await execSafeTx(safe, signer, ACTIVITY_CHECKER, calldata);
      console.log(`  TX: ${receipt.hash} (block ${receipt.blockNumber})`);
      await sleep(3000);
      const verified = await publicChecker.isWhitelisted(mech.address);
      console.log(`  Verified: ${verified}\n`);
    } catch (err: any) {
      console.error(`  FAILED: ${err.message}\n`);
      process.exit(1);
    }
  }
  console.log('Done.');
}

async function cmdRemove(addresses: string[]) {
  const dryRun = process.env.DRY_RUN === 'true';
  const provider = getProvider();
  const checker = new ethers.Contract(ACTIVITY_CHECKER, CHECKER_ABI, provider);

  const owner = await checker.owner();
  if (owner.toLowerCase() !== OPERATE_SAFE.toLowerCase()) {
    console.error(`Activity checker owner is ${owner}, not the Operate Safe`);
    process.exit(1);
  }

  // Filter to those actually whitelisted
  const toRemove: string[] = [];
  for (const addr of addresses) {
    const whitelisted = await checker.isWhitelisted(addr);
    if (whitelisted) {
      toRemove.push(addr);
    } else {
      console.log(`  ${addr} is not whitelisted, skipping`);
    }
  }

  if (toRemove.length === 0) {
    console.log('Nothing to remove.');
    return;
  }

  console.log(`\n${toRemove.length} to remove.${dryRun ? ' [DRY RUN]' : ''}\n`);
  if (dryRun) return;

  const { safe, signer } = await initSigner(provider);
  const iface = new ethers.Interface(CHECKER_ABI);
  const publicProvider = new ethers.JsonRpcProvider(PUBLIC_RPC);
  const publicChecker = new ethers.Contract(ACTIVITY_CHECKER, CHECKER_ABI, publicProvider);

  for (const addr of toRemove) {
    const calldata = iface.encodeFunctionData('removeFromWhitelist', [addr]);
    console.log(`Removing ${addr}...`);

    try {
      const receipt = await execSafeTx(safe, signer, ACTIVITY_CHECKER, calldata);
      console.log(`  TX: ${receipt.hash} (block ${receipt.blockNumber})`);
      await sleep(3000);
      const verified = await publicChecker.isWhitelisted(addr);
      console.log(`  Verified removed: ${!verified}\n`);
    } catch (err: any) {
      console.error(`  FAILED: ${err.message}\n`);
      process.exit(1);
    }
  }
  console.log('Done.');
}

async function cmdCheck(address: string) {
  const provider = getProvider();
  const checker = new ethers.Contract(ACTIVITY_CHECKER, CHECKER_ABI, provider);
  const whitelisted = await checker.isWhitelisted(address);
  console.log(`${address}: isWhitelisted=${whitelisted}`);
}

// --- CLI ---

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || command === '--help' || command === '-h') {
    console.log(`Usage: tsx scripts/activity-checker-whitelist.ts <command> [args]

Commands:
  list                          Show whitelist status for all staked mechs
  add <addr> [addr...]          Add mech addresses to the whitelist
  add --from-staking            Auto-discover and add all staked mechs
  remove <addr> [addr...]       Remove mech addresses from the whitelist
  check <addr>                  Check if an address is whitelisted

Environment:
  RPC_URL / BASE_RPC_URL        Required (Tenderly)
  OPERATE_PASSWORD              Required for add/remove
  DRY_RUN=true                  Simulate without transactions

Contracts:
  Jinn Staking:     ${JINN_STAKING}
  Activity Checker: ${ACTIVITY_CHECKER}
  Operate Safe:     ${OPERATE_SAFE}`);
    return;
  }

  switch (command) {
    case 'list':
      await cmdList();
      break;
    case 'add': {
      const fromStaking = args.includes('--from-staking');
      const addresses = args.slice(1).filter(a => a !== '--from-staking');
      if (!fromStaking && addresses.length === 0) {
        console.error('Provide mech addresses or use --from-staking');
        process.exit(1);
      }
      await cmdAdd(addresses, fromStaking);
      break;
    }
    case 'remove': {
      const addresses = args.slice(1);
      if (addresses.length === 0) {
        console.error('Provide mech addresses to remove');
        process.exit(1);
      }
      await cmdRemove(addresses);
      break;
    }
    case 'check': {
      if (!args[1]) {
        console.error('Provide an address to check');
        process.exit(1);
      }
      await cmdCheck(args[1]);
      break;
    }
    default:
      console.error(`Unknown command: ${command}. Use --help for usage.`);
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
