#!/usr/bin/env tsx
import { dispatchExistingJob } from 'jinn-node/agent/mcp/tools/dispatch_existing_job.js';

async function main() {
  const jobDefinitionId = process.argv[2];
  
  if (!jobDefinitionId) {
    console.error('Usage: yarn tsx scripts/dispatch-existing-job-def.ts <jobDefinitionId>');
    process.exit(1);
  }
  
  console.log(`📤 Dispatching job using definition: ${jobDefinitionId}\n`);
  
  const result = await dispatchExistingJob({
    jobId: jobDefinitionId,
    message: 'Test run for recognition phase display'
  });
  
  console.log('\nFull result:', JSON.stringify(result, null, 2));
  
  const parsed = JSON.parse(result.content[0].text);
  console.log('\nParsed result:', JSON.stringify(parsed, null, 2));
  
  if (parsed.data) {
    const data = parsed.data;
    console.log('\n✅ Job dispatched successfully!');
    console.log(`📋 Request ID: ${data.request_ids[0]}`);
    console.log(`🔗 Transaction: ${data.transaction_url}`);
    console.log(`\n➡️  Run worker with: MECH_TARGET_REQUEST_ID=${data.request_ids[0]} yarn mech --single`);
  } else {
    console.log('\n⚠️  No data in response');
  }
}

main().catch(console.error);

