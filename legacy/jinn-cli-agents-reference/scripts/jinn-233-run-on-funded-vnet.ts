#!/usr/bin/env tsx
/**
 * Run worker on already-funded Tenderly VNet
 *
 * Required env:
 *   TENDERLY_ADMIN_RPC — virtual network RPC URL (sensitive; do not commit)
 *   TENDERLY_VNET_ID — VNet UUID for dashboard links
 *   WORKER_PRIVATE_KEY — EOA key the worker signs with (or set TEST_PRIVATE_KEY)
 *
 * Optional:
 *   TENDERLY_ACCOUNT_SLUG, TENDERLY_PROJECT_SLUG — for dashboard URLs (default: generic link without slugs)
 *   TEST_ADDRESS — logged only; defaults to a placeholder if unset
 */

import { execa } from 'execa';
import { promises as fs } from 'fs';
import path from 'path';

function requireEnv(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) {
    console.error(`Missing required environment variable: ${name}`);
    process.exit(1);
  }
  return v;
}

async function main() {
  const VNET_ID = requireEnv('TENDERLY_VNET_ID');
  const ADMIN_RPC = requireEnv('TENDERLY_ADMIN_RPC');
  const TEST_PRIVATE_KEY =
    process.env.WORKER_PRIVATE_KEY?.trim() || requireEnv('TEST_PRIVATE_KEY');
  const TEST_ADDRESS =
    process.env.TEST_ADDRESS?.trim() || '0x0000000000000000000000000000000000000001';
  const acct = process.env.TENDERLY_ACCOUNT_SLUG?.trim();
  const proj = process.env.TENDERLY_PROJECT_SLUG?.trim();
  const dashboard =
    acct && proj
      ? `https://dashboard.tenderly.co/${acct}/${proj}/project/vnets/${VNET_ID}`
      : `(set TENDERLY_ACCOUNT_SLUG + TENDERLY_PROJECT_SLUG for dashboard URL; VNet ${VNET_ID})`;

  console.log('🚀 Running worker on funded Tenderly VNet\n');
  console.log(`VNet ID: ${VNET_ID}`);
  console.log(`Admin RPC: ${ADMIN_RPC}`);
  console.log(`Test Address: ${TEST_ADDRESS}`);
  console.log(`Dashboard: ${dashboard}\n`);

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
        const explorer =
          acct && proj
            ? `https://dashboard.tenderly.co/${acct}/${proj}/project/vnets/${VNET_ID}/tx/${txHash}`
            : `tx ${txHash} (set TENDERLY_ACCOUNT_SLUG + TENDERLY_PROJECT_SLUG for explorer URL)`;
        console.log(`     Explorer: ${explorer}`);
      }
    }

    console.log(
      `\n📊 View full VNet state: ${acct && proj ? `https://dashboard.tenderly.co/${acct}/${proj}/project/vnets/${VNET_ID}` : `VNet ${VNET_ID} (set TENDERLY_ACCOUNT_SLUG + TENDERLY_PROJECT_SLUG)`}`,
    );
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

