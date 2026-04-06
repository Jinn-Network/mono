#!/usr/bin/env tsx
/**
 * Dispatch Job 3 for JINN-233 - Test fixed artifact type field
 */

import { dispatchNewJob } from 'jinn-node/agent/mcp/tools/dispatch_new_job.js';

async function main() {
  console.log('📤 Dispatching Job 3: Math Problem (5+6) - Type Field Fix Test\n');
  
  const result = await dispatchNewJob({
    objective: 'Calculate 5+6 and explain the result',
    context: 'Test JINN-233 fix: artifact type field should now be indexed by Ponder',
    acceptanceCriteria: 'Provide sum and explanation',
    jobName: 'Math Problem 3 (5+6)',
    enabledTools: []
  });
  
  const data = JSON.parse(result.content[0].text).data;
  console.log('\n✅ Job 3 dispatched successfully!');
  console.log(`📋 Request ID: ${data.request_ids[0]}`);
  console.log(`🔗 Transaction: ${data.transaction_url}`);
  console.log(`\n➡️  Run worker with: MECH_TARGET_REQUEST_ID=${data.request_ids[0]} yarn mech --single`);
}

main().catch(console.error);

