#!/usr/bin/env tsx
/**
 * Mint an OLAS Agent Registry entry for a Jinn template.
 *
 * Flow:
 *   1. Fetch template from Supabase by slug
 *   2. Build OLAS-compatible metadata JSON (name, description, image, code_uri, attributes)
 *   3. Upload metadata to IPFS via Autonolas registry
 *   4. Extract raw SHA-256 digest from IPFS CID (NOT keccak256!)
 *      CIDv0 = base58btc(0x1220 + sha256digest) → strip 2-byte prefix → bytes32
 *   5. Call RegistriesManager.create(1, ownerAddress, sha256Digest, [componentId])
 *   6. Parse CreateUnit event → extract agentId
 *   7. Store agentId back in Supabase template record
 *
 * Usage:
 *   tsx scripts/mint-olas-agent.ts --templateSlug <slug> --componentId <id> [--dry-run]
 *   tsx scripts/mint-olas-agent.ts --all --componentId <id> [--dry-run]
 */

import 'dotenv/config';
import { JsonRpcProvider, Wallet, Contract } from 'ethers';
import bs58 from 'bs58';
import { getTemplateBySlug, updateTemplate } from './templates/crud.js';
import {
  REGISTRIES_MANAGER_ABI,
  OlasContractHelpers,
} from '../jinn-node/src/worker/contracts/OlasContractInterfaces.js';
import {
  getMasterPrivateKey,
} from 'jinn-node/env/operate-profile.js';

// ============================================================================
// Config
// ============================================================================

// RegistriesManager on Ethereum mainnet — the ONLY entry point for creating
// components and agents. Direct calls to AgentRegistry revert with ManagerOnly.
// See blood-written-rules.md #66, #67.
const REGISTRIES_MANAGER_ADDRESS = '0x9eC9156dEF5C613B2a7D4c46C383F9B58DfcD6fE';

// Ethereum mainnet RPC (AgentRegistry is ONLY on mainnet, not Base)
const ETH_RPC_URL = process.env.ETH_RPC_URL || 'https://eth.llamarpc.com';

// x402 gateway base URL — used in metadata to point to the agent's execute endpoint
const GATEWAY_BASE_URL = process.env.X402_GATEWAY_URL
  || 'https://x402-gateway-production-1b84.up.railway.app';

// Owner for agents — Venture Safe
const AGENT_OWNER = '0x900Db2954a6c14C011dBeBE474e3397e58AE5421';

// IPFS gateway for verification
const IPFS_GATEWAY = 'https://gateway.autonolas.tech/ipfs';

// All 5 x402 template slugs
const ALL_TEMPLATE_SLUGS = [
  'crypto-token-research',
  'governance-digest',
  'competitive-landscape',
  'code-repository-audit',
  'content-campaign',
];

// ============================================================================
// CLI Argument Parsing
// ============================================================================

function parseArgs(): { templateSlugs: string[]; componentId: number; dryRun: boolean } {
  const args = process.argv.slice(2);
  let templateSlug = '';
  let componentId = 0;
  let dryRun = false;
  let all = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--templateSlug' && args[i + 1]) {
      templateSlug = args[i + 1];
      i++;
    } else if (args[i] === '--componentId' && args[i + 1]) {
      componentId = parseInt(args[i + 1], 10);
      i++;
    } else if (args[i] === '--dry-run') {
      dryRun = true;
    } else if (args[i] === '--all') {
      all = true;
    }
  }

  if (!componentId) {
    console.error('--componentId is required. Register a component first:');
    console.error('  tsx scripts/register-olas-component.ts');
    process.exit(1);
  }

  const templateSlugs = all ? ALL_TEMPLATE_SLUGS : templateSlug ? [templateSlug] : [];
  if (templateSlugs.length === 0) {
    console.error('Usage: tsx scripts/mint-olas-agent.ts --templateSlug <slug> --componentId <id> [--dry-run]');
    console.error('       tsx scripts/mint-olas-agent.ts --all --componentId <id> [--dry-run]');
    process.exit(1);
  }

  return { templateSlugs, componentId, dryRun };
}

// ============================================================================
// IPFS Upload
// ============================================================================

interface OlasAgentMetadata {
  name: string;
  description: string;
  code_uri: string;
  image: string;
  attributes: Array<{ trait_type: string; value: string }>;
  // Custom Jinn fields (marketplace ignores but useful for x402 discovery)
  x402Endpoint: string;
  inputSchema: object;
  outputSpec: object;
  tags: string[];
  priceWei: string | null;
  priceUsd: string | null;
  templateSlug: string;
  network: string;
}

async function uploadToIpfs(metadata: OlasAgentMetadata): Promise<string> {
  const blob = new Blob([JSON.stringify(metadata, null, 2)], { type: 'application/json' });
  const formData = new FormData();
  formData.append('file', blob, 'metadata.json');

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
// Agent Registration
// ============================================================================

/**
 * Extract the raw SHA-256 digest from an IPFS CIDv0 (Qm...) to use as on-chain unitHash.
 *
 * CIDv0 format: base58btc(multihash) where multihash = 0x1220 + sha256_digest
 *   0x12 = sha2-256 hash function code
 *   0x20 = 32 bytes (256 bits) digest length
 *
 * The OLAS registry stores this raw digest as bytes32, then reconstructs the full
 * IPFS CID in tokenURI() by prepending "f01701220" (CIDv1 base16 prefix).
 *
 * CRITICAL: Do NOT use keccak256 here — that produces a hash-of-a-hash that
 * points to nothing on IPFS. The marketplace will show "unpinned from IPFS".
 */
function cidToBytes32(ipfsCid: string): string {
  const decoded = bs58.decode(ipfsCid);
  // CIDv0: first 2 bytes are 0x12 (sha2-256) + 0x20 (32 bytes length)
  if (decoded[0] !== 0x12 || decoded[1] !== 0x20) {
    throw new Error(`Unexpected CID multihash prefix: 0x${decoded[0].toString(16)}${decoded[1].toString(16)} (expected 0x1220)`);
  }
  const sha256Digest = decoded.slice(2);
  if (sha256Digest.length !== 32) {
    throw new Error(`SHA-256 digest is ${sha256Digest.length} bytes, expected 32`);
  }
  return '0x' + Buffer.from(sha256Digest).toString('hex');
}

// Shared provider + contract — avoids rate-limiting from repeated connections
let _manager: Contract | null = null;
function getManager(privateKey: string): Contract {
  if (!_manager) {
    const provider = new JsonRpcProvider(ETH_RPC_URL);
    const wallet = new Wallet(privateKey, provider);
    _manager = new Contract(REGISTRIES_MANAGER_ADDRESS, REGISTRIES_MANAGER_ABI, wallet);
  }
  return _manager;
}

async function mintAgent(
  ownerAddress: string,
  agentHash: string,
  componentDependencies: number[],
  privateKey: string,
  dryRun: boolean,
): Promise<number | null> {
  const manager = getManager(privateKey);

  if (dryRun) {
    console.log('\n    --- DRY RUN ---');
    console.log('    RegistriesManager.create() params:');
    console.log('      unitType: 1 (Agent)');
    console.log('      owner:', ownerAddress);
    console.log('      hash:', agentHash);
    console.log('      dependencies:', componentDependencies);

    try {
      const gasEstimate = await manager.create.estimateGas(1, ownerAddress, agentHash, componentDependencies);
      console.log(`      Gas estimate: ${gasEstimate.toString()} ✓`);
    } catch (err: any) {
      console.error(`      Gas estimate FAILED: ${err.message}`);
    }

    return null;
  }

  console.log(`\n    Submitting RegistriesManager.create(Agent) on Ethereum mainnet...`);
  console.log(`      Owner: ${ownerAddress}`);
  console.log(`      Dependencies: [${componentDependencies.join(', ')}]`);

  // Set explicit gas params to avoid stuck TXs (free RPCs return 0 priority fee)
  const feeData = await manager.runner!.provider!.getFeeData();
  const baseFee = feeData.gasPrice ?? 500_000_000n; // fallback 0.5 gwei
  const maxPriorityFeePerGas = 1_500_000_000n; // 1.5 gwei tip
  const maxFeePerGas = baseFee * 2n + maxPriorityFeePerGas; // 2x base + tip

  console.log(`      Gas: maxFee=${Number(maxFeePerGas) / 1e9}gwei priority=${Number(maxPriorityFeePerGas) / 1e9}gwei`);

  const tx = await manager.create(1, ownerAddress, agentHash, componentDependencies, {
    maxFeePerGas,
    maxPriorityFeePerGas,
  });
  console.log(`      TX hash: ${tx.hash}`);

  const receipt = await tx.wait(1, 120_000); // 1 confirmation, 2min timeout
  console.log(`      Confirmed in block: ${receipt.blockNumber}`);

  const agentId = OlasContractHelpers.parseCreateUnitEvent(receipt);
  if (agentId === null) {
    throw new Error('CreateUnit event not found in transaction receipt');
  }

  console.log(`      Agent ID: ${agentId}`);
  return agentId;
}

// ============================================================================
// Single Template Minting
// ============================================================================

async function mintForTemplate(
  slug: string,
  componentId: number,
  masterPrivateKey: string,
  dryRun: boolean,
): Promise<void> {
  console.log(`\n  ── ${slug} ──`);

  const template = await getTemplateBySlug(slug);
  if (!template) {
    console.error(`    SKIP: Template not found: ${slug}`);
    return;
  }

  if ((template as any).olas_agent_id) {
    console.log(`    SKIP: Already has OLAS agent ID: ${(template as any).olas_agent_id}`);
    return;
  }

  console.log(`    Template: ${template.name} (${template.id})`);

  // Build metadata — must include OLAS marketplace required fields (name, description, image,
  // code_uri, attributes) PLUS our custom x402 fields.
  const metadata: OlasAgentMetadata = {
    // OLAS marketplace required fields
    name: `jinn/${template.slug}:${template.version}`,
    description: template.description || '',
    code_uri: `${GATEWAY_BASE_URL}/templates/${template.id}/execute`,
    image: 'ipfs://QmfW97dN9xPZjPCR5ct24xRZzTeFq62Yy7BHNaQFWpPGbR',
    attributes: [{ trait_type: 'version', value: template.version }],
    // Custom Jinn fields
    x402Endpoint: `${GATEWAY_BASE_URL}/templates/${template.id}/execute`,
    inputSchema: template.input_schema,
    outputSpec: template.output_spec,
    tags: template.tags,
    priceWei: template.price_wei,
    priceUsd: template.price_usd,
    templateSlug: template.slug,
    network: 'base',
  };

  // Upload to IPFS
  let ipfsCid: string;
  if (dryRun) {
    ipfsCid = `QmDRYRUN_${slug}`;
    console.log(`    [DRY-RUN] Would upload metadata to IPFS`);
  } else {
    console.log('    Uploading metadata to IPFS...');
    ipfsCid = await uploadToIpfs(metadata);
    console.log(`    CID: ${ipfsCid}`);
  }

  // Extract SHA-256 digest from CID for on-chain unitHash
  const agentHash = dryRun ? '0x' + '00'.repeat(32) : cidToBytes32(ipfsCid);
  console.log(`    Hash (SHA-256 digest): ${agentHash}`);
  const agentId = await mintAgent(AGENT_OWNER, agentHash, [componentId], masterPrivateKey, dryRun);

  // Store agentId in Supabase
  if (agentId !== null) {
    console.log(`    Storing agentId ${agentId} in template record...`);
    await updateTemplate({
      id: template.id,
      olasAgentId: agentId,
    });
    console.log(`    Done! → https://registry.olas.network/ethereum/agents/${agentId}`);
  }
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  const { templateSlugs, componentId, dryRun } = parseArgs();

  console.log(`\nMinting OLAS agents for ${templateSlugs.length} template(s)`);
  console.log(`  Component dependency: ${componentId}`);
  console.log(`  Owner: ${AGENT_OWNER}`);
  if (dryRun) console.log('  Mode: DRY RUN');

  const masterPrivateKey = getMasterPrivateKey();
  if (!masterPrivateKey) {
    console.error('Cannot get master private key. Set OPERATE_PASSWORD env var.');
    process.exit(1);
  }

  const wallet = new Wallet(masterPrivateKey);
  console.log(`  Sender (Master EOA): ${wallet.address}`);

  for (let i = 0; i < templateSlugs.length; i++) {
    const slug = templateSlugs[i];
    try {
      await mintForTemplate(slug, componentId, masterPrivateKey, dryRun);
      // Brief delay between mints to avoid RPC rate limiting
      if (!dryRun && i < templateSlugs.length - 1) {
        console.log('    (waiting 5s before next mint...)');
        await new Promise(r => setTimeout(r, 5000));
      }
    } catch (err: any) {
      console.error(`    FAIL: ${slug}: ${err.message}`);
    }
  }

  console.log('\nDone.');
  if (dryRun) {
    console.log('--- DRY RUN COMPLETE ---');
    console.log('No transactions were submitted. Remove --dry-run to mint for real.');
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
