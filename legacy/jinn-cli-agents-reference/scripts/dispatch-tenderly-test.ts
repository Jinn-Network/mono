#!/usr/bin/env tsx
// @ts-nocheck
/**
 * Dispatch a test job on Tenderly VNet for JINN-233 validation
 */

import { dispatchNewJob } from 'jinn-node/agent/mcp/tools/dispatch_new_job.js';

async function main() {
  console.log('📤 Dispatching test job on Tenderly VNet...\n');

  const result = await dispatchNewJob({
    objective: 'Calculate 2+2 and explain the result in one sentence',
    context: 'This is a simple test job for JINN-233 acceptance criteria validation on Tenderly',
    acceptanceCriteria: 'Provide the sum (4) and a brief one-sentence explanation',
    jobName: 'JINN-233 Tenderly Test - Simple Math',
    enabledTools: [],
  });

  console.log('\n✅ Job dispatched successfully!');
  console.log(JSON.stringify(result, null, 2));

  if (result.requestId) {
    console.log(`\n📋 Request ID: ${result.requestId}`);
    const acct = process.env.TENDERLY_ACCOUNT_SLUG;
    const proj = process.env.TENDERLY_PROJECT_SLUG;
    const vnet = process.env.TENDERLY_VNET_ID;
    if (acct && proj && vnet) {
      console.log(
        `🔗 Tenderly Explorer: https://dashboard.tenderly.co/${acct}/${proj}/project/vnets/${vnet}/tx/${result.requestId}`,
      );
    } else {
      console.log(
        '🔗 Set TENDERLY_ACCOUNT_SLUG, TENDERLY_PROJECT_SLUG, TENDERLY_VNET_ID to print a dashboard link.',
      );
    }
  }
}

main().catch(console.error);

