#!/usr/bin/env tsx
/**
 * Verification script to demonstrate that dispatch_new_job always creates unique job definitions
 * 
 * This script:
 * 1. Calls dispatch_new_job twice with the same job name
 * 2. Verifies that each call produces a distinct jobDefinitionId
 * 3. Demonstrates that Job = unique node in work graph, not a reusable template
 */

import { dispatchNewJob } from 'jinn-node/agent/mcp/tools/dispatch_new_job.js';

async function verifyJobDefinitionUniqueness() {
  console.log('🔍 Verifying Job Definition Uniqueness\n');
  console.log('═══════════════════════════════════════════════════════════════════\n');

  const testJobName = 'test-job-verification';
  const blueprint = JSON.stringify({
    assertions: [
      {
        id: 'TST-001',
        assertion: 'Verify that job definitions are unique',
        examples: {
          do: ['Create distinct job instances'],
          dont: ['Reuse job definitions by name'],
        },
        commentary: 'Each dispatch_new_job call should create a new job instance',
      },
    ],
  });

  const args = {
    jobName: testJobName,
    blueprint,
    skipBranch: true, // Skip branch creation for this test
  };

  try {
    // First dispatch
    console.log(`📝 Dispatching job #1 with name: "${testJobName}"`);
    const result1 = await dispatchNewJob(args);
    const response1 = JSON.parse(result1.content[0].text);

    if (!response1.meta.ok) {
      console.error('❌ First dispatch failed:', response1.meta);
      process.exit(1);
    }

    const jobDefId1 = response1.data.jobDefinitionId;
    console.log(`✅ Job #1 created with ID: ${jobDefId1}\n`);

    // Second dispatch with same job name
    console.log(`📝 Dispatching job #2 with same name: "${testJobName}"`);
    const result2 = await dispatchNewJob(args);
    const response2 = JSON.parse(result2.content[0].text);

    if (!response2.meta.ok) {
      console.error('❌ Second dispatch failed:', response2.meta);
      process.exit(1);
    }

    const jobDefId2 = response2.data.jobDefinitionId;
    console.log(`✅ Job #2 created with ID: ${jobDefId2}\n`);

    // Verify uniqueness
    console.log('═══════════════════════════════════════════════════════════════════\n');
    if (jobDefId1 !== jobDefId2) {
      console.log('✅ SUCCESS: Each dispatch created a unique job definition!');
      console.log(`   Job #1: ${jobDefId1}`);
      console.log(`   Job #2: ${jobDefId2}`);
      console.log('\n📊 Result: Jobs are now unique nodes in the work graph.');
      console.log('   Each JobDefinition represents a distinct job instance,');
      console.log('   not a reusable template.\n');
    } else {
      console.error('❌ FAILURE: Both dispatches created the same job definition ID!');
      console.error('   This should not happen after the refactor.');
      process.exit(1);
    }

    // Verify no reusedDefinition flag
    if (response1.meta.reusedDefinition !== undefined || response2.meta.reusedDefinition !== undefined) {
      console.error('⚠️  WARNING: reusedDefinition flag still present in response meta');
      console.error('   This flag should have been removed.');
    }

    console.log('═══════════════════════════════════════════════════════════════════\n');

  } catch (error) {
    console.error('❌ Error during verification:', error);
    process.exit(1);
  }
}

// Run verification
verifyJobDefinitionUniqueness().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});

