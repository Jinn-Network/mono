// @ts-nocheck
import 'dotenv/config';
import { createRecord } from 'jinn-node/agent/mcp/tools/create-record.js';
import { createArtifactTool } from 'jinn-node/agent/mcp/tools/create_artifact.js';
import { createMessageTool } from 'jinn-node/agent/mcp/tools/create_message.js';

async function testAllMCPWriteTools() {
  console.log('Testing all MCP write tools with Control API integration...');
  
  // Set up context
  process.env.JINN_CTX_REQUEST_ID = '0x273609f62f0510689d41f373426fb08c76b4b9242efe44bc1815e6e5eef54c80';
  process.env.JINN_CTX_MECH_ADDRESS = '0x1234567890123456789012345678901234567890';
  
  console.log('\n=== Test 1: create_record for onchain_job_reports ===');
  const result1 = await createRecord({
    table_name: 'onchain_job_reports',
    data: {
      status: 'COMPLETED',
      duration_ms: 5000,
      total_tokens: 1000,
      tools_called: ['create_record', 'create_artifact'],
      final_output: 'Test job completed successfully',
      raw_telemetry: { test: true }
    }
  });
  console.log('Result:', JSON.parse(result1.content[0].text));

  console.log('\n=== Test 2: create_record for onchain_artifacts ===');
  const result2 = await createRecord({
    table_name: 'onchain_artifacts',
    data: {
      cid: 'test-cid-123',
      topic: 'test-result',
      content: 'This is a test artifact content'
    }
  });
  console.log('Result:', JSON.parse(result2.content[0].text));

  console.log('\n=== Test 3: create_record for onchain_messages ===');
  const result3 = await createRecord({
    table_name: 'onchain_messages',
    data: {
      content: 'Test message via create_record',
      status: 'PENDING'
    }
  });
  console.log('Result:', JSON.parse(result3.content[0].text));

  console.log('\n=== Test 4: create_artifact tool ===');
  const result4 = await createArtifactTool({
    topic: 'test-artifact',
    content: 'This is a test artifact created via the dedicated tool',
    cid: 'test-cid-456'
  });
  console.log('Result:', JSON.parse(result4.content[0].text));

  console.log('\n=== Test 5: create_message tool ===');
  const result5 = await createMessageTool({
    content: 'Test message via create_message tool',
    status: 'PENDING'
  });
  console.log('Result:', JSON.parse(result5.content[0].text));

  console.log('\n=== Test 6: create_record for legacy table (should use Supabase) ===');
  const result6 = await createRecord({
    table_name: 'artifacts',
    data: {
      content: 'Legacy artifact content',
      topic: 'legacy-test',
      status: 'RAW'
    }
  });
  console.log('Result:', JSON.parse(result6.content[0].text));

  console.log('\nAll tests completed!');
}

testAllMCPWriteTools().catch(console.error);

