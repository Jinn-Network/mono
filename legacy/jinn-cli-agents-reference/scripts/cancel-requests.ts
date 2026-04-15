#!/usr/bin/env tsx

/**
 * Cancel Marketplace Requests
 *
 * Delivers "CANCELLED" results for specified on-chain requests to prevent them
 * from being picked up by workers. Useful for cleaning up mis-configured jobs.
 *
 * Usage:
 *   yarn tsx scripts/cancel-requests.ts <requestId1> <requestId2> ... [--reason "reason text"]
 *
 * Example:
 *   yarn tsx scripts/cancel-requests.ts \
 *     0xc5a445ba7d17afcc0275fbc85ee34aa13aac7e8dbc502a08c16f163ab793e9b6 \
 *     --reason "Incorrect repository configuration"
 */

import '../env/index.js';
import { deliverViaSafe } from '@jinn-network/mech-client-ts/dist/post_deliver.js';
import { getMechAddress, getServiceSafeAddress, getServicePrivateKey } from 'jinn-node/env/operate-profile.js';
import { getRequiredRpcUrl, getOptionalMechChainConfig } from 'jinn-node/agent/mcp/tools/shared/env.js';

interface CancelResult {
  requestId: string;
  success: boolean;
  txHash?: string;
  error?: string;
}

async function cancelRequest(
  requestId: string,
  reason: string,
  config: {
    chainConfig: string;
    mechAddress: string;
    safeAddress: string;
    privateKey: string;
    rpcHttpUrl: string;
  }
): Promise<CancelResult> {
  console.log(`\n📝 Cancelling request: ${requestId}`);
  console.log(`   Reason: ${reason}`);

  try {
    const resultContent = {
      requestId,
      output: `Job cancelled: ${reason}`,
      telemetry: {},
      artifacts: [],
      cancelled: true,
    };

    const delivery = await (deliverViaSafe as any)({
      chainConfig: config.chainConfig,
      requestId,
      resultContent,
      targetMechAddress: config.mechAddress,
      safeAddress: config.safeAddress,
      privateKey: config.privateKey,
      rpcHttpUrl: config.rpcHttpUrl,
      wait: true,
    });

    console.log(`   ✅ Delivered: ${delivery.tx_hash}`);
    console.log(`   Status: ${delivery.status}`);
    if (delivery.block_number) {
      console.log(`   Block: ${delivery.block_number}`);
    }
    if (delivery.gas_used) {
      console.log(`   Gas Used: ${delivery.gas_used.toLocaleString()}`);
    }

    return {
      requestId,
      success: true,
      txHash: delivery.tx_hash,
    };
  } catch (error: any) {
    console.error(`   ❌ Error: ${error.message || String(error)}`);
    return {
      requestId,
      success: false,
      error: error.message || String(error),
    };
  }
}

async function main() {
  // Parse arguments
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    console.log(`
Usage: yarn tsx scripts/cancel-requests.ts <requestId1> <requestId2> ... [--reason "reason text"]

Arguments:
  requestId        One or more on-chain request IDs to cancel (0x...)
  --reason TEXT    Cancellation reason (default: "Job cancelled by operator")

Example:
  yarn tsx scripts/cancel-requests.ts \\
    0xc5a445ba7d17afcc0275fbc85ee34aa13aac7e8dbc502a08c16f163ab793e9b6 \\
    0x6a4700eca18853e861763d3beb39192b91f3ec567bddbb107908dc1b0966e1db \\
    --reason "Incorrect repository configuration"
`);
    process.exit(0);
  }

  // Extract request IDs and reason
  const requestIds: string[] = [];
  let reason = 'Job cancelled by operator';

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--reason') {
      reason = args[i + 1] || reason;
      i++; // Skip next arg
    } else if (!arg.startsWith('--')) {
      requestIds.push(arg);
    }
  }

  if (requestIds.length === 0) {
    console.error('❌ Error: No request IDs provided');
    process.exit(1);
  }

  // Load credentials
  console.log('🔧 Loading service credentials...');
  const mechAddress = getMechAddress();
  const safeAddress = getServiceSafeAddress();
  const privateKey = getServicePrivateKey();
  const rpcHttpUrl = getRequiredRpcUrl();
  const chainConfig = getOptionalMechChainConfig() || 'base';

  if (!mechAddress) {
    console.error('❌ Error: MECH_ADDRESS not found in .operate config or environment');
    process.exit(1);
  }
  if (!safeAddress) {
    console.error('❌ Error: Safe address not found in .operate config');
    process.exit(1);
  }
  if (!privateKey) {
    console.error('❌ Error: Private key not found in .operate config');
    process.exit(1);
  }

  console.log(`   Mech: ${mechAddress}`);
  console.log(`   Safe: ${safeAddress}`);
  console.log(`   Chain: ${chainConfig}`);
  console.log(`   RPC: ${rpcHttpUrl}`);

  const config = {
    chainConfig,
    mechAddress,
    safeAddress,
    privateKey,
    rpcHttpUrl,
  };

  // Cancel each request
  console.log(`\n🚀 Cancelling ${requestIds.length} request(s)...`);
  const results: CancelResult[] = [];

  for (const requestId of requestIds) {
    const result = await cancelRequest(requestId, reason, config);
    results.push(result);

    // Small delay between requests to avoid rate limiting
    if (requestIds.length > 1 && requestId !== requestIds[requestIds.length - 1]) {
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }

  // Summary
  const successful = results.filter(r => r.success).length;
  const failed = results.filter(r => !r.success).length;

  console.log(`\n📊 Summary:`);
  console.log(`   Total: ${results.length}`);
  console.log(`   ✅ Successful: ${successful}`);
  console.log(`   ❌ Failed: ${failed}`);

  if (failed > 0) {
    console.log(`\n❌ Failed requests:`);
    results.filter(r => !r.success).forEach(r => {
      console.log(`   ${r.requestId}: ${r.error}`);
    });
  }

  if (successful > 0) {
    console.log(`\n✅ Successfully cancelled ${successful} request(s)`);
    console.log(`   These jobs will no longer be picked up by workers.`);
    console.log(`   Verify in Ponder: delivered: true`);
  }

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error('❌ Fatal error:', error);
  process.exit(1);
});
