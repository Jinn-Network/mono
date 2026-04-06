#!/usr/bin/env tsx
/**
 * Update OLAS metadata hashes for existing agents and component.
 *
 * Updates agents 98-102 on ETH mainnet with corrected metadata:
 * - code_uri pointing to x402.jinn.network/agents/{slug}/execute
 * - OLAS marketplace required fields (name, description, image, attributes)
 * - Correct SHA-256 digest hash (not keccak256)
 *
 * Also updates component 315 (Jinn Template Specification) with
 * corrected gateway URLs.
 *
 * Usage:
 *   tsx scripts/update-olas-metadata.ts [--dry-run]
 *   tsx scripts/update-olas-metadata.ts --agents-only [--dry-run]
 *   tsx scripts/update-olas-metadata.ts --component-only [--dry-run]
 */

import 'dotenv/config';
import { JsonRpcProvider, Wallet, Contract } from 'ethers';
import bs58 from 'bs58';
import { getTemplateBySlug } from './templates/crud.js';
import {
  REGISTRIES_MANAGER_ABI,
} from '../jinn-node/src/worker/contracts/OlasContractInterfaces.js';
import {
  getMasterPrivateKey,
} from 'jinn-node/env/operate-profile.js';

// ============================================================================
// Config
// ============================================================================

const REGISTRIES_MANAGER_ADDRESS = '0x9eC9156dEF5C613B2a7D4c46C383F9B58DfcD6fE';
const ETH_RPC_URL = process.env.ETH_RPC_URL || 'https://ethereum-rpc.publicnode.com';
const GATEWAY_BASE_URL = process.env.X402_GATEWAY_URL || 'https://x402.jinn.network';
const IPFS_GATEWAY = 'https://gateway.autonolas.tech/ipfs';
const JINN_LOGO_CID = 'QmfW97dN9xPZjPCR5ct24xRZzTeFq62Yy7BHNaQFWpPGbR';

// Current on-chain registrations (re-minted Feb 2026)
const COMPONENT_ID = 315;

// Agent ID -> template slug mapping (agents 98-102 on ETH mainnet)
const AGENT_MAP: Record<number, string> = {
  98: 'crypto-token-research',
  99: 'governance-digest',
  100: 'competitive-landscape',
  101: 'code-repository-audit',
  102: 'content-campaign',
};

// ============================================================================
// CLI Argument Parsing
// ============================================================================

function parseArgs(): { agentsOnly: boolean; componentOnly: boolean; dryRun: boolean } {
  const args = process.argv.slice(2);
  return {
    agentsOnly: args.includes('--agents-only'),
    componentOnly: args.includes('--component-only'),
    dryRun: args.includes('--dry-run'),
  };
}

// ============================================================================
// IPFS Upload
// ============================================================================

async function uploadToIpfs(metadata: object, filename: string): Promise<string> {
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

// ============================================================================
// Hash Computation
// ============================================================================

/**
 * Extract the raw SHA-256 digest from an IPFS CIDv0 (Qm...) for on-chain unitHash.
 *
 * CRITICAL: OLAS on-chain hash is the raw SHA-256 from the IPFS CID, NOT keccak256!
 * CIDv0 = base58btc(0x1220 + sha256_digest) -> strip 2-byte prefix -> bytes32
 */
function computeUnitHash(ipfsCid: string): string {
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
// Contract Interaction
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

async function updateHash(
  unitType: number, // 0 = Component, 1 = Agent
  unitId: number,
  newHash: string,
  privateKey: string,
  dryRun: boolean,
): Promise<void> {
  const manager = getManager(privateKey);
  const typeName = unitType === 0 ? 'Component' : 'Agent';

  if (dryRun) {
    console.log(`    [DRY-RUN] Would call updateHash(${unitType}, ${unitId}, ${newHash})`);
    try {
      const gasEstimate = await manager.updateHash.estimateGas(unitType, unitId, newHash);
      console.log(`    Gas estimate: ${gasEstimate.toString()} OK`);
    } catch (err: any) {
      console.error(`    Gas estimate FAILED: ${err.message}`);
      console.error(`    The updateHash call would revert on-chain.`);
    }
    return;
  }

  console.log(`    Submitting updateHash(${typeName}, ${unitId}) on Ethereum mainnet...`);

  const feeData = await manager.runner!.provider!.getFeeData();
  const baseFee = feeData.gasPrice ?? 500_000_000n;
  const maxPriorityFeePerGas = 1_500_000_000n; // 1.5 gwei
  const maxFeePerGas = baseFee * 2n + maxPriorityFeePerGas;

  console.log(`    Gas: maxFee=${Number(maxFeePerGas) / 1e9}gwei priority=${Number(maxPriorityFeePerGas) / 1e9}gwei`);

  const tx = await manager.updateHash(unitType, unitId, newHash, {
    maxFeePerGas,
    maxPriorityFeePerGas,
  });
  console.log(`    TX hash: ${tx.hash}`);

  const receipt = await tx.wait(1, 120_000);
  console.log(`    Confirmed in block: ${receipt.blockNumber}`);
}

// ============================================================================
// Update Agent Metadata
// ============================================================================

async function updateAgentMetadata(
  agentId: number,
  slug: string,
  privateKey: string,
  dryRun: boolean,
): Promise<void> {
  console.log(`\n  -- Agent ${agentId}: ${slug} --`);

  const template = await getTemplateBySlug(slug);
  if (!template) {
    console.error(`    SKIP: Template not found: ${slug}`);
    return;
  }

  console.log(`    Template: ${template.name} (${template.id})`);

  // Build metadata with OLAS marketplace required fields
  const metadata = {
    // OLAS marketplace required fields
    name: `jinn/${template.slug}:${template.version || '1.0.0'}`,
    description: template.description || '',
    code_uri: `${GATEWAY_BASE_URL}/agents/${template.slug}/execute`,
    image: `ipfs://${JINN_LOGO_CID}`,
    attributes: [{ trait_type: 'version', value: template.version || '1.0.0' }],
    // x402 discovery
    x402Endpoint: `${GATEWAY_BASE_URL}/agents/${template.slug}/execute`,
    discoveryUrl: `${GATEWAY_BASE_URL}/.well-known/x402`,
    // Template details
    inputSchema: template.input_schema,
    outputSpec: template.output_spec,
    tags: template.tags,
    templateSlug: template.slug,
    network: 'base',
  };

  // Upload to IPFS
  let ipfsCid: string;
  if (dryRun) {
    ipfsCid = `QmDRYRUN_${slug}`;
    console.log(`    [DRY-RUN] Would upload metadata to IPFS`);
    console.log(`    code_uri: ${metadata.code_uri}`);
    console.log(`    Metadata: ${JSON.stringify(metadata, null, 2)}`);
  } else {
    console.log('    Uploading corrected metadata to IPFS...');
    ipfsCid = await uploadToIpfs(metadata, `${slug}-metadata.json`);
    console.log(`    CID: ${ipfsCid}`);
    console.log(`    URL: ${IPFS_GATEWAY}/${ipfsCid}`);
    console.log(`    code_uri: ${metadata.code_uri}`);
  }

  // Compute new hash (SHA-256 digest from CID) and update on-chain
  const newHash = dryRun ? '0x' + '00'.repeat(32) : computeUnitHash(ipfsCid);
  console.log(`    New hash (SHA-256 digest): ${newHash}`);
  await updateHash(1, agentId, newHash, privateKey, dryRun);
}

// ============================================================================
// Update Component Metadata
// ============================================================================

async function updateComponentMetadata(
  privateKey: string,
  dryRun: boolean,
): Promise<void> {
  console.log(`\n  -- Component ${COMPONENT_ID}: Jinn Template Specification --`);

  // Build the same schema metadata as register-olas-component.ts
  const metadata = {
    // OLAS marketplace required fields
    name: 'jinn/template-specification:1.0.0',
    description: 'Canonical schema for Jinn Network reusable job templates. Templates define outcomes via invariants, tool access policy, model policy, input parameters, and structured output extraction. This component is shared by all Jinn agents registered in the OLAS protocol.',
    code_uri: `${GATEWAY_BASE_URL}/.well-known/x402`,
    image: `ipfs://${JINN_LOGO_CID}`,
    attributes: [{ trait_type: 'version', value: '1.0.0' }],
    // JSON Schema fields
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://jinn.network/schemas/template/v1.0.0",
    "title": "Jinn Template Specification",
    "version": "1.0.0",
    "network": "base",
    "x402Gateway": GATEWAY_BASE_URL,
    "discoveryUrl": `${GATEWAY_BASE_URL}/.well-known/x402`,
    "type": "object",
    "required": ["name", "blueprint"],
    "properties": {
      "name": { "type": "string", "description": "Human-readable template name." },
      "slug": { "type": "string", "pattern": "^[a-z0-9]+(-[a-z0-9]+)*$" },
      "blueprint": {
        "type": "object",
        "required": ["invariants"],
        "description": "Blueprint containing invariants (outcome specifications)."
      },
      "inputSchema": { "type": "object" },
      "outputSpec": { "type": "object" },
      "enabledTools": { "type": "array", "items": { "type": "string" } },
      "tags": { "type": "array", "items": { "type": "string" } },
      "priceWei": { "type": ["string", "null"] },
      "priceUsd": { "type": ["string", "null"] },
    }
  };

  let ipfsCid: string;
  if (dryRun) {
    ipfsCid = 'QmDRYRUN_component';
    console.log(`    [DRY-RUN] Would upload component metadata to IPFS`);
  } else {
    console.log('    Uploading corrected component metadata to IPFS...');
    ipfsCid = await uploadToIpfs(metadata, 'jinn-template-spec.json');
    console.log(`    CID: ${ipfsCid}`);
    console.log(`    URL: ${IPFS_GATEWAY}/${ipfsCid}`);
  }

  const newHash = dryRun ? '0x' + '00'.repeat(32) : computeUnitHash(ipfsCid);
  console.log(`    New hash (SHA-256 digest): ${newHash}`);
  await updateHash(0, COMPONENT_ID, newHash, privateKey, dryRun);
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  const { agentsOnly, componentOnly, dryRun } = parseArgs();

  console.log('\nUpdating OLAS metadata hashes');
  if (dryRun) console.log('  Mode: DRY RUN');

  const masterPrivateKey = getMasterPrivateKey();
  if (!masterPrivateKey) {
    console.error('Cannot get master private key. Set OPERATE_PASSWORD env var.');
    process.exit(1);
  }

  const wallet = new Wallet(masterPrivateKey);
  console.log(`  Sender (Master EOA): ${wallet.address}`);
  console.log(`  Gateway: ${GATEWAY_BASE_URL}`);
  console.log(`  RPC: ${ETH_RPC_URL}`);

  // Update component
  if (!agentsOnly) {
    try {
      await updateComponentMetadata(masterPrivateKey, dryRun);
    } catch (err: any) {
      console.error(`  FAIL (component ${COMPONENT_ID}): ${err.message}`);
    }
  }

  // Update agents
  if (!componentOnly) {
    const agentEntries = Object.entries(AGENT_MAP);
    for (let i = 0; i < agentEntries.length; i++) {
      const [agentIdStr, slug] = agentEntries[i];
      const agentId = parseInt(agentIdStr, 10);
      try {
        await updateAgentMetadata(agentId, slug, masterPrivateKey, dryRun);
        // Brief delay between updates to avoid RPC rate limiting
        if (!dryRun && i < agentEntries.length - 1) {
          console.log('    (waiting 5s before next update...)');
          await new Promise(r => setTimeout(r, 5000));
        }
      } catch (err: any) {
        console.error(`  FAIL (agent ${agentId}): ${err.message}`);
      }
    }
  }

  console.log('\nDone.');
  if (dryRun) {
    console.log('--- DRY RUN COMPLETE ---');
    console.log('No transactions were submitted. Remove --dry-run to update for real.');
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
