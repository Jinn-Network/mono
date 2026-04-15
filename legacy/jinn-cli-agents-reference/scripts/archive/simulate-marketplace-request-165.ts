#!/usr/bin/env tsx
/**
 * Simulate Marketplace Request from Service #165 Safe using Tenderly MCP
 * 
 * This script prepares the transaction data and uses Tenderly MCP to simulate
 * the Safe execTransaction call before actual execution.
 */

import { ethers } from 'ethers';
import * as fs from 'fs';
import * as path from 'path';

// Use public RPC for reading state
const RPC_URL = process.env.BASE_LEDGER_RPC || process.env.BASE_RPC_URL || 'https://base.llamarpc.com';

// Service #165 addresses (from config.json)
const SERVICE_SAFE = '0xb8B7A89760A4430C3f69eeE7Ba5D2B985D593D92';
const AGENT_EOA = '0x62fb5FC6ab3206b3C817b503260B90075233f7dD';
const MECH_CONTRACT = '0x8c083Dfe9bee719a05Ba3c75A9B16BE4ba52c299';
const MECH_MARKETPLACE = '0xf24eE42edA0fc9b33B7D41B06Ee8ccD2Ef7C5020';

// Request parameters - LOW COST!
const REQUEST_PRICE = ethers.parseEther('0.000005'); // 0.000005 ETH per request
const PROMPT = 'Test request from Service #165 to satisfy activity checker';

// ABIs
const MECH_MARKETPLACE_ABI = [
  'function request(bytes memory requestData, uint256 maxDeliveryRate, bytes32 paymentType, address priorityMech, uint256 responseTimeout, bytes memory paymentData) external payable returns (bytes32 requestId)',
];

const MECH_ABI = [
  'function paymentType() view returns (bytes32)',
  'function maxDeliveryRate() view returns (uint256)',
];

const SAFE_ABI = [
  'function nonce() view returns (uint256)',
  'function getTransactionHash(address to, uint256 value, bytes calldata data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, uint256 _nonce) view returns (bytes32)',
  'function execTransaction(address to, uint256 value, bytes calldata data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address payable refundReceiver, bytes memory signatures) public payable returns (bool success)',
];

async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function prepareRequestData(prompt: string): Promise<string> {
  const hash = ethers.keccak256(ethers.toUtf8Bytes(prompt));
  return hash;
}

async function main() {
  console.log('🧪 Simulating Marketplace Request from Service #165 Safe with Tenderly\n');
  console.log(`Service Safe: ${SERVICE_SAFE}`);
  console.log(`Agent EOA: ${AGENT_EOA}`);
  console.log(`Marketplace: ${MECH_MARKETPLACE}`);
  console.log(`Priority Mech: ${MECH_CONTRACT}\n`);

  const provider = new ethers.JsonRpcProvider(RPC_URL);

  // 1. Load agent key
  console.log('🔑 Loading agent key...\n');
  const keyPath = path.join(process.cwd(), 'olas-operate-middleware', '.operate', 'keys', AGENT_EOA);
  
  if (!fs.existsSync(keyPath)) {
    console.error(`❌ Agent key not found: ${keyPath}`);
    process.exit(1);
  }

  const keyData = JSON.parse(fs.readFileSync(keyPath, 'utf-8'));
  const privateKey = keyData.private_key;
  const agentWallet = new ethers.Wallet(privateKey, provider);

  console.log(`✅ Agent key loaded: ${agentWallet.address}\n`);

  // 2. Prepare request data
  console.log('📝 Preparing request data...\n');
  const requestData = await prepareRequestData(PROMPT);
  console.log(`Request data (IPFS hash): ${requestData}`);

  // 3. Query mech parameters
  console.log('\n🔍 Querying mech contract parameters...\n');
  await sleep(500);
  const mech = new ethers.Contract(MECH_CONTRACT, MECH_ABI, provider);
  const mechPaymentType = await mech.paymentType();
  await sleep(500);
  const mechMaxDeliveryRate = await mech.maxDeliveryRate();
  
  console.log(`Mech Payment Type: ${mechPaymentType}`);
  console.log(`Mech Max Delivery Rate: ${ethers.formatEther(mechMaxDeliveryRate)} ETH`);

  // 4. Query marketplace for timeout bounds
  console.log('\n🔍 Querying marketplace timeout bounds...\n');
  await sleep(500);
  const MARKETPLACE_BOUNDS_ABI = [
    'function minResponseTimeout() view returns (uint256)',
    'function maxResponseTimeout() view returns (uint256)'
  ];
  const marketplaceBounds = new ethers.Contract(MECH_MARKETPLACE, MARKETPLACE_BOUNDS_ABI, provider);
  const maxTimeout = await marketplaceBounds.maxResponseTimeout();
  
  console.log(`Max Response Timeout: ${maxTimeout} seconds (${Number(maxTimeout) / 60} minutes)`);

  // 5. Encode marketplace request call
  console.log('\n📦 Encoding marketplace request...\n');
  const marketplace = new ethers.Contract(MECH_MARKETPLACE, MECH_MARKETPLACE_ABI, provider);
  
  const marketplaceCallData = marketplace.interface.encodeFunctionData('request', [
    requestData,
    mechMaxDeliveryRate,
    mechPaymentType,
    MECH_CONTRACT,
    maxTimeout,
    '0x',
  ]);

  console.log(`Marketplace call data (first 66 chars): ${marketplaceCallData.slice(0, 66)}...`);

  // 6. Build Safe transaction parameters
  console.log('\n🔒 Building Safe transaction...\n');
  await sleep(500);
  const safe = new ethers.Contract(SERVICE_SAFE, SAFE_ABI, agentWallet);
  const safeNonce = await safe.nonce();
  console.log(`Safe nonce: ${safeNonce}`);

  const txParams = {
    to: MECH_MARKETPLACE,
    value: mechMaxDeliveryRate,
    data: marketplaceCallData,
    operation: 0,
    safeTxGas: 0,
    baseGas: 0,
    gasPrice: 0,
    gasToken: ethers.ZeroAddress,
    refundReceiver: ethers.ZeroAddress,
    nonce: safeNonce,
  };

  // 7. Get transaction hash and sign
  console.log('\n✍️  Signing transaction...\n');
  await sleep(500);
  const txHash = await safe.getTransactionHash(
    txParams.to,
    txParams.value,
    txParams.data,
    txParams.operation,
    txParams.safeTxGas,
    txParams.baseGas,
    txParams.gasPrice,
    txParams.gasToken,
    txParams.refundReceiver,
    txParams.nonce
  );

  const signature = await agentWallet.signMessage(ethers.getBytes(txHash));
  const sigBytes = ethers.getBytes(signature);
  const r = ethers.hexlify(sigBytes.slice(0, 32));
  const s = ethers.hexlify(sigBytes.slice(32, 64));
  const v = sigBytes[64] + 4; // eth_sign format

  const adjustedSignature = ethers.concat([r, s, new Uint8Array([v])]);

  console.log(`Safe transaction hash: ${txHash}`);
  console.log(`Signature: ${ethers.hexlify(adjustedSignature).slice(0, 66)}...`);

  // 8. Encode the full execTransaction call
  console.log('\n🔧 Encoding execTransaction call...\n');
  const execTransactionData = safe.interface.encodeFunctionData('execTransaction', [
    txParams.to,
    txParams.value,
    txParams.data,
    txParams.operation,
    txParams.safeTxGas,
    txParams.baseGas,
    txParams.gasPrice,
    txParams.gasToken,
    txParams.refundReceiver,
    adjustedSignature,
  ]);

  console.log(`execTransaction data length: ${execTransactionData.length} chars`);
  console.log(`execTransaction data (first 66 chars): ${execTransactionData.slice(0, 66)}...`);

  // 9. Print simulation parameters for Tenderly MCP
  console.log('\n' + '='.repeat(70));
  console.log('📋 TENDERLY SIMULATION PARAMETERS');
  console.log('='.repeat(70));
  console.log(`Network: base (chain ID: 8453)`);
  console.log(`From (Agent EOA): ${AGENT_EOA}`);
  console.log(`To (Service Safe): ${SERVICE_SAFE}`);
  console.log(`Value: 0 (agent calls Safe, Safe sends value to marketplace)`);
  console.log(`Data: ${execTransactionData}`);
  console.log('='.repeat(70));
  console.log('\n📝 Use Tenderly MCP to simulate with these parameters:\n');
  console.log('mcp_mcp-tenderly_simulate_transaction({');
  console.log('  network: "base",');
  console.log(`  from: "${AGENT_EOA}",`);
  console.log(`  to: "${SERVICE_SAFE}",`);
  console.log('  value: "0",');
  console.log(`  data: "${execTransactionData}"`);
  console.log('});\n');

  // Save to file for easy reference
  const simulationParams = {
    network: 'base',
    from: AGENT_EOA,
    to: SERVICE_SAFE,
    value: '0',
    data: execTransactionData,
    metadata: {
      serviceId: 165,
      safeNonce: safeNonce.toString(),
      marketplace: MECH_MARKETPLACE,
      mech: MECH_CONTRACT,
      requestPrice: ethers.formatEther(mechMaxDeliveryRate),
      requestData: requestData,
      prompt: PROMPT,
    }
  };

  const outputPath = path.join(process.cwd(), 'tenderly-simulation-params-165.json');
  fs.writeFileSync(outputPath, JSON.stringify(simulationParams, null, 2));
  console.log(`✅ Simulation parameters saved to: ${outputPath}\n`);
}

main().catch(console.error);

