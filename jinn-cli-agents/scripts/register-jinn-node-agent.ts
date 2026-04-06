#!/usr/bin/env tsx
/**
 * Register jinn-node as an OLAS Agent on Ethereum mainnet.
 *
 * Flow:
 *   1. Upload jinn-node service package to IPFS (wrap-with-directory)
 *   2. Build agent metadata JSON with OLAS marketplace required fields
 *   3. Upload metadata to IPFS
 *   4. Extract raw SHA-256 digest from IPFS CID (NOT keccak256!)
 *   5. Call RegistriesManager.create(1, ownerAddress, sha256Digest, [componentId])
 *   6. Parse agent ID from ERC721 Transfer event
 *
 * Usage:
 *   tsx scripts/register-jinn-node-agent.ts [--dry-run]
 *   tsx scripts/register-jinn-node-agent.ts --component-id 315 [--dry-run]
 */

import dotenv from 'dotenv';
import { JsonRpcProvider, Wallet, Contract } from 'ethers';
import bs58 from 'bs58';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import {
  getMasterPrivateKey,
} from 'jinn-node/env/operate-profile.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load .env from both monorepo root and jinn-node/
dotenv.config({ path: path.resolve(__dirname, '../.env') });
dotenv.config({ path: path.resolve(__dirname, '../jinn-node/.env') });

// ============================================================================
// Config
// ============================================================================

// RegistriesManager on Ethereum mainnet — the ONLY entry point for creating
// components and agents. Direct calls to AgentRegistry revert with ManagerOnly.
const REGISTRIES_MANAGER_ADDRESS = '0x9eC9156dEF5C613B2a7D4c46C383F9B58DfcD6fE';

// Ethereum mainnet RPC
const ETH_RPC_URL = process.env.ETH_RPC_URL || 'https://ethereum-rpc.publicnode.com';

// Owner for the agent — Venture Safe
const AGENT_OWNER = '0x900Db2954a6c14C011dBeBE474e3397e58AE5421';

// Jinn Template Specification component (dependency)
const DEFAULT_COMPONENT_ID = 315;

// IPFS gateway for verification
const IPFS_GATEWAY = 'https://gateway.autonolas.tech/ipfs';

// Jinn logo CID (same as agents 98-102)
const JINN_LOGO_CID = 'QmfW97dN9xPZjPCR5ct24xRZzTeFq62Yy7BHNaQFWpPGbR';

// Service package directory
const SERVICE_PACKAGE_DIR = path.resolve(__dirname, '../packages/jinn/services/jinn_node');

// RegistriesManager ABI — only the functions we need
// NOTE: UnitType is an enum which encodes as uint8 in the ABI, NOT uint256
const REGISTRIES_MANAGER_ABI = [
  'function create(uint8 unitType, address unitOwner, bytes32 unitHash, uint32[] dependencies) returns (uint256 unitId)',
];

// ERC721 Transfer event topic (for parsing minted token ID)
const TRANSFER_EVENT_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

// ============================================================================
// CLI Argument Parsing
// ============================================================================

function parseArgs(): { componentId: number; dryRun: boolean } {
  const args = process.argv.slice(2);
  let componentId = DEFAULT_COMPONENT_ID;
  let dryRun = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--component-id' && args[i + 1]) {
      componentId = parseInt(args[i + 1], 10);
      i++;
    } else if (args[i] === '--dry-run') {
      dryRun = true;
    }
  }

  return { componentId, dryRun };
}

// ============================================================================
// IPFS Upload
// ============================================================================

async function uploadFileToIpfs(filePath: string, filename: string): Promise<string> {
  const content = fs.readFileSync(filePath);
  const blob = new Blob([content], { type: 'application/octet-stream' });
  const formData = new FormData();
  formData.append('file', blob, filename);

  const res = await fetch('https://registry.autonolas.tech/api/v0/add?wrap-with-directory=false', {
    method: 'POST',
    body: formData,
  });

  if (!res.ok) {
    throw new Error(`IPFS upload failed: ${res.status} ${res.statusText}`);
  }

  const data = await res.json() as { Hash: string; Name: string; Size: string };
  return data.Hash;
}

async function uploadJsonToIpfs(metadata: object, filename: string): Promise<string> {
  const blob = new Blob([JSON.stringify(metadata, null, 2)], { type: 'application/json' });
  const formData = new FormData();
  formData.append('file', blob, filename);

  const res = await fetch('https://registry.autonolas.tech/api/v0/add?wrap-with-directory=false', {
    method: 'POST',
    body: formData,
  });

  if (!res.ok) {
    throw new Error(`IPFS upload failed: ${res.status} ${res.statusText}`);
  }

  const data = await res.json() as { Hash: string; Name: string; Size: string };
  return data.Hash;
}

async function uploadServicePackage(): Promise<string> {
  console.log('\n  Phase 1b: Uploading service package to IPFS');
  console.log('  ─────────────────────────────────────────────');

  // Upload as wrapped directory (both files)
  const serviceYamlPath = path.join(SERVICE_PACKAGE_DIR, 'service.yaml');
  const readmePath = path.join(SERVICE_PACKAGE_DIR, 'README.md');

  if (!fs.existsSync(serviceYamlPath)) {
    throw new Error(`service.yaml not found at ${serviceYamlPath}`);
  }
  if (!fs.existsSync(readmePath)) {
    throw new Error(`README.md not found at ${readmePath}`);
  }

  // Upload as a directory (wrap-with-directory=true)
  const serviceYaml = fs.readFileSync(serviceYamlPath);
  const readme = fs.readFileSync(readmePath);

  const formData = new FormData();
  formData.append('file', new Blob([serviceYaml]), 'jinn_node/service.yaml');
  formData.append('file', new Blob([readme]), 'jinn_node/README.md');

  const res = await fetch('https://registry.autonolas.tech/api/v0/add?wrap-with-directory=true&pin=true', {
    method: 'POST',
    body: formData,
  });

  if (!res.ok) {
    throw new Error(`IPFS package upload failed: ${res.status} ${res.statusText}`);
  }

  // The response contains multiple lines (one per file + directory wrapper)
  const text = await res.text();
  const lines = text.trim().split('\n');

  // Parse each line as JSON, find the directory entry (the one wrapping everything)
  let dirCid = '';
  for (const line of lines) {
    const entry = JSON.parse(line);
    console.log(`    Uploaded: ${entry.Name} → ${entry.Hash}`);
    // The directory entry has an empty name or is the last entry
    if (entry.Name === '' || entry.Name === 'jinn_node') {
      dirCid = entry.Hash;
    }
  }

  if (!dirCid) {
    // Fallback: use the last entry which is typically the directory
    const lastEntry = JSON.parse(lines[lines.length - 1]);
    dirCid = lastEntry.Hash;
  }

  console.log(`    Package directory CID: ${dirCid}`);
  console.log(`    Verify: ${IPFS_GATEWAY}/${dirCid}/service.yaml`);

  return dirCid;
}

// ============================================================================
// Hash Computation
// ============================================================================

/**
 * Extract the raw SHA-256 digest from an IPFS CIDv0 (Qm...) for on-chain unitHash.
 *
 * CRITICAL: OLAS on-chain hash is the raw SHA-256 from the IPFS CID, NOT keccak256!
 * CIDv0 = base58btc(0x1220 + sha256_digest) -> strip 2-byte prefix -> bytes32
 */
function cidToBytes32(ipfsCid: string): string {
  const decoded = bs58.decode(ipfsCid);
  // Verify multihash prefix: 0x12 = sha2-256, 0x20 = 32 bytes
  if (decoded[0] !== 0x12 || decoded[1] !== 0x20) {
    throw new Error(`Unexpected CID multihash prefix: 0x${decoded[0].toString(16)}${decoded[1].toString(16)} (expected 0x1220)`);
  }
  const sha256Digest = decoded.slice(2);
  if (sha256Digest.length !== 32) {
    throw new Error(`SHA-256 digest is ${sha256Digest.length} bytes, expected 32`);
  }
  return '0x' + Buffer.from(sha256Digest).toString('hex');
}

// ============================================================================
// Agent Registration
// ============================================================================

let _manager: Contract | null = null;
function getManager(privateKey: string): Contract {
  if (!_manager) {
    const provider = new JsonRpcProvider(ETH_RPC_URL);
    const wallet = new Wallet(privateKey, provider);
    _manager = new Contract(REGISTRIES_MANAGER_ADDRESS, REGISTRIES_MANAGER_ABI, wallet);
  }
  return _manager;
}

/**
 * Parse agent ID from the ERC721 Transfer event in the tx receipt.
 *
 * The RegistriesManager.create() mints an NFT via the AgentRegistry.
 * The Transfer event topic[3] contains the token ID (= agent ID).
 *
 * NOTE: parseCreateUnitEvent / parseCreateAgentEvent from OlasContractHelpers
 * can fail due to ABI mismatch with log encoding. The ERC721 Transfer event
 * is more reliable.
 */
function parseAgentIdFromReceipt(receipt: any): number | null {
  for (const log of receipt.logs) {
    if (log.topics && log.topics[0] === TRANSFER_EVENT_TOPIC) {
      // topics[1] = from (0x0 for mint), topics[2] = to, topics[3] = tokenId
      const from = log.topics[1];
      // Check it's a mint (from = zero address)
      if (from === '0x0000000000000000000000000000000000000000000000000000000000000000') {
        const tokenId = parseInt(log.topics[3], 16);
        return tokenId;
      }
    }
  }
  return null;
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  const { componentId, dryRun } = parseArgs();

  console.log('\nRegistering jinn-node as OLAS Agent');
  console.log('═'.repeat(50));
  if (dryRun) console.log('  Mode: DRY RUN');
  console.log(`  Component dependency: ${componentId}`);
  console.log(`  Owner: ${AGENT_OWNER}`);
  console.log(`  RPC: ${ETH_RPC_URL}`);

  const masterPrivateKey = getMasterPrivateKey();
  if (!masterPrivateKey) {
    console.error('Cannot get master private key. Set OPERATE_PASSWORD and OPERATE_PROFILE_DIR env vars.');
    console.error('Example: OPERATE_PROFILE_DIR=./olas-operate-middleware/.operate');
    process.exit(1);
  }

  const wallet = new Wallet(masterPrivateKey);
  console.log(`  Sender (Master EOA): ${wallet.address}`);

  // ── Phase 1b: Upload service package ──
  let servicePackageCid: string;
  if (dryRun) {
    servicePackageCid = 'QmDRYRUN_SERVICE_PACKAGE';
    console.log(`\n  [DRY-RUN] Would upload service package to IPFS`);
    console.log(`    Package dir: ${SERVICE_PACKAGE_DIR}`);
  } else {
    servicePackageCid = await uploadServicePackage();
  }

  // ── Phase 1: Build + upload agent metadata ──
  console.log('\n  Phase 1: Registering jinn-node agent');
  console.log('  ─────────────────────────────────────');

  const metadata = {
    // OLAS marketplace required fields (verified against working agent 98)
    name: 'jinn/jinn-node:1.0.0',
    description: 'Jinn Network worker node. Claims and executes jobs from the Jinn Marketplace, runs AI agents with MCP tools, and delivers results on-chain via IPFS.',
    code_uri: `ipfs://${servicePackageCid}`,
    image: `ipfs://${JINN_LOGO_CID}`,
    attributes: [{ trait_type: 'version', value: '1.0.0' }],
    // Custom fields (stored but not rendered by marketplace)
    tags: ['jinn', 'worker', 'mech', 'ai-agent', 'marketplace'],
    network: 'base',
  };

  console.log(`    name: ${metadata.name}`);
  console.log(`    code_uri: ${metadata.code_uri}`);
  console.log(`    image: ${metadata.image}`);

  let metadataCid: string;
  if (dryRun) {
    metadataCid = 'QmDRYRUN_METADATA';
    console.log(`    [DRY-RUN] Would upload metadata to IPFS`);
    console.log(`    Metadata: ${JSON.stringify(metadata, null, 2)}`);
  } else {
    console.log('    Uploading agent metadata to IPFS...');
    metadataCid = await uploadJsonToIpfs(metadata, 'jinn-node-metadata.json');
    console.log(`    Metadata CID: ${metadataCid}`);
    console.log(`    Verify: ${IPFS_GATEWAY}/${metadataCid}`);
  }

  // Compute on-chain hash (SHA-256 digest from CID)
  const agentHash = dryRun ? '0x' + '00'.repeat(32) : cidToBytes32(metadataCid);
  console.log(`    Agent hash (SHA-256 digest): ${agentHash}`);

  // ── Register on-chain ──
  const manager = getManager(masterPrivateKey);

  if (dryRun) {
    console.log('\n    --- DRY RUN ---');
    console.log('    RegistriesManager.create() params:');
    console.log('      unitType: 1 (Agent)');
    console.log(`      owner: ${AGENT_OWNER}`);
    console.log(`      hash: ${agentHash}`);
    console.log(`      dependencies: [${componentId}]`);

    try {
      const gasEstimate = await manager.create.estimateGas(1, AGENT_OWNER, agentHash, [componentId]);
      console.log(`      Gas estimate: ${gasEstimate.toString()} OK`);
    } catch (err: any) {
      console.error(`      Gas estimate FAILED: ${err.message}`);
      console.error(`      The create call would revert on-chain.`);
    }
  } else {
    console.log(`\n    Submitting RegistriesManager.create(Agent) on Ethereum mainnet...`);
    console.log(`      Owner: ${AGENT_OWNER}`);
    console.log(`      Dependencies: [${componentId}]`);

    // Set explicit gas params to avoid stuck TXs
    const feeData = await manager.runner!.provider!.getFeeData();
    const baseFee = feeData.gasPrice ?? 500_000_000n;
    const maxPriorityFeePerGas = 1_500_000_000n; // 1.5 gwei tip
    const maxFeePerGas = baseFee * 2n + maxPriorityFeePerGas;

    console.log(`      Gas: maxFee=${Number(maxFeePerGas) / 1e9}gwei priority=${Number(maxPriorityFeePerGas) / 1e9}gwei`);

    const tx = await manager.create(1, AGENT_OWNER, agentHash, [componentId], {
      maxFeePerGas,
      maxPriorityFeePerGas,
    });
    console.log(`      TX hash: ${tx.hash}`);
    console.log(`      Etherscan: https://etherscan.io/tx/${tx.hash}`);

    const receipt = await tx.wait(1, 120_000);
    console.log(`      Confirmed in block: ${receipt.blockNumber}`);

    // Parse agent ID from ERC721 Transfer event
    const agentId = parseAgentIdFromReceipt(receipt);
    if (agentId === null) {
      console.error('      WARNING: Could not parse agent ID from receipt.');
      console.error('      Check the transaction on Etherscan to find the minted agent ID.');
      console.error(`      https://etherscan.io/tx/${tx.hash}`);
    } else {
      console.log(`\n    Agent ID: ${agentId}`);
      console.log(`    Marketplace: https://registry.olas.network/ethereum/agents/${agentId}`);
      console.log(`\n    Next steps:`);
      console.log(`      1. Update ServiceConfig.ts: DEFAULT_AGENT_ID = ${agentId}`);
      console.log(`      2. Update ServiceConfig.ts: DEFAULT_SERVICE_HASH = "${servicePackageCid}"`);
      console.log(`      3. Deploy new staking contract: tsx scripts/deploy-jin-staking.ts --agent-id=${agentId}`);
    }
  }

  console.log('\nDone.');
  if (dryRun) {
    console.log('--- DRY RUN COMPLETE ---');
    console.log('No transactions were submitted. Remove --dry-run to register for real.');
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
