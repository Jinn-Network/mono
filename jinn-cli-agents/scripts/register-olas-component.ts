#!/usr/bin/env tsx
/**
 * Register a single OLAS component representing the Jinn Template Specification.
 *
 * This component is reused as a dependency for ALL Jinn agents.
 * It describes the canonical template schema: invariants, tool policy,
 * model policy, input schema, output spec, pricing, etc.
 *
 * Flow:
 *   1. Build the Jinn Template JSON Schema as component metadata
 *   2. Upload metadata to IPFS via Autonolas registry
 *   3. Extract SHA-256 digest from IPFS CID (NOT keccak256!)
 *   4. Call RegistriesManager.create(0, ownerAddress, sha256Digest, [])
 *   5. Parse CreateUnit event → extract componentId
 *   6. Print component ID for use in agent minting
 *
 * Usage:
 *   tsx scripts/register-olas-component.ts [--dry-run]
 */

import 'dotenv/config';
import { JsonRpcProvider, Wallet, Contract } from 'ethers';
import bs58 from 'bs58';
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
// components and agents. Direct calls to ComponentRegistry revert with ManagerOnly.
const REGISTRIES_MANAGER_ADDRESS = '0x9eC9156dEF5C613B2a7D4c46C383F9B58DfcD6fE';

// Ethereum mainnet RPC
const ETH_RPC_URL = process.env.ETH_RPC_URL || 'https://eth.llamarpc.com';

// Owner for the component — Venture Safe
const COMPONENT_OWNER = '0x900Db2954a6c14C011dBeBE474e3397e58AE5421';

// IPFS gateway for verification
const IPFS_GATEWAY = 'https://gateway.autonolas.tech/ipfs';

// ============================================================================
// Template Schema Metadata
// ============================================================================

function buildTemplateSchemaMetadata() {
  return {
    // OLAS marketplace required fields
    "name": "jinn/template-specification:1.0.0",
    "description": "Canonical schema for Jinn Network reusable job templates. Templates define outcomes via invariants, tool access policy, model policy, input parameters, and structured output extraction. This component is shared by all Jinn agents registered in the OLAS protocol.",
    "code_uri": "ipfs://QmfW97dN9xPZjPCR5ct24xRZzTeFq62Yy7BHNaQFWpPGbR",
    "image": "ipfs://QmfW97dN9xPZjPCR5ct24xRZzTeFq62Yy7BHNaQFWpPGbR",
    "attributes": [{ "trait_type": "version", "value": "1.0.0" }],
    // Custom Jinn fields
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://jinn.network/schemas/template/v1.0.0",
    "title": "Jinn Template Specification",
    "version": "1.0.0",
    "network": "base",
    "type": "object",
    "required": ["name", "blueprint"],
    "properties": {
      "name": {
        "type": "string",
        "description": "Human-readable template name."
      },
      "slug": {
        "type": "string",
        "pattern": "^[a-z0-9]+(-[a-z0-9]+)*$",
        "description": "URL-friendly identifier derived from name."
      },
      "description": {
        "type": ["string", "null"],
        "description": "What this template does."
      },
      "version": {
        "type": "string",
        "pattern": "^\\d+\\.\\d+\\.\\d+",
        "description": "Semver version."
      },
      "blueprint": {
        "type": "object",
        "required": ["invariants"],
        "description": "Blueprint containing invariants (outcome specifications).",
        "properties": {
          "invariants": {
            "type": "array",
            "description": "Invariants define WHAT must be true about outputs. Types: FLOOR (min threshold), CEILING (max threshold), RANGE (bounded), BOOLEAN (true/false condition). Legacy forms (directive, constraint, sequence) normalize to BOOLEAN.",
            "items": {
              "type": "object",
              "required": ["id"],
              "properties": {
                "id": {
                  "type": "string",
                  "description": "Unique ID. Prefix determines semantic layer: GOAL-* (mission), SYS-* (protocol), COORD-* (immediate), QUAL-* (immediate)."
                },
                "type": {
                  "type": "string",
                  "enum": ["FLOOR", "CEILING", "RANGE", "BOOLEAN"],
                  "description": "Invariant type."
                },
                "condition": {
                  "type": "string",
                  "description": "For BOOLEAN type: what must be true."
                },
                "metric": {
                  "type": "string",
                  "description": "For numeric types: what is measured."
                },
                "min": { "type": "number", "description": "For FLOOR/RANGE." },
                "max": { "type": "number", "description": "For CEILING/RANGE." },
                "assessment": {
                  "type": "string",
                  "description": "HOW to measure/check this invariant."
                },
                "examples": {
                  "type": "object",
                  "properties": {
                    "do": { "type": "array", "items": { "type": "string" } },
                    "dont": { "type": "array", "items": { "type": "string" } }
                  }
                }
              }
            }
          }
        }
      },
      "inputSchema": {
        "type": "object",
        "description": "JSON Schema for template input. Values substituted via {{handlebars}} in invariant text."
      },
      "outputSpec": {
        "type": "object",
        "description": "Structured output extraction. Fields array with JSONPath paths, or schema+mapping format.",
        "properties": {
          "version": { "type": "string" },
          "fields": {
            "type": "array",
            "items": {
              "type": "object",
              "properties": {
                "name": { "type": "string" },
                "path": { "type": "string", "description": "JSONPath expression." },
                "type": { "type": "string" },
                "required": { "type": "boolean" },
                "description": { "type": "string" }
              }
            }
          }
        }
      },
      "enabledTools": {
        "type": "array",
        "items": { "type": "string" },
        "description": "Tool whitelist. Meta-tools expand at runtime (e.g., telegram_messaging → send_message/photo/document)."
      },
      "tools": {
        "type": "array",
        "description": "Annotated tool policy with required/available distinction.",
        "items": {
          "type": "object",
          "properties": {
            "name": { "type": "string" },
            "required": { "type": "boolean", "default": false }
          }
        }
      },
      "models": {
        "type": "object",
        "description": "Model policy: allowed models and default.",
        "properties": {
          "allowed": { "type": "array", "items": { "type": "string" } },
          "default": { "type": "string" }
        }
      },
      "tags": {
        "type": "array",
        "items": { "type": "string" }
      },
      "priceWei": {
        "type": ["string", "null"],
        "description": "Price in wei for x402 payment gating."
      },
      "priceUsd": {
        "type": ["string", "null"],
        "description": "Display price in USD."
      },
      "safetyTier": {
        "type": "string",
        "enum": ["public", "private", "restricted"]
      },
      "defaultCyclic": {
        "type": "boolean",
        "description": "Whether jobs auto-redispatch after completion."
      },
      "status": {
        "type": "string",
        "enum": ["draft", "published", "archived"]
      }
    }
  };
}

// ============================================================================
// IPFS Upload
// ============================================================================

async function uploadToIpfs(metadata: object): Promise<string> {
  const blob = new Blob([JSON.stringify(metadata, null, 2)], { type: 'application/json' });
  const formData = new FormData();
  formData.append('file', blob, 'jinn-template-spec.json');

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
// Component Registration
// ============================================================================

/**
 * Extract raw SHA-256 digest from IPFS CIDv0 for on-chain unitHash.
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

async function registerComponent(
  ownerAddress: string,
  componentHash: string,
  privateKey: string,
  dryRun: boolean,
): Promise<number | null> {
  const provider = new JsonRpcProvider(ETH_RPC_URL);
  const wallet = new Wallet(privateKey, provider);

  const manager = new Contract(REGISTRIES_MANAGER_ADDRESS, REGISTRIES_MANAGER_ABI, wallet);

  if (dryRun) {
    console.log('\n--- DRY RUN ---');
    console.log('RegistriesManager.create() params:');
    console.log('  unitType: 0 (Component)');
    console.log('  owner:', ownerAddress);
    console.log('  hash:', componentHash);
    console.log('  dependencies: []');
    console.log('  RegistriesManager:', REGISTRIES_MANAGER_ADDRESS);
    console.log('Would submit transaction to Ethereum mainnet');

    // Estimate gas to verify the tx would succeed
    try {
      const gasEstimate = await manager.create.estimateGas(0, ownerAddress, componentHash, []);
      console.log(`  Gas estimate: ${gasEstimate.toString()} ✓`);
    } catch (err: any) {
      console.error(`  Gas estimate FAILED: ${err.message}`);
      console.error('  The transaction would revert on-chain.');
    }

    return null;
  }

  console.log(`\nSubmitting RegistriesManager.create(Component) on Ethereum mainnet...`);
  console.log(`  Owner: ${ownerAddress}`);
  console.log(`  Hash: ${componentHash}`);
  console.log(`  Sender (Master EOA): ${wallet.address}`);

  const tx = await manager.create(0, ownerAddress, componentHash, []);
  console.log(`  TX hash: ${tx.hash}`);

  const receipt = await tx.wait();
  console.log(`  Confirmed in block: ${receipt.blockNumber}`);

  // Parse CreateUnit event
  const componentId = OlasContractHelpers.parseCreateUnitEvent(receipt);
  if (componentId === null) {
    throw new Error('CreateUnit event not found in transaction receipt');
  }

  console.log(`  Component ID: ${componentId}`);
  return componentId;
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  const dryRun = process.argv.includes('--dry-run');

  console.log('\nRegistering OLAS Component: Jinn Template Specification');
  if (dryRun) console.log('  (dry-run mode)');

  // 1. Build metadata
  const metadata = buildTemplateSchemaMetadata();
  console.log(`\n  Schema: ${metadata.$id}`);
  console.log(`  Title: ${metadata.title}`);
  console.log(`  Properties: ${Object.keys(metadata.properties).length}`);

  // 2. Upload to IPFS
  let ipfsCid: string;
  if (dryRun) {
    ipfsCid = 'QmDRYRUNPLACEHOLDER';
    console.log(`\n  [DRY-RUN] Would upload metadata to IPFS`);
  } else {
    console.log('\n  Uploading metadata to IPFS...');
    ipfsCid = await uploadToIpfs(metadata);
    console.log(`  CID: ${ipfsCid}`);
    console.log(`  URL: ${IPFS_GATEWAY}/${ipfsCid}`);
  }

  // 3. Extract SHA-256 digest from CID
  const componentHash = dryRun ? '0x' + '00'.repeat(32) : cidToBytes32(ipfsCid);
  console.log(`  Component hash: ${componentHash}`);

  // 4. Get wallet
  const masterPrivateKey = getMasterPrivateKey();
  if (!masterPrivateKey) {
    console.error('Cannot get master private key. Set OPERATE_PASSWORD env var.');
    process.exit(1);
  }

  const wallet = new Wallet(masterPrivateKey);
  console.log(`  Sender (Master EOA): ${wallet.address}`);
  console.log(`  Owner (Venture Safe): ${COMPONENT_OWNER}`);

  // 5. Register component
  const componentId = await registerComponent(COMPONENT_OWNER, componentHash, masterPrivateKey, dryRun);

  if (componentId !== null) {
    console.log(`\n  ======================================`);
    console.log(`  COMPONENT ID: ${componentId}`);
    console.log(`  ======================================`);
    console.log(`\n  Use this in agent minting:`);
    console.log(`    tsx scripts/mint-olas-agent.ts --templateSlug <slug> --componentId ${componentId}`);
    console.log(`\n  OLAS Registry: https://registry.olas.network/ethereum/components/${componentId}`);
  }

  if (dryRun) {
    console.log('\n--- DRY RUN COMPLETE ---');
    console.log('No transactions were submitted. Remove --dry-run to register for real.');
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
