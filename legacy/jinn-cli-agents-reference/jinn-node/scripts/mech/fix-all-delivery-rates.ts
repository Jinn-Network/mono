#!/usr/bin/env tsx
/**
 * Fix maxDeliveryRate for ALL mech contracts across all services.
 *
 * Iterates every service in .operate/services/, reads each mech address,
 * Safe address, and agent private key, then calls changeMaxDeliveryRate()
 * via the Safe for each mech whose current rate differs from the target.
 *
 * Usage:
 *   OPERATE_PASSWORD=<pw> RPC_URL=<url> yarn tsx scripts/mech/fix-all-delivery-rates.ts <newRateInWei>
 *
 * Example:
 *   OPERATE_PASSWORD=test RPC_URL=https://mainnet.base.org yarn tsx scripts/mech/fix-all-delivery-rates.ts 99
 */

import 'dotenv/config';
import { ethers } from 'ethers';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { listServiceConfigs, type ServiceInfo } from '../../src/worker/ServiceConfigReader.js';
import { createRpcProvider } from '../../src/config/index.js';

const MECH_ABI = [
  'function changeMaxDeliveryRate(uint256 newMaxDeliveryRate)',
  'function maxDeliveryRate() view returns (uint256)',
  'function getOperator() view returns (address)',
] as const;

const SAFE_ABI = [
  'function execTransaction(address to, uint256 value, bytes calldata data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address payable refundReceiver, bytes memory signatures) public payable returns (bool success)',
  'function getTransactionHash(address to, uint256 value, bytes calldata data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, uint256 nonce) public view returns (bytes32)',
  'function nonce() public view returns (uint256)',
] as const;

async function fixDeliveryRate(
  service: ServiceInfo,
  newRate: bigint,
  provider: ethers.JsonRpcProvider,
): Promise<boolean> {
  const { mechContractAddress, serviceSafeAddress, agentPrivateKey, serviceId } = service;
  const label = `Service ${serviceId} (${mechContractAddress?.slice(0, 12)}...)`;

  if (!mechContractAddress || !serviceSafeAddress || !agentPrivateKey) {
    console.log(`  ${label}: SKIP — missing mech/safe/key`);
    return false;
  }

  const mech = new ethers.Contract(mechContractAddress, MECH_ABI, provider);
  const currentRate = await mech.maxDeliveryRate();

  if (currentRate === newRate) {
    console.log(`  ${label}: already ${currentRate} — no change needed`);
    return true;
  }

  // Verify Safe is the operator
  const operator = await mech.getOperator();
  if (operator.toLowerCase() !== serviceSafeAddress.toLowerCase()) {
    console.error(`  ${label}: FAIL — Safe ${serviceSafeAddress} is not operator (${operator})`);
    return false;
  }

  const wallet = new ethers.Wallet(agentPrivateKey, provider);
  const safe = new ethers.Contract(serviceSafeAddress, SAFE_ABI, wallet);

  // Encode changeMaxDeliveryRate call
  const iface = new ethers.Interface(MECH_ABI);
  const txData = iface.encodeFunctionData('changeMaxDeliveryRate', [newRate]);

  // Safe transaction params
  const nonce = await safe.nonce();
  const to = mechContractAddress;
  const value = 0;
  const operation = 0;
  const safeTxGas = 0;
  const baseGas = 0;
  const gasPrice = 0;
  const gasToken = ethers.ZeroAddress;
  const refundReceiver = ethers.ZeroAddress;

  // Sign
  const txHash = await safe.getTransactionHash(
    to, value, txData, operation, safeTxGas, baseGas, gasPrice, gasToken, refundReceiver, nonce
  );
  const signature = await wallet.signMessage(ethers.getBytes(txHash));
  const sigBytes = ethers.getBytes(signature);
  const v = sigBytes[64] + 4; // eth_sign marker for Safe
  const adjustedSig = ethers.concat([sigBytes.slice(0, 64), new Uint8Array([v])]);

  // Execute
  const tx = await safe.execTransaction(
    to, value, txData, operation, safeTxGas, baseGas, gasPrice, gasToken, refundReceiver, adjustedSig
  );
  const receipt = await tx.wait();

  if (receipt?.status === 1) {
    const newRateOnChain = await mech.maxDeliveryRate();
    console.log(`  ${label}: ${currentRate} -> ${newRateOnChain}  (tx: ${receipt.hash})`);
    return true;
  } else {
    console.error(`  ${label}: FAIL — tx reverted (${tx.hash})`);
    return false;
  }
}

async function main() {
  const newRate = process.argv[2];
  if (!newRate) {
    console.error('Usage: yarn tsx scripts/mech/fix-all-delivery-rates.ts <newRateInWei>');
    console.error('Example: yarn tsx scripts/mech/fix-all-delivery-rates.ts 99');
    process.exit(1);
  }

  const rpcUrl = process.env.RPC_URL;
  if (!rpcUrl) {
    console.error('RPC_URL environment variable not set');
    process.exit(1);
  }

  // Resolve middleware path: env var or jinn-node root (where .operate lives)
  let middlewarePath: string;
  if (process.env.OLAS_MIDDLEWARE_PATH) {
    middlewarePath = resolve(process.env.OLAS_MIDDLEWARE_PATH);
  } else {
    const currentFile = fileURLToPath(import.meta.url);
    const scriptsDir = dirname(currentFile);
    middlewarePath = resolve(scriptsDir, '..', '..');
  }
  console.log(`Middleware path: ${middlewarePath}`);
  console.log(`Target maxDeliveryRate: ${newRate} wei\n`);

  const services = await listServiceConfigs(middlewarePath);
  if (services.length === 0) {
    console.error('No services found in .operate/services/');
    process.exit(1);
  }

  console.log(`Found ${services.length} service(s):\n`);
  const provider = createRpcProvider(rpcUrl);
  const target = BigInt(newRate);

  let success = 0;
  let fail = 0;
  for (const svc of services) {
    try {
      const ok = await fixDeliveryRate(svc, target, provider);
      if (ok) success++; else fail++;
    } catch (err: any) {
      console.error(`  Service ${svc.serviceId}: ERROR — ${err.message}`);
      fail++;
    }
  }

  console.log(`\nDone: ${success} updated, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main();
