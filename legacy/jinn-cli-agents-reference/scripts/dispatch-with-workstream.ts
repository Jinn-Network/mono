#!/usr/bin/env tsx
import 'dotenv/config';
import { dispatchExistingJob } from 'jinn-node/agent/mcp/tools/dispatch_existing_job.js';

async function main() {
  const jobId = '27d1ea74-3be2-40c2-81ef-aae291b8d481';
  const workstreamId = '0x65d9270b37759b61167fc91fa66ffcbc47dd3ead2f7d8e9b3d45f70949f6fa33';

  console.log('Dispatching job within workstream...');
  console.log(`  Job ID: ${jobId}`);
  console.log(`  Workstream ID: ${workstreamId}\n`);

  try {
    const result = await dispatchExistingJob({
      jobId: jobId,
      workstreamId: workstreamId,
      message: 'Re-dispatching parent job to review children status.',
    });

    const response = JSON.parse(result.content[0].text);
    if (response.meta?.ok) {
      const requestId = response.data.request_ids[0];
      console.log('\n✅ Job dispatched successfully!');
      console.log(JSON.stringify(response, null, 2));
      console.log(`\n🔧 To process this request:`);
      console.log(`   MECH_TARGET_REQUEST_ID=${requestId} yarn dev:mech --single`);
      console.log(`\n🌐 Monitor: http://localhost:3000/requests/${requestId}`);
    } else {
      console.error('\n❌ Failed to dispatch job:', response.meta?.message);
      console.error(JSON.stringify(response, null, 2));
      process.exit(1);
    }
  } catch (error: any) {
    console.error('\n❌ An unexpected error occurred:', error.message);
    process.exit(1);
  }
}

main();

