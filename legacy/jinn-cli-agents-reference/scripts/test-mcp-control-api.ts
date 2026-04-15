#!/usr/bin/env tsx
// @ts-nocheck

/**
 * Test script for MCP Control API integration
 * 
 * This script tests the Control API path in MCP write tools by:
 * 1. Setting up mock job context with requestId and mechAddress
 * 2. Testing create_record routing for onchain_* tables
 * 3. Testing create_artifact tool
 * 4. Verifying error handling and fallback behavior
 */

import 'dotenv/config';
import { createRecord } from 'jinn-node/agent/mcp/tools/create-record.js';
import { createArtifactTool } from 'jinn-node/agent/mcp/tools/create_artifact.js';
import { getCurrentJobContext } from 'jinn-node/agent/mcp/tools/shared/context.js';

// Mock the job context for testing
const originalGetCurrentJobContext = getCurrentJobContext;
const mockJobContext = {
  jobId: 'test-job-123',
  jobDefinitionId: 'test-def-456',
  jobName: 'Control API Test',
  projectRunId: 'test-project-789',
  sourceEventId: 'test-event-101',
  projectDefinitionId: 'test-project-def-202',
  requestId: '0x1234567890abcdef1234567890abcdef12345678',
  mechAddress: '0xabcdef1234567890abcdef1234567890abcdef12'
};

// Override the context function for testing
(global as any).getCurrentJobContext = () => mockJobContext;

async function testControlApiIntegration() {
  console.log('🧪 Testing MCP Control API Integration\n');

  // Test 1: create_record with onchain_job_reports (should route to Control API)
  console.log('Test 1: create_record with onchain_job_reports');
  try {
    const result1 = await createRecord({
      table_name: 'onchain_job_reports',
      data: {
        status: 'COMPLETED',
        duration_ms: 5000,
        final_output: 'Test completed successfully'
      }
    });
    
    const parsed1 = JSON.parse(result1.content[0].text);
    console.log('✅ Result:', parsed1.meta.source);
    console.log('   Expected: control_api, Got:', parsed1.meta.source);
    
    if (parsed1.meta.source === 'control_api') {
      console.log('✅ Correctly routed to Control API\n');
    } else {
      console.log('❌ Expected Control API routing\n');
    }
  } catch (error) {
    console.log('❌ Error:', error.message);
    console.log('   This is expected if Control API is not running\n');
  }

  // Test 2: create_record with legacy artifacts table (should route to Supabase)
  console.log('Test 2: create_record with legacy artifacts table');
  try {
    const result2 = await createRecord({
      table_name: 'artifacts',
      data: {
        topic: 'test',
        content: 'Legacy artifact content'
      }
    });
    
    const parsed2 = JSON.parse(result2.content[0].text);
    console.log('✅ Result:', parsed2.meta.source);
    console.log('   Expected: supabase, Got:', parsed2.meta.source);
    
    if (parsed2.meta.source === 'supabase') {
      console.log('✅ Correctly routed to Supabase\n');
    } else {
      console.log('❌ Expected Supabase routing\n');
    }
  } catch (error) {
    console.log('❌ Error:', error.message);
    console.log('   This is expected if Supabase is not configured\n');
  }

  // Test 3: create_artifact tool (should use Control API)
  console.log('Test 3: create_artifact tool');
  try {
    const result3 = await createArtifactTool({
      topic: 'test-analysis',
      content: 'Test artifact content for Control API'
    });
    
    const parsed3 = JSON.parse(result3.content[0].text);
    console.log('✅ Result:', parsed3.meta.source);
    console.log('   Expected: control_api, Got:', parsed3.meta.source);
    
    if (parsed3.meta.source === 'control_api') {
      console.log('✅ Correctly used Control API\n');
    } else {
      console.log('❌ Expected Control API usage\n');
    }
  } catch (error) {
    console.log('❌ Error:', error.message);
    console.log('   This is expected if Control API is not running\n');
  }

  // Test 4: Test with disabled Control API
  console.log('Test 4: create_artifact with disabled Control API');
  const originalUseControlApi = process.env.USE_CONTROL_API;
  process.env.USE_CONTROL_API = 'false';
  
  try {
    const result4 = await createArtifactTool({
      topic: 'test-disabled',
      content: 'Test with disabled Control API'
    });
    
    const parsed4 = JSON.parse(result4.content[0].text);
    console.log('✅ Result:', parsed4.meta.code);
    console.log('   Expected: CONTROL_API_DISABLED, Got:', parsed4.meta.code);
    
    if (parsed4.meta.code === 'CONTROL_API_DISABLED') {
      console.log('✅ Correctly detected disabled Control API\n');
    } else {
      console.log('❌ Expected CONTROL_API_DISABLED error\n');
    }
  } catch (error) {
    console.log('❌ Error:', error.message);
  }
  
  // Restore original setting
  process.env.USE_CONTROL_API = originalUseControlApi;

  // Test 5: Test without requestId context
  console.log('Test 5: create_artifact without requestId context');
  const originalMockContext = (global as any).getCurrentJobContext;
  (global as any).getCurrentJobContext = () => ({ ...mockJobContext, requestId: null });
  
  try {
    const result5 = await createArtifactTool({
      topic: 'test-no-context',
      content: 'Test without requestId'
    });
    
    const parsed5 = JSON.parse(result5.content[0].text);
    console.log('✅ Result:', parsed5.meta.code);
    console.log('   Expected: MISSING_REQUEST_ID, Got:', parsed5.meta.code);
    
    if (parsed5.meta.code === 'MISSING_REQUEST_ID') {
      console.log('✅ Correctly detected missing requestId\n');
    } else {
      console.log('❌ Expected MISSING_REQUEST_ID error\n');
    }
  } catch (error) {
    console.log('❌ Error:', error.message);
  }
  
  // Restore original context
  (global as any).getCurrentJobContext = originalMockContext;

  console.log('🎉 Control API integration tests completed!');
  console.log('\nNote: Some tests may show errors if the Control API or Supabase');
  console.log('are not running. This is expected behavior for testing.');
}

// Run the tests
testControlApiIntegration().catch(console.error);
