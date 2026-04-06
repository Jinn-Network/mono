#!/usr/bin/env tsx
import { dispatchNewJob } from 'jinn-node/agent/mcp/tools/dispatch_new_job.js';

async function main() {
  console.log('📤 Dispatching Job 4: Math Problem (11+12) - Embedding Indexing Test\n');
  
  const result = await dispatchNewJob({
    objective: 'Calculate 11+12 and explain the result',
    context: 'Test JINN-233: This job should find Job 3 as similar situation and use its learnings',
    acceptanceCriteria: 'Provide sum and explanation',
    jobName: 'Math Problem 4 (11+12)',
    enabledTools: []
  });
  
  const data = JSON.parse(result.content[0].text).data;
  console.log('\n✅ Job 4 dispatched successfully!');
  console.log(`📋 Request ID: ${data.request_ids[0]}`);
  console.log(`🔗 Transaction: ${data.transaction_url}`);
  console.log(`\n➡️  Run worker with: MECH_TARGET_REQUEST_ID=${data.request_ids[0]} yarn mech --single`);
}

main().catch(console.error);

