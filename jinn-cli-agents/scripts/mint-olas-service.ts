#!/usr/bin/env tsx
/**
 * Mint OLAS services on Base that reference ETH mainnet agent IDs.
 *
 * Services are registered on Base via ServiceRegistryL2. They reference
 * agent IDs from the ETH mainnet AgentRegistry.
 *
 * Two modes:
 *   --single  : One service per agent (5 services total)
 *   --combined : One service with all 5 agents (default)
 *
 * Usage:
 *   tsx scripts/mint-olas-service.ts [--dry-run]
 *   tsx scripts/mint-olas-service.ts --single [--dry-run]
 *   tsx scripts/mint-olas-service.ts --combined [--dry-run]
 *   tsx scripts/mint-olas-service.ts --agentIds 88,89,90,91,92 [--dry-run]
 */

import 'dotenv/config';
import { JsonRpcProvider, Wallet, Contract } from 'ethers';
import bs58 from 'bs58';
import {
  SERVICE_MANAGER_L2_ABI,
  SERVICE_REGISTRY_L2_ABI,
  OlasContractHelpers,
} from '../jinn-node/src/worker/contracts/OlasContractInterfaces.js';
import {
  getMasterPrivateKey,
} from 'jinn-node/env/operate-profile.js';

// ============================================================================
// Config
// ============================================================================

// ServiceManagerToken on Base — MUST go through manager, not registry directly.
// Direct ServiceRegistryL2.create() reverts with ManagerOnly.
const SERVICE_MANAGER_ADDRESS = '0x1262136cac6a06A782DC94eb3a3dF0b4d09FF6A6';

// ServiceRegistryL2 on Base (for reads/events only)
const SERVICE_REGISTRY_L2_ADDRESS = '0x3C1fF68f5aa342D296d4DEe4Bb1cACCA912D95fE';

// Token for bonds in ServiceManager.create
// ETH sentinel address bypasses ServiceRegistryTokenUtility validation
// and uses native ETH path (bond=0 anyway so token doesn't matter)
const BOND_TOKEN = process.env.BOND_TOKEN || '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';

// Base RPC
const BASE_RPC_URL = process.env.BASE_RPC_URL || 'https://base-rpc.publicnode.com';

// Service owner — Venture Safe
const SERVICE_OWNER = '0x900Db2954a6c14C011dBeBE474e3397e58AE5421';

// Gateway URL for metadata
const GATEWAY_BASE_URL = process.env.X402_GATEWAY_URL
  || 'https://x402-gateway-production-1b84.up.railway.app';

// IPFS gateway
const IPFS_GATEWAY = 'https://gateway.autonolas.tech/ipfs';

// Default agent IDs (re-minted on ETH mainnet with correct SHA-256 hash + OLAS metadata)
const DEFAULT_AGENT_IDS = [98, 99, 100, 101, 102];

// Agent ID → descriptive name mapping for metadata
const AGENT_NAMES: Record<number, string> = {
  98: 'Crypto Token Researcher',
  99: 'Governance Analyst',
  100: 'Competitive Landscape Researcher',
  101: 'Code Repository Auditor',
  102: 'Content Campaign Manager',
};

// Agent ID → template slug mapping (for code_uri and metadata)
const AGENT_SLUGS: Record<number, string> = {
  98: 'crypto-token-research',
  99: 'governance-digest',
  100: 'competitive-landscape',
  101: 'code-repository-audit',
  102: 'content-campaign',
};

// Agent ID → image IPFS CID (using Jinn logo for now; swap with custom images later)
const AGENT_IMAGE_CIDS: Record<number, string> = {
  98: 'QmfW97dN9xPZjPCR5ct24xRZzTeFq62Yy7BHNaQFWpPGbR',
  99: 'QmfW97dN9xPZjPCR5ct24xRZzTeFq62Yy7BHNaQFWpPGbR',
  100: 'QmfW97dN9xPZjPCR5ct24xRZzTeFq62Yy7BHNaQFWpPGbR',
  101: 'QmfW97dN9xPZjPCR5ct24xRZzTeFq62Yy7BHNaQFWpPGbR',
  102: 'QmfW97dN9xPZjPCR5ct24xRZzTeFq62Yy7BHNaQFWpPGbR',
};

// Fallback image: Jinn logo
const DEFAULT_IMAGE_CID = 'QmfW97dN9xPZjPCR5ct24xRZzTeFq62Yy7BHNaQFWpPGbR';

// ============================================================================
// CLI Argument Parsing
// ============================================================================

function parseArgs(): {
  mode: 'single' | 'combined';
  agentIds: number[];
  dryRun: boolean;
} {
  const args = process.argv.slice(2);
  let mode: 'single' | 'combined' = 'combined';
  let agentIds = DEFAULT_AGENT_IDS;
  let dryRun = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--single') mode = 'single';
    else if (args[i] === '--combined') mode = 'combined';
    else if (args[i] === '--dry-run') dryRun = true;
    else if (args[i] === '--agentIds' && args[i + 1]) {
      agentIds = args[i + 1].split(',').map(id => parseInt(id.trim(), 10));
      i++;
    }
  }

  return { mode, agentIds, dryRun };
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
// Service Creation
// ============================================================================

/**
 * Extract raw SHA-256 digest from IPFS CIDv0 for on-chain configHash.
 * See mint-olas-agent.ts cidToBytes32() for detailed explanation.
 */
function cidToBytes32(ipfsCid: string): string {
  const decoded = bs58.decode(ipfsCid);
  if (decoded[0] !== 0x12 || decoded[1] !== 0x20) {
    throw new Error(`Unexpected CID multihash prefix: 0x${decoded[0].toString(16)}${decoded[1].toString(16)}`);
  }
  const sha256Digest = decoded.slice(2);
  if (sha256Digest.length !== 32) {
    throw new Error(`SHA-256 digest is ${sha256Digest.length} bytes, expected 32`);
  }
  return '0x' + Buffer.from(sha256Digest).toString('hex');
}

let _manager: Contract | null = null;
let _registry: Contract | null = null;
function getManager(privateKey: string): Contract {
  if (!_manager) {
    const provider = new JsonRpcProvider(BASE_RPC_URL);
    const wallet = new Wallet(privateKey, provider);
    _manager = new Contract(SERVICE_MANAGER_ADDRESS, SERVICE_MANAGER_L2_ABI, wallet);
  }
  return _manager;
}
function getRegistry(privateKey: string): Contract {
  if (!_registry) {
    const provider = new JsonRpcProvider(BASE_RPC_URL);
    const wallet = new Wallet(privateKey, provider);
    _registry = new Contract(SERVICE_REGISTRY_L2_ADDRESS, SERVICE_REGISTRY_L2_ABI, wallet);
  }
  return _registry;
}

async function createService(
  serviceOwner: string,
  configHash: string,
  agentIds: number[],
  privateKey: string,
  dryRun: boolean,
): Promise<number | null> {
  const manager = getManager(privateKey);

  // Each agent gets 1 slot, bond = 1 wei minimum (contract reverts ZeroValue on bond=0)
  const agentParams = agentIds.map(() => ({
    slots: 1,
    bond: 1n,
  }));
  // Threshold must be >= ceil(2/3 * totalSlots) per ServiceRegistry rules
  const totalSlots = agentIds.length;
  const threshold = Math.max(1, Math.ceil((totalSlots * 2) / 3));

  if (dryRun) {
    console.log('\n    --- DRY RUN ---');
    console.log('    ServiceManager.create() params:');
    console.log('      serviceOwner:', serviceOwner);
    console.log('      token:', BOND_TOKEN);
    console.log('      configHash:', configHash);
    console.log('      agentIds:', agentIds);
    console.log('      agentParams:', agentParams.map(p => `{slots: ${p.slots}, bond: ${p.bond}}`));
    console.log('      threshold:', threshold);

    try {
      const gasEstimate = await manager.create.estimateGas(
        serviceOwner, BOND_TOKEN, configHash, agentIds, agentParams, threshold,
      );
      console.log(`      Gas estimate: ${gasEstimate.toString()} OK`);
    } catch (err: any) {
      console.error(`      Gas estimate FAILED: ${err.message}`);
      console.error('      The transaction would revert on-chain.');
    }

    return null;
  }

  console.log(`\n    Submitting ServiceManager.create() on Base...`);
  console.log(`      Owner: ${serviceOwner}`);
  console.log(`      Token: ${BOND_TOKEN}`);
  console.log(`      Agents: [${agentIds.join(', ')}]`);
  console.log(`      Threshold: ${threshold}`);

  // Base gas params
  const feeData = await manager.runner!.provider!.getFeeData();
  const baseFee = feeData.gasPrice ?? 100_000_000n; // fallback 0.1 gwei
  const maxPriorityFeePerGas = 100_000_000n; // 0.1 gwei (Base is cheap)
  const maxFeePerGas = baseFee * 2n + maxPriorityFeePerGas;

  console.log(`      Gas: maxFee=${Number(maxFeePerGas) / 1e9}gwei priority=${Number(maxPriorityFeePerGas) / 1e9}gwei`);

  const tx = await manager.create(
    serviceOwner, BOND_TOKEN, configHash, agentIds, agentParams, threshold,
    { maxFeePerGas, maxPriorityFeePerGas },
  );
  console.log(`      TX hash: ${tx.hash}`);

  const receipt = await tx.wait(1, 60_000); // 1 confirmation, 1min timeout
  console.log(`      Confirmed in block: ${receipt.blockNumber}`);

  // Parse CreateService event from the registry (emitted by ServiceRegistryL2)
  const serviceId = OlasContractHelpers.parseCreateServiceEvent(receipt);
  if (serviceId !== null) {
    console.log(`      Service ID: ${serviceId}`);
    return serviceId;
  }

  // Fallback: extract from Transfer event (ERC721 mint)
  for (const log of receipt.logs) {
    if (log.topics?.[0] === '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef') {
      const tokenId = parseInt(log.topics[3], 16);
      console.log(`      Service ID (from Transfer): ${tokenId}`);
      return tokenId;
    }
  }

  throw new Error('Could not extract service ID from transaction receipt');
}

// ============================================================================
// Build Service Metadata
// ============================================================================

function buildServiceMetadata(agentIds: number[], serviceName: string) {
  // Determine image CID — use agent-specific image for single services, logo for combined
  const imageCid = agentIds.length === 1
    ? (AGENT_IMAGE_CIDS[agentIds[0]] || DEFAULT_IMAGE_CID)
    : DEFAULT_IMAGE_CID;

  // Build slug for name field (e.g. "jinn/crypto-token-researcher-service:1.0.0")
  const slug = agentIds.length === 1
    ? `jinn/${AGENT_SLUGS[agentIds[0]] || 'unknown'}-service:1.0.0`
    : `jinn/x402-agent-service:1.0.0`;

  // Build code_uri — for single-agent services, point to the template execute endpoint
  const codeUri = agentIds.length === 1
    ? `${GATEWAY_BASE_URL}/templates`
    : `${GATEWAY_BASE_URL}/.well-known/x402`;

  return {
    // OLAS marketplace required fields
    name: slug,
    description: `${serviceName}. Executes AI research templates via the x402 payment protocol on Base.`,
    code_uri: codeUri,
    image: `ipfs://${imageCid}`,
    attributes: [{ trait_type: 'version', value: '1.0.0' }],
    // Custom Jinn fields (marketplace ignores but useful for x402 discovery)
    x402Gateway: GATEWAY_BASE_URL,
    discoveryUrl: `${GATEWAY_BASE_URL}/.well-known/x402`,
    agents: agentIds.map(id => ({
      agentId: id,
      name: AGENT_NAMES[id] || `Agent ${id}`,
      registry: 'ethereum',
    })),
    network: 'base',
  };
}

// ============================================================================
// Main: Combined mode — one service with all agents
// ============================================================================

async function mintCombinedService(
  agentIds: number[],
  privateKey: string,
  dryRun: boolean,
): Promise<void> {
  console.log(`\n  === Combined Service (${agentIds.length} agents) ===`);

  const serviceName = 'Jinn x402 Agent Service';
  const metadata = buildServiceMetadata(agentIds, serviceName);

  let ipfsCid: string;
  if (dryRun) {
    ipfsCid = 'QmDRYRUN_combined_service';
    console.log(`    [DRY-RUN] Would upload service metadata to IPFS`);
  } else {
    console.log('    Uploading service metadata to IPFS...');
    ipfsCid = await uploadToIpfs(metadata, 'jinn-service-metadata.json');
    console.log(`    CID: ${ipfsCid}`);
    console.log(`    URL: ${IPFS_GATEWAY}/${ipfsCid}`);
  }

  const configHash = dryRun ? '0x' + '00'.repeat(32) : cidToBytes32(ipfsCid);
  console.log(`    Config hash: ${configHash}`);

  // Agent IDs must be sorted ascending for the contract
  const sortedIds = [...agentIds].sort((a, b) => a - b);

  const serviceId = await createService(SERVICE_OWNER, configHash, sortedIds, privateKey, dryRun);

  if (serviceId !== null) {
    console.log(`\n    ======================================`);
    console.log(`    SERVICE ID: ${serviceId}`);
    console.log(`    ======================================`);
    console.log(`    Registry: https://registry.olas.network/base/services/${serviceId}`);
  }
}

// ============================================================================
// Main: Single mode — one service per agent
// ============================================================================

async function mintSingleServices(
  agentIds: number[],
  privateKey: string,
  dryRun: boolean,
): Promise<void> {
  for (let i = 0; i < agentIds.length; i++) {
    const agentId = agentIds[i];
    const name = AGENT_NAMES[agentId] || `Agent ${agentId}`;
    console.log(`\n  === Service for Agent ${agentId}: ${name} ===`);

    const metadata = buildServiceMetadata([agentId], `Jinn ${name}`);

    let ipfsCid: string;
    if (dryRun) {
      ipfsCid = `QmDRYRUN_service_${agentId}`;
      console.log(`    [DRY-RUN] Would upload service metadata to IPFS`);
      console.log(`    Metadata preview:`, JSON.stringify(metadata, null, 2));
    } else {
      console.log('    Uploading service metadata to IPFS...');
      ipfsCid = await uploadToIpfs(metadata, `jinn-service-${agentId}-metadata.json`);
      console.log(`    CID: ${ipfsCid}`);
    }

    const configHash = dryRun ? '0x' + '00'.repeat(32) : cidToBytes32(ipfsCid);
    const serviceId = await createService(SERVICE_OWNER, configHash, [agentId], privateKey, dryRun);

    if (serviceId !== null) {
      console.log(`    Service ID: ${serviceId}`);
      console.log(`    Registry: https://registry.olas.network/base/services/${serviceId}`);
    }

    // Brief delay between mints
    if (!dryRun && i < agentIds.length - 1) {
      console.log('    (waiting 3s before next mint...)');
      await new Promise(r => setTimeout(r, 3000));
    }
  }
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  const { mode, agentIds, dryRun } = parseArgs();

  console.log(`\nMinting OLAS services on Base`);
  console.log(`  Mode: ${mode}`);
  console.log(`  Agent IDs: [${agentIds.join(', ')}]`);
  console.log(`  Owner: ${SERVICE_OWNER}`);
  console.log(`  Manager: ${SERVICE_MANAGER_ADDRESS}`);
  if (dryRun) console.log('  Mode: DRY RUN');

  const masterPrivateKey = getMasterPrivateKey();
  if (!masterPrivateKey) {
    console.error('Cannot get master private key. Set OPERATE_PASSWORD env var.');
    process.exit(1);
  }

  const wallet = new Wallet(masterPrivateKey);
  console.log(`  Sender (Master EOA): ${wallet.address}`);

  if (mode === 'combined') {
    await mintCombinedService(agentIds, masterPrivateKey, dryRun);
  } else {
    await mintSingleServices(agentIds, masterPrivateKey, dryRun);
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
