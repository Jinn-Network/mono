#!/usr/bin/env tsx
/**
 * Test error handling for both dispatch tools
 */

import { config } from 'dotenv';
config();

import { dispatchExistingJob } from 'jinn-node/agent/mcp/tools/dispatch_existing_job.js';
import { setJobContext } from 'jinn-node/agent/mcp/tools/shared/context.js';

async function testDispatchErrorHandling() {
  console.log('=== Testing Dispatch Error Handling ===\n');

  // Set context
  setJobContext(
    '0x0000000000000000000000000000000000000000000000000000000000000001',
    'test-parent',
    null,
    null,
    null,
    'test-parent-def-id',
    'main'
  );

  console.log('Test 1: dispatch_existing_job with non-existent job definition\n');

  try {
    const result = await dispatchExistingJob({
      jobName: 'non-existent-job-that-does-not-exist-' + Date.now(),
    });

    const responseText = result.content[0].text;
    const parsed = JSON.parse(responseText);

    console.log('Result:');
    console.log(JSON.stringify(parsed, null, 2));
    console.log('');

    if (parsed.meta?.ok === false && parsed.meta?.code === 'NOT_FOUND') {
      console.log('✅ PASS: dispatch_existing_job correctly returns NOT_FOUND error');
      console.log('  Message:', parsed.meta.message);
    } else {
      console.error('❌ FAIL: Expected NOT_FOUND error but got:', parsed);
      process.exit(1);
    }

  } catch (error: any) {
    console.error('❌ FAIL: Unexpected exception:', error.message);
    process.exit(1);
  }

  console.log('\n' + '='.repeat(60) + '\n');

  console.log('Test 2: dispatch_existing_job with valid job definition\n');

  try {
    // Use the protocol-activity-analysis job that we know exists
    const result = await dispatchExistingJob({
      jobName: 'protocol-activity-analysis',
    });

    const responseText = result.content[0].text;
    const parsed = JSON.parse(responseText);

    console.log('Result (summary):');
    console.log('  ok:', parsed.meta?.ok);
    console.log('  Has request_ids:', !!parsed.data?.request_ids);
    console.log('  Has transaction_hash:', !!parsed.data?.transaction_hash);
    console.log('');

    if (parsed.meta?.ok && parsed.data?.request_ids && parsed.data?.transaction_hash) {
      console.log('✅ PASS: dispatch_existing_job successfully posted on-chain request');
      console.log('  Request IDs:', parsed.data.request_ids);
      console.log('  Transaction:', parsed.data.transaction_hash);
    } else {
      console.error('❌ FAIL: dispatch_existing_job did not return proper data');
      console.error('Full result:', JSON.stringify(parsed, null, 2));
      process.exit(1);
    }

  } catch (error: any) {
    console.error('❌ FAIL: Unexpected exception:', error.message);
    process.exit(1);
  }

  console.log('\n' + '='.repeat(60));
  console.log('\n✅ ALL TESTS PASSED\n');
}

testDispatchErrorHandling().catch(console.error);

