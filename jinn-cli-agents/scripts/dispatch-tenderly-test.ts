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
    console.log(`🔗 Tenderly Explorer: https://dashboard.tenderly.co/tannedoaksprout/project/vnets/72faaa5c-83f4-4761-86fb-91b30c00d4a4/tx/${result.requestId}`);
  }
}

main().catch(console.error);

