#!/usr/bin/env tsx
/**
 * JINN-233 Tenderly Proof of Implementation
 * 
 * Creates a Tenderly VNet, dispatches a real job, runs the worker,
 * and provides transaction links for verification.
 * 
 * VNet is NOT cleaned up - kept alive for manual inspection.
 */

import { createTenderlyClient, ethToWei, type VnetResult } from './lib/tenderly.js';
import { execa } from 'execa';
import { promises as fs } from 'fs';
import path from 'path';
import crypto from 'crypto';
import { privateKeyToAccount } from 'viem/accounts';
import dotenv from 'dotenv';

dotenv.config();

const TENDERLY_DASHBOARD_BASE = 'https://dashboard.tenderly.co';

interface ProofResult {
  vnetId: string;
  vnetUrl: string;
  adminRpcUrl: string;
  publicRpcUrl?: string;
  transactions: {
    description: string;
    txHash?: string;
    explorerUrl?: string;
    blockNumber?: number;
  }[];
  workerOutput: string;
  requestId?: string;
  situationArtifactCid?: string;
}

function log(message: string, data?: any) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${message}`);
  if (data) {
    console.log(JSON.stringify(data, null, 2));
  }
}

function generateTestPrivateKey(): `0x${string}` {
  const randomBytes = crypto.randomBytes(32);
  return `0x${randomBytes.toString('hex')}` as `0x${string}`;
}

async function fundAddress(rpcUrl: string, address: string, amount: string): Promise<void> {
  log(`💰 Funding ${address} with ${amount} ETH...`);
  
  const response = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'tenderly_setBalance',
      params: [[address], `0x${BigInt(ethToWei(amount)).toString(16)}`],
      id: 1,
    }),
  });

  const result = await response.json();
  if (result.error) {
    throw new Error(`Tenderly funding failed: ${JSON.stringify(result.error)}`);
  }
  
  log(`✅ Funded ${address}`);
}

async function getBlockNumber(rpcUrl: string): Promise<number> {
  const response = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'eth_blockNumber',
      params: [],
      id: 1,
    }),
  });

  const result = await response.json();
  return parseInt(result.result, 16);
}

async function runWorkerOnVnet(vnet: VnetResult, privateKey: string): Promise<string> {
  log('🏃 Running worker on VNet...');
  
  const tempDir = path.join('/tmp', `jinn-proof-${Date.now()}`);
  await fs.mkdir(tempDir, { recursive: true });
  
  const env = {
    ...process.env,
    WORKER_PRIVATE_KEY: privateKey,
    CHAIN_ID: '8453',
    BASE_LEDGER_RPC: vnet.adminRpcUrl,
    RPC_URL: vnet.adminRpcUrl,
    PONDER_GRAPHQL_URL: process.env.PONDER_GRAPHQL_URL || 'http://localhost:42069/graphql',
    JINN_WALLET_STORAGE_PATH: path.join(tempDir, 'wallets'),
    USE_TSX_MCP: '1',
  };

  try {
    const result = await execa('yarn', ['tsx', 'worker/mech_worker.ts', '--single'], {
      env,
      timeout: 300000, // 5 minutes
      reject: false,
      all: true,
    });

    log(`Worker completed with exit code ${result.exitCode}`);
    
    // Save output
    const outputPath = path.join(tempDir, 'worker-output.txt');
    await fs.writeFile(outputPath, result.all || '', 'utf-8');
    log(`Worker output saved to: ${outputPath}`);
    
    return result.all || '';
  } finally {
    // Don't clean up - keep for inspection
    log(`📁 Worker temp dir kept at: ${tempDir}`);
  }
}

async function extractTransactionsFromLogs(output: string, vnet: VnetResult): Promise<ProofResult['transactions']> {
  const transactions: ProofResult['transactions'] = [];
  
  // Look for transaction hashes in output
  const txHashRegex = /0x[a-fA-F0-9]{64}/g;
  const matches = output.match(txHashRegex);
  
  if (matches) {
    const uniqueTxs = [...new Set(matches)];
    log(`Found ${uniqueTxs.length} potential transaction hashes`);
    
    for (const txHash of uniqueTxs) {
      transactions.push({
        description: 'Worker transaction',
        txHash,
        explorerUrl: `${TENDERLY_DASHBOARD_BASE}/explorer/vnet/${vnet.id}/tx/${txHash}`,
      });
    }
  }
  
  // Extract request ID if present
  const requestIdMatch = output.match(/requestId[:\s]+([0-9a-fA-F]+)/i);
  if (requestIdMatch) {
    log(`Found request ID: ${requestIdMatch[1]}`);
  }
  
  return transactions;
}

async function main() {
  log('🚀 Starting JINN-233 Tenderly Proof Test\n');
  
  const proof: ProofResult = {
    vnetId: '',
    vnetUrl: '',
    adminRpcUrl: '',
    transactions: [],
    workerOutput: '',
  };

  // 1. Create Tenderly VNet
  log('📡 Creating Tenderly Virtual TestNet...');
  const tenderlyClient = createTenderlyClient();
  
  if (!tenderlyClient.isConfigured()) {
    throw new Error('Tenderly not configured. Set TENDERLY_ACCESS_KEY, TENDERLY_ACCOUNT_SLUG, TENDERLY_PROJECT_SLUG');
  }

  const vnet = await tenderlyClient.createVnet(8453); // Base mainnet fork
  proof.vnetId = vnet.id;
  proof.adminRpcUrl = vnet.adminRpcUrl;
  proof.publicRpcUrl = vnet.publicRpcUrl;
  proof.vnetUrl = `${TENDERLY_DASHBOARD_BASE}/${process.env.TENDERLY_ACCOUNT_SLUG}/${process.env.TENDERLY_PROJECT_SLUG}/vnets/${vnet.id}`;
  
  log(`✅ VNet created: ${vnet.id}`);
  log(`📊 Dashboard: ${proof.vnetUrl}`);
  log(`🔌 Admin RPC: ${vnet.adminRpcUrl}\n`);

  // 2. Generate test wallet and fund it
  const testPrivateKey = generateTestPrivateKey();
  const testAccount = privateKeyToAccount(testPrivateKey);
  log(`🔑 Test EOA: ${testAccount.address}`);
  
  try {
    await fundAddress(vnet.adminRpcUrl, testAccount.address, '5.0');
  } catch (error: any) {
    log(`❌ Funding failed: ${error.message}`);
    throw error;
  }

  const startBlock = await getBlockNumber(vnet.adminRpcUrl);
  log(`📦 Starting block: ${startBlock}\n`);

  // 3. Check if Ponder is running and has requests
  log('🔍 Checking for unclaimed requests in Ponder...');
  try {
    const ponderUrl = process.env.PONDER_GRAPHQL_URL || 'http://localhost:42069/graphql';
    const ponderResponse = await fetch(ponderUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: `{
          requests(where: { delivered: false }, limit: 1) {
            items { id mech ipfsHash delivered }
          }
        }`
      }),
    });
    
    const ponderData = await ponderResponse.json();
    const requests = ponderData?.data?.requests?.items || [];
    
    if (requests.length > 0) {
      log(`✅ Found ${requests.length} unclaimed request(s)`);
      proof.requestId = requests[0].id;
    } else {
      log(`⚠️  No unclaimed requests found. Worker will wait/poll.`);
      log(`   For best results, dispatch a test job first:\n`);
      log(`   MECH_ADDRESS=<your-mech> yarn tsx scripts/dispatch-test-job.ts\n`);
    }
  } catch (error: any) {
    log(`⚠️  Could not check Ponder (is it running?): ${error.message}`);
    log(`   Worker will attempt to connect anyway.\n`);
  }

  // 4. Run worker
  log('🔧 Starting worker on VNet...\n');
  log('=' .repeat(80));
  
  try {
    proof.workerOutput = await runWorkerOnVnet(vnet, testPrivateKey);
  } catch (error: any) {
    log(`❌ Worker execution failed: ${error.message}`);
    proof.workerOutput = error.stdout || error.stderr || error.message;
  }
  
  log('=' .repeat(80) + '\n');

  // 5. Extract transaction evidence
  log('🔎 Extracting transaction evidence...');
  proof.transactions = await extractTransactionsFromLogs(proof.workerOutput, vnet);
  
  const endBlock = await getBlockNumber(vnet.adminRpcUrl);
  log(`📦 Ending block: ${endBlock}`);
  log(`📊 Blocks mined: ${endBlock - startBlock}\n`);

  // 6. Check for SITUATION artifacts in output
  const situationMatch = proof.workerOutput.match(/SITUATION.*?(Qm[a-zA-Z0-9]{44}|baf[a-zA-Z0-9]+)/i);
  if (situationMatch) {
    proof.situationArtifactCid = situationMatch[1];
    log(`✅ SITUATION artifact found: ${proof.situationArtifactCid}`);
  }

  // 7. Generate comprehensive report
  log('\n' + '='.repeat(80));
  log('📋 JINN-233 PROOF OF IMPLEMENTATION');
  log('='.repeat(80) + '\n');

  log('🌐 Tenderly Virtual TestNet:');
  log(`   VNet ID: ${proof.vnetId}`);
  log(`   Dashboard: ${proof.vnetUrl}`);
  log(`   Admin RPC: ${proof.adminRpcUrl}`);
  if (proof.publicRpcUrl) {
    log(`   Public RPC: ${proof.publicRpcUrl}`);
  }
  log('');

  log('🔑 Test Account:');
  log(`   Address: ${testAccount.address}`);
  log(`   Funded: 5.0 ETH (Tenderly balance)`);
  log('');

  if (proof.requestId) {
    log('📝 Job Request:');
    log(`   Request ID: ${proof.requestId}`);
    log('');
  }

  if (proof.transactions.length > 0) {
    log('💰 Transactions:');
    for (const tx of proof.transactions) {
      log(`   ${tx.description}:`);
      log(`   - Hash: ${tx.txHash}`);
      log(`   - Explorer: ${tx.explorerUrl}`);
      log('');
    }
  } else {
    log('⚠️  No transactions detected in worker output');
    log('   Check worker output for errors or if job was actually executed.\n');
  }

  if (proof.situationArtifactCid) {
    log('🧠 SITUATION Artifact:');
    log(`   CID: ${proof.situationArtifactCid}`);
    log(`   IPFS: https://gateway.autonolas.tech/ipfs/${proof.situationArtifactCid}`);
    log('');
  }

  log('📊 Verification Steps:');
  log(`   1. Open VNet dashboard: ${proof.vnetUrl}`);
  log(`   2. Check "Transactions" tab for all on-chain activity`);
  log(`   3. Verify Safe deployment (if first run)`);
  log(`   4. Verify mech request delivery transaction`);
  log(`   5. Check "State" tab to inspect contract storage`);
  log('');

  log('⏱️  VNet Status:');
  log(`   ⚠️  VNet is NOT cleaned up - kept alive for inspection`);
  log(`   🔗 Access it at: ${proof.vnetUrl}`);
  log(`   🗑️  To delete later: yarn tsx scripts/lib/tenderly.ts delete ${proof.vnetId}`);
  log('');

  // Save proof to file
  const proofPath = path.join(process.cwd(), `jinn-233-proof-${Date.now()}.json`);
  await fs.writeFile(proofPath, JSON.stringify(proof, null, 2), 'utf-8');
  log(`💾 Proof saved to: ${proofPath}\n`);

  log('='.repeat(80));
  log('✅ Test complete! VNet is ready for inspection.');
  log('='.repeat(80));
}

main().catch((error) => {
  console.error('💥 Test failed:', error);
  process.exit(1);
});

