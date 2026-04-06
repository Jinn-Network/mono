#!/usr/bin/env tsx
/**
 * Test dispatch_new_job MCP tool with minimal gemini agent setup
 * This tests the full MCP tool path but in isolation
 */

// Load .env file
import { config } from 'dotenv';
config();

import { dispatchNewJob } from 'jinn-node/agent/mcp/tools/dispatch_new_job.js';
import { setJobContext } from 'jinn-node/agent/mcp/tools/shared/context.js';

async function testDispatchMcpTool() {
  console.log('=== Testing dispatch_new_job MCP Tool ===\n');

  // Set a mock job context (simulating being called from within a job)
  setJobContext(
    '0x0000000000000000000000000000000000000000000000000000000000000001', // requestId as jobId
    'test-parent-job',
    null, // threadId
    null, // projectRunId
    null, // projectDefinitionId
    'test-parent-job-def-id', // jobDefinitionId
    'main' // baseBranch
  );

  const testParams = {
    jobName: 'test-mcp-dispatch',
    blueprint: JSON.stringify({
      assertions: [{
        id: 'TEST-001',
        assertion: 'This is a test to verify dispatch_new_job MCP tool',
        examples: {
          do: ['Successfully dispatch job'],
          dont: ['Fail silently']
        },
        commentary: 'Testing the full MCP tool path'
      }]
    }),
    model: 'gemini-2.5-flash',
    enabledTools: ['create_artifact'],
    skipBranch: true, // Skip git branch creation for this test
  };

  console.log('Test Parameters:');
  console.log(JSON.stringify(testParams, null, 2));
  console.log('');

  console.log('Calling dispatchNewJob MCP tool...\n');

  try {
    const result = await dispatchNewJob(testParams);

    console.log('\n=== RESULT ===');
    console.log('Result type:', typeof result);
    console.log('Result keys:', Object.keys(result));
    console.log('');

    // Parse the MCP response
    if (result.content && Array.isArray(result.content) && result.content[0]?.text) {
      const responseText = result.content[0].text;
      console.log('Response text (raw):');
      console.log(responseText);
      console.log('');

      try {
        const parsed = JSON.parse(responseText);
        console.log('Parsed response:');
        console.log(JSON.stringify(parsed, null, 2));
        console.log('');

        if (parsed.meta?.ok === false) {
          console.error('❌ FAILURE: Tool returned error');
          console.error('  Code:', parsed.meta.code);
          console.error('  Message:', parsed.meta.message);
          process.exit(1);
        }

        if (!parsed.data) {
          console.error('❌ FAILURE: No data in response');
          process.exit(1);
        }

        // Check for critical fields
        const hasRequestIds = parsed.data.request_ids && Array.isArray(parsed.data.request_ids);
        const hasTransactionHash = !!parsed.data.transaction_hash;
        const hasJobDefId = !!parsed.data.jobDefinitionId;

        console.log('Data validation:');
        console.log('  ✓ Has jobDefinitionId:', hasJobDefId, parsed.data.jobDefinitionId);
        console.log('  ✓ Has request_ids:', hasRequestIds, parsed.data.request_ids?.length || 0);
        console.log('  ✓ Has transaction_hash:', hasTransactionHash, parsed.data.transaction_hash);
        console.log('  ✓ Has transaction_url:', !!parsed.data.transaction_url, parsed.data.transaction_url);
        console.log('');

        if (!hasRequestIds || parsed.data.request_ids.length === 0) {
          console.error('❌ CRITICAL: No on-chain request IDs returned');
          console.error('This means the job was not posted to the blockchain!');
          console.error('');
          console.error('Full data object:');
          console.error(JSON.stringify(parsed.data, null, 2));
          process.exit(1);
        }

        console.log('✅ SUCCESS: dispatch_new_job completed');
        console.log('  Job Definition ID:', parsed.data.jobDefinitionId);
        console.log('  Request IDs:', parsed.data.request_ids);
        console.log('  Transaction:', parsed.data.transaction_hash);

      } catch (parseError: any) {
        console.error('❌ FAILURE: Could not parse response as JSON');
        console.error('  Error:', parseError.message);
        process.exit(1);
      }
    } else {
      console.error('❌ FAILURE: Unexpected response format');
      console.error('Result:', result);
      process.exit(1);
    }

  } catch (error: any) {
    console.error('\n❌ EXCEPTION CAUGHT:');
    console.error('  Message:', error.message);
    console.error('  Stack:', error.stack);
    process.exit(1);
  }
}

// Run test
testDispatchMcpTool().catch((error) => {
  console.error('Unhandled error:', error);
  process.exit(1);
});

