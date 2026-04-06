#!/usr/bin/env tsx
/**
 * Run worker on already-funded Tenderly VNet
 * Uses the VNet and address from the previous funding attempt
 */

import { execa } from 'execa';
import { promises as fs } from 'fs';
import path from 'path';

const VNET_ID = '72faaa5c-83f4-4761-86fb-91b30c00d4a4';
const ADMIN_RPC = 'https://virtual.base.eu.rpc.tenderly.co/d645bc78-0fd2-4d11-9ebd-9946a5df9c7f';
const TEST_PRIVATE_KEY = '0xa76e1a89cf97bb6c3f81e7c70b3c2e5b6a8c7f8b2a5c8e9f1a7b6c8d9e0f1a2b'; // Replace with actual key if you have it
const TEST_ADDRESS = '0x35112e83a5a4fA93bdFDdb16364d2eb69DAec075';

async function main() {
  console.log('🚀 Running worker on funded Tenderly VNet\n');
  console.log(`VNet ID: ${VNET_ID}`);
  console.log(`Admin RPC: ${ADMIN_RPC}`);
  console.log(`Test Address: ${TEST_ADDRESS}`);
  console.log(`Dashboard: https://dashboard.tenderly.co/tannedoaksprout/project/vnets/${VNET_ID}\n`);

  const tempDir = path.join('/tmp', `jinn-proof-funded-${Date.now()}`);
  await fs.mkdir(tempDir, { recursive: true });

  const env = {
    ...process.env,
    WORKER_PRIVATE_KEY: TEST_PRIVATE_KEY,
    CHAIN_ID: '8453',
    BASE_LEDGER_RPC: ADMIN_RPC,
    RPC_URL: ADMIN_RPC,
    PONDER_GRAPHQL_URL: process.env.PONDER_GRAPHQL_URL || 'http://localhost:42069/graphql',
    JINN_WALLET_STORAGE_PATH: path.join(tempDir, 'wallets'),
    USE_TSX_MCP: '1',
  };

  console.log('🔧 Starting worker...\n');
  console.log('=' .repeat(80));

  try {
    const result = await execa('npx', ['tsx', 'worker/mech_worker.ts', '--single'], {
      env,
      timeout: 300000, // 5 minutes
      reject: false,
      all: true,
    });

    console.log(result.all || '');
    console.log('=' .repeat(80));
    console.log(`\n✅ Worker completed with exit code ${result.exitCode}`);

    // Save output
    const outputPath = path.join(tempDir, 'worker-output.txt');
    await fs.writeFile(outputPath, result.all || '', 'utf-8');
    console.log(`📄 Output saved to: ${outputPath}`);

    // Look for transaction hashes
    const txHashRegex = /0x[a-fA-F0-9]{64}/g;
    const matches = (result.all || '').match(txHashRegex);
    
    if (matches) {
      const uniqueTxs = [...new Set(matches)];
      console.log(`\n💰 Found ${uniqueTxs.length} transaction hash(es):`);
      for (const txHash of uniqueTxs) {
        console.log(`   - ${txHash}`);
        console.log(`     Explorer: https://dashboard.tenderly.co/tannedoaksprout/project/vnets/${VNET_ID}/tx/${txHash}`);
      }
    }

    console.log(`\n📊 View full VNet state: https://dashboard.tenderly.co/tannedoaksprout/project/vnets/${VNET_ID}`);
    console.log(`⚠️  VNet NOT deleted - kept for inspection`);

  } catch (error: any) {
    console.error('💥 Worker failed:', error.message);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('💥 Script failed:', error);
  process.exit(1);
});

