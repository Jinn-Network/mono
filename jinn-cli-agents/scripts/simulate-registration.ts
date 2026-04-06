#!/usr/bin/env tsx
/**
 * Simulate jinn-node agent registration via Tenderly.
 *
 * Does real IPFS uploads (free), then simulates the on-chain tx
 * against an Ethereum mainnet fork to verify state changes.
 *
 * Requires: OPERATE_PASSWORD, OPERATE_PROFILE_DIR, TENDERLY_ACCESS_KEY,
 *           TENDERLY_ACCOUNT_SLUG, TENDERLY_PROJECT_SLUG
 */

import dotenv from 'dotenv';
import * as path from 'path';
import * as fs from 'fs';
import { fileURLToPath } from 'url';
import { Interface, Wallet } from 'ethers';
import bs58 from 'bs58';
import { getMasterPrivateKey } from 'jinn-node/env/operate-profile.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, '../.env') });
dotenv.config({ path: path.resolve(__dirname, '../jinn-node/.env') });

const REGISTRIES_MANAGER_ADDRESS = '0x9eC9156dEF5C613B2a7D4c46C383F9B58DfcD6fE';
const AGENT_OWNER = '0x900Db2954a6c14C011dBeBE474e3397e58AE5421';
const COMPONENT_ID = 315;
const JINN_LOGO_CID = 'QmfW97dN9xPZjPCR5ct24xRZzTeFq62Yy7BHNaQFWpPGbR';
const SERVICE_PACKAGE_DIR = path.resolve(__dirname, '../packages/jinn/services/jinn_node');

const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const ZERO_ADDRESS_TOPIC = '0x0000000000000000000000000000000000000000000000000000000000000000';

function cidToBytes32(ipfsCid: string): string {
  const decoded = bs58.decode(ipfsCid);
  if (decoded[0] !== 0x12 || decoded[1] !== 0x20) {
    throw new Error(`Unexpected CID multihash prefix: 0x${decoded[0].toString(16)}${decoded[1].toString(16)}`);
  }
  return '0x' + Buffer.from(decoded.slice(2)).toString('hex');
}

async function main() {
  // Validate Tenderly config
  const { TENDERLY_ACCESS_KEY, TENDERLY_ACCOUNT_SLUG, TENDERLY_PROJECT_SLUG } = process.env;
  if (!TENDERLY_ACCESS_KEY || !TENDERLY_ACCOUNT_SLUG || !TENDERLY_PROJECT_SLUG) {
    console.error('Missing Tenderly env vars: TENDERLY_ACCESS_KEY, TENDERLY_ACCOUNT_SLUG, TENDERLY_PROJECT_SLUG');
    process.exit(1);
  }

  // 1. Decrypt wallet
  console.log('== Step 1: Decrypt wallet ==');
  const pk = getMasterPrivateKey();
  if (!pk) {
    console.error('Cannot get master private key. Set OPERATE_PASSWORD and OPERATE_PROFILE_DIR.');
    process.exit(1);
  }
  const wallet = new Wallet(pk);
  console.log('  Sender:', wallet.address);

  // 2. Upload service package to IPFS
  console.log('\n== Step 2: Upload service package to IPFS ==');
  const serviceYaml = fs.readFileSync(path.join(SERVICE_PACKAGE_DIR, 'service.yaml'));
  const readme = fs.readFileSync(path.join(SERVICE_PACKAGE_DIR, 'README.md'));
  const pkgForm = new FormData();
  pkgForm.append('file', new Blob([serviceYaml]), 'jinn_node/service.yaml');
  pkgForm.append('file', new Blob([readme]), 'jinn_node/README.md');

  const pkgRes = await fetch('https://registry.autonolas.tech/api/v0/add?wrap-with-directory=true&pin=true', {
    method: 'POST',
    body: pkgForm,
  });
  if (!pkgRes.ok) throw new Error(`IPFS package upload failed: ${pkgRes.status}`);

  const pkgText = await pkgRes.text();
  const pkgLines = pkgText.trim().split('\n');
  let servicePackageCid = '';
  for (const line of pkgLines) {
    const entry = JSON.parse(line);
    console.log('  Uploaded:', entry.Name, '->', entry.Hash);
    if (entry.Name === '' || entry.Name === 'jinn_node') servicePackageCid = entry.Hash;
  }
  if (!servicePackageCid) servicePackageCid = JSON.parse(pkgLines[pkgLines.length - 1]).Hash;
  console.log('  Package CID:', servicePackageCid);
  console.log('  Verify: https://gateway.autonolas.tech/ipfs/' + servicePackageCid);

  // 3. Upload metadata to IPFS
  console.log('\n== Step 3: Upload agent metadata to IPFS ==');
  const metadata = {
    name: 'jinn/jinn-node:1.0.0',
    description: 'Jinn Network worker node. Claims and executes jobs from the Jinn Marketplace, runs AI agents with MCP tools, and delivers results on-chain via IPFS.',
    code_uri: `ipfs://${servicePackageCid}`,
    image: `ipfs://${JINN_LOGO_CID}`,
    attributes: [{ trait_type: 'version', value: '1.0.0' }],
    tags: ['jinn', 'worker', 'mech', 'ai-agent', 'marketplace'],
    network: 'base',
  };
  console.log('  Metadata:', JSON.stringify(metadata, null, 2));

  const metaForm = new FormData();
  metaForm.append('file', new Blob([JSON.stringify(metadata, null, 2)]), 'jinn-node-metadata.json');
  const metaRes = await fetch('https://registry.autonolas.tech/api/v0/add?wrap-with-directory=false', {
    method: 'POST',
    body: metaForm,
  });
  if (!metaRes.ok) throw new Error(`IPFS metadata upload failed: ${metaRes.status}`);

  const metaData = (await metaRes.json()) as { Hash: string };
  const metadataCid = metaData.Hash;
  console.log('  Metadata CID:', metadataCid);
  console.log('  Verify: https://gateway.autonolas.tech/ipfs/' + metadataCid);

  // 4. Compute on-chain hash
  const agentHash = cidToBytes32(metadataCid);
  console.log('  Agent hash (bytes32):', agentHash);

  // 5. Encode calldata
  console.log('\n== Step 4: Encode RegistriesManager.create() calldata ==');
  // NOTE: UnitType is an enum which encodes as uint8 in the ABI, NOT uint256
  const iface = new Interface([
    'function create(uint8 unitType, address unitOwner, bytes32 unitHash, uint32[] dependencies) returns (uint256 unitId)',
  ]);
  const calldata = iface.encodeFunctionData('create', [1, AGENT_OWNER, agentHash, [COMPONENT_ID]]);
  console.log('  unitType: 1 (Agent)');
  console.log('  unitOwner:', AGENT_OWNER);
  console.log('  unitHash:', agentHash);
  console.log('  dependencies: [' + COMPONENT_ID + ']');

  // 6. Simulate via Tenderly
  console.log('\n== Step 5: Tenderly Simulation (Ethereum mainnet fork) ==');
  const tenderlyUrl = `https://api.tenderly.co/api/v1/account/${TENDERLY_ACCOUNT_SLUG}/project/${TENDERLY_PROJECT_SLUG}/simulate`;

  const simRes = await fetch(tenderlyUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Access-Key': TENDERLY_ACCESS_KEY,
    },
    body: JSON.stringify({
      network_id: '1',
      from: wallet.address,
      to: REGISTRIES_MANAGER_ADDRESS,
      input: calldata,
      gas: 8000000,
      value: '0',
      save: true,
      save_if_fails: true,
      simulation_type: 'full',
      generate_access_list: true,
    }),
  });

  if (!simRes.ok) {
    const errText = await simRes.text();
    console.error('  Tenderly API error:', simRes.status, errText.slice(0, 1000));
    process.exit(1);
  }

  const sim = (await simRes.json()) as any;
  const tx = sim.transaction;

  console.log('  Status:', tx.status ? 'SUCCESS' : 'REVERTED');
  console.log('  Gas used:', tx.gas_used);

  if (!tx.status) {
    console.log('  Error:', tx.error_message || 'unknown');
    if (tx.error_info) {
      console.log('  Error info:', JSON.stringify(tx.error_info, null, 2));
    }
    const ct = tx.transaction_info?.call_trace;
    if (ct) {
      console.log('  Call trace:');
      console.log('    function:', ct.function_name || ct.decoded_input?.method_name);
      console.log('    output:', ct.output);
      console.log('    error:', ct.error);
      console.log('    decoded_output:', JSON.stringify(ct.decoded_output, null, 2));
      // Print subcalls
      if (ct.calls) {
        for (const sub of ct.calls) {
          console.log('    subcall:', sub.to, sub.function_name || '?');
          console.log('      output:', sub.output);
          console.log('      error:', sub.error);
          if (sub.calls) {
            for (const sub2 of sub.calls) {
              console.log('      subcall:', sub2.to, sub2.function_name || '?');
              console.log('        output:', sub2.output);
              console.log('        error:', sub2.error);
            }
          }
        }
      }
    }
    // Also print raw logs/events even on revert
    if (tx.transaction_info?.logs?.length) {
      console.log('  Logs on revert:');
      for (const log of tx.transaction_info.logs) {
        console.log('   ', log.name, log.raw?.address);
      }
    }
    process.exit(1);
  }

  // Parse Transfer event for minted agent ID
  let mintedAgentId: number | null = null;
  if (tx.transaction_info?.logs) {
    for (const log of tx.transaction_info.logs) {
      const topics = log.raw?.topics;
      if (topics && topics[0] === TRANSFER_TOPIC && topics[1] === ZERO_ADDRESS_TOPIC) {
        mintedAgentId = parseInt(topics[3], 16);
      }
    }
  }

  if (mintedAgentId !== null) {
    console.log('\n  ===================================');
    console.log('  MINTED AGENT ID:', mintedAgentId);
    console.log('  ===================================');
    console.log('  Marketplace: https://registry.olas.network/ethereum/agents/' + mintedAgentId);
  }

  // Show emitted events
  if (tx.transaction_info?.logs) {
    console.log('\n  Events emitted:');
    for (const log of tx.transaction_info.logs) {
      const name = log.name || 'unknown';
      const addr = log.raw?.address || '?';
      console.log(`    ${addr.slice(0, 10)}... ${name}`);
      if (log.inputs) {
        for (const input of log.inputs) {
          console.log(`      ${input.soltype?.name || '?'}: ${input.value}`);
        }
      }
    }
  }

  // Show state changes
  if (tx.transaction_info?.state_diff) {
    console.log('\n  State changes:');
    for (const diff of tx.transaction_info.state_diff) {
      const addr = diff.address || '?';
      const name = diff.soltype?.name || diff.raw?.[0]?.key || '?';
      console.log(`    ${addr.slice(0, 10)}... ${name}: ${diff.original} -> ${diff.dirty}`);
    }
  }

  // Summary
  console.log('\n== Summary ==');
  console.log('  Service package CID:', servicePackageCid);
  console.log('  Metadata CID:', metadataCid);
  console.log('  Agent hash:', agentHash);
  if (mintedAgentId !== null) {
    console.log('  Agent ID (would be):', mintedAgentId);
    console.log('\n  Next steps after real registration:');
    console.log('    1. Update ServiceConfig.ts: DEFAULT_AGENT_ID =', mintedAgentId);
    console.log('    2. Update ServiceConfig.ts: DEFAULT_SERVICE_HASH = "' + servicePackageCid + '"');
    console.log('    3. Deploy staking: tsx scripts/deploy-jin-staking.ts --agent-id=' + mintedAgentId);
  }

  if (sim.simulation?.id) {
    console.log('\n  Tenderly dashboard:');
    console.log(`    https://dashboard.tenderly.co/${TENDERLY_ACCOUNT_SLUG}/${TENDERLY_PROJECT_SLUG}/simulator/${sim.simulation.id}`);
  }
}

main().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});
