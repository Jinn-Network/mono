#!/usr/bin/env tsx

import { dispatchExistingJob } from 'jinn-node/agent/mcp/tools/dispatch_existing_job.js';
import { config } from 'dotenv';

config();

async function main() {
  const JOB_ID = '786ecb79-02cc-4607-88aa-6ea4ff60f87d';
  
  console.log(`Updating job ${JOB_ID} with corrected orchestrator prompt...`);
  
  const result = await dispatchExistingJob({
    jobId: JOB_ID,
    message: 'Updated prompt to properly handle re-runs: Check Job Context to determine if this is first run (delegate) or re-run (synthesize child job results).'
  });
  
  console.log('\n✅ Job updated successfully!');
  console.log('📋 Result:', JSON.stringify(result, null, 2));
}

main();

