#!/usr/bin/env tsx
/**
 * Test that dispatch_new_job now correctly handles existing job definitions
 * by posting a new on-chain request instead of returning early
 */

import { config } from 'dotenv';
config();

import { dispatchNewJob } from 'jinn-node/agent/mcp/tools/dispatch_new_job.js';
import { setJobContext } from 'jinn-node/agent/mcp/tools/shared/context.js';
import { readFileSync } from 'fs';

async function testReproduceDispatchIssue() {
  console.log('=== Testing dispatch_new_job with Existing Job Definition ===\n');

  // Set context matching the parent job
  setJobContext(
    '0x0a8eebc7bf02e5dd62a152b6e4691e869ab0379aa7fe71a04ded6deb93c81850',
    'ethereum-protocol-research',
    null,
    null,
    null,
    'be5fb544-1cd3-4d08-a992-dd6f1091b692',
    'main'
  );

  // Read the actual blueprint that was used
  const blueprint = readFileSync('/Users/gcd/Repositories/main/jinn-cli-agents/blueprints/protocol-activity-analysis.json', 'utf8');

  console.log('Dispatching protocol-activity-analysis (job definition already exists)...\n');

  try {
    const result = await dispatchNewJob({
      jobName: 'protocol-activity-analysis',
      blueprint,
      model: 'gemini-2.5-flash',
      enabledTools: ['google_web_search', 'web_fetch', 'create_artifact'],
      skipBranch: true,
    });

    const responseText = result.content[0].text;
    const parsed = JSON.parse(responseText);

    console.log('=== RESULT ===');
    console.log(JSON.stringify(parsed, null, 2));
    console.log('');

    if (!parsed.meta?.ok) {
      console.error('❌ FAILURE: Tool returned error');
      console.error('  Code:', parsed.meta.code);
      console.error('  Message:', parsed.meta.message);
      process.exit(1);
    }

    if (parsed.data) {
      console.log('Data keys:', Object.keys(parsed.data));
      console.log('');
      console.log('✓ Has jobDefinitionId:', !!parsed.data.jobDefinitionId);
      console.log('✓ Has request_ids:', !!parsed.data.request_ids);
      console.log('✓ Has transaction_hash:', !!parsed.data.transaction_hash);
      console.log('✓ Reused definition:', !!parsed.meta.reusedDefinition);
      console.log('');

      if (!parsed.data.request_ids || parsed.data.request_ids.length === 0) {
        console.error('❌ CRITICAL FAILURE: No request_ids returned!');
        console.error('The job definition exists but no on-chain request was posted.');
        process.exit(1);
      }

      if (!parsed.data.transaction_hash) {
        console.error('❌ CRITICAL FAILURE: No transaction_hash returned!');
        console.error('The marketplace call did not complete properly.');
        process.exit(1);
      }

      console.log('✅ SUCCESS: dispatch_new_job correctly posted on-chain request');
      console.log('  Job Definition ID:', parsed.data.jobDefinitionId);
      console.log('  Request IDs:', parsed.data.request_ids);
      console.log('  Transaction:', parsed.data.transaction_hash);
    } else {
      console.error('❌ FAILURE: No data in response');
      process.exit(1);
    }

  } catch (error: any) {
    console.error('❌ Exception:', error.message);
    process.exit(1);
  }
}

testReproduceDispatchIssue().catch(console.error);

