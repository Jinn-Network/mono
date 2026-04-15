#!/usr/bin/env tsx
import '../../env/index.js';
import { dispatchNewJob } from 'jinn-node/agent/mcp/tools/dispatch_new_job.js';
import { logger } from 'jinn-node/logging/index.js';
import { randomBytes } from 'crypto';
import { spawn } from 'child_process';
import { request as graphqlRequest } from 'graphql-request';

// Helper to parse the JSON response from the tool
function parseToolResponse(response: any) {
  if (response?.content?.[0]?.text) {
    return JSON.parse(response.content[0].text);
  }
  throw new Error('Invalid tool response format');
}

// Helper to run mech worker with target request
async function runMechWorker(targetRequestId: string): Promise<{ success: boolean; output: string }> {
  return new Promise((resolve) => {
    logger.info(`Running worker for target request: ${targetRequestId}`);
    
    // Ensure all environment variables are passed, especially MECH_TARGET_REQUEST_ID
    const worker = spawn('yarn', ['dev:mech', '--single'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        MECH_TARGET_REQUEST_ID: targetRequestId,
      },
      stdio: 'pipe',
    });

    let output = '';
    let errorOutput = '';

    worker.stdout?.on('data', (data) => {
      const text = data.toString();
      output += text;
      process.stdout.write(text);
    });

    worker.stderr?.on('data', (data) => {
      const text = data.toString();
      errorOutput += text;
      process.stderr.write(text);
    });

    worker.on('close', (code) => {
      const success = code === 0;
      logger.info(`Worker exited with code ${code}`);
      resolve({ success, output: output + errorOutput });
    });
  });
}

// Helper to check if request is delivered
async function isRequestDelivered(requestId: string): Promise<boolean> {
  const PONDER_URL = process.env.PONDER_GRAPHQL_URL || 'https://indexer.jinn.network/graphql';
  
  try {
    const response = await graphqlRequest(PONDER_URL, `
      query GetRequest($requestId: String!) {
        request(id: $requestId) {
          id
          delivered
        }
      }
    `, { requestId });
    
    return (response as any)?.request?.delivered === true;
  } catch (error) {
    logger.error({ error }, 'Failed to check request status');
    return false;
  }
}

// Helper to check if job definition is complete
async function isJobDefinitionComplete(jobDefId: string): Promise<boolean> {
  const PONDER_URL = process.env.PONDER_GRAPHQL_URL || 'https://indexer.jinn.network/graphql';
  
  try {
    // Get all requests for this job definition
    const response = await graphqlRequest(PONDER_URL, `
      query GetJobDefRequests($jobDefId: String!) {
        requests(where: { jobDefinitionId: $jobDefId }) {
          items {
            id
            delivered
          }
        }
      }
    `, { jobDefId });
    
    const requests = (response as any)?.requests?.items || [];
    
    if (requests.length === 0) {
      return false;
    }
    
    // All requests must be delivered
    return requests.every((r: any) => r.delivered === true);
  } catch (error) {
    logger.error({ error }, 'Failed to check job definition status');
    return false;
  }
}

async function main() {
  logger.info('🧪 Starting Phase 2 Dependency Test Suite...');
  logger.info('');
  
  const runId = randomBytes(4).toString('hex');
  let allTestsPassed = true;

  try {
    // Step 1: Dispatch Job A (no dependencies)
    logger.info('━━━ STEP 1: Dispatch Job A (no dependencies) ━━━');
    const blueprintA = JSON.stringify({
      assertions: [
        {
          id: 'TEST-A-001',
          assertion: 'Return "Job A complete" and exit successfully',
          examples: {
            do: ['Log completion message', 'Exit with success code'],
            dont: ['Throw errors', 'Skip completion message']
          },
          commentary: 'Simple test job with no dependencies'
        }
      ]
    });

    const jobA = {
      jobName: `test-dep-job-a-${runId}`,
      model: 'gemini-2.5-flash',
      blueprint: blueprintA,
      enabledTools: [],
    };

    const rawResultA = await dispatchNewJob(jobA);
    const resultA = parseToolResponse(rawResultA);
    
    if (!resultA.meta.ok || !resultA.data?.request_ids?.[0]) {
      logger.error({ result: resultA }, 'Failed to dispatch Job A');
      throw new Error(`Failed to dispatch Job A: ${resultA.meta.message}`);
    }
    
    const requestIdA = resultA.data.request_ids[0];
    logger.info(`✅ Job A dispatched: ${requestIdA}`);
    
    // Query for Job A's job definition ID
    const { request: graphqlReq } = await import('graphql-request');
    const PONDER_URL = process.env.PONDER_GRAPHQL_URL || 'https://indexer.jinn.network/graphql';
    
    let jobDefIdA: string | null = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      if (attempt > 0) await new Promise(resolve => setTimeout(resolve, 2000));
      
      try {
        const response = await graphqlReq(PONDER_URL, `
          query GetJobDefId($requestId: String!) {
            request(id: $requestId) {
              jobDefinitionId
            }
          }
        `, { requestId: requestIdA });
        
        jobDefIdA = (response as any)?.request?.jobDefinitionId;
        if (jobDefIdA) break;
      } catch (e) {
        continue;
      }
    }

    if (!jobDefIdA) {
      throw new Error(`Failed to retrieve job definition ID for Job A`);
    }
    
    logger.info(`✅ Job A Definition ID: ${jobDefIdA}`);
    logger.info('');

    // Step 2: Dispatch Job B (depends on Job A)
    logger.info('━━━ STEP 2: Dispatch Job B (depends on Job A) ━━━');
    const blueprintB = JSON.stringify({
      assertions: [
        {
          id: 'TEST-B-001',
          assertion: 'Return "Job B complete" and exit successfully',
          examples: {
            do: ['Log completion message', 'Exit with success code'],
            dont: ['Execute before Job A completes', 'Ignore dependencies']
          },
          commentary: `Depends on Job Definition A (${jobDefIdA})`
        }
      ]
    });

    const jobB = {
      jobName: `test-dep-job-b-${runId}`,
      model: 'gemini-2.5-flash',
      blueprint: blueprintB,
      enabledTools: [],
      dependencies: [jobDefIdA],
    };

    const rawResultB = await dispatchNewJob(jobB);
    const resultB = parseToolResponse(rawResultB);
    
    if (!resultB.meta.ok || !resultB.data?.request_ids?.[0]) {
      logger.error({ result: resultB }, 'Failed to dispatch Job B');
      throw new Error(`Failed to dispatch Job B: ${resultB.meta.message}`);
    }
    
    const requestIdB = resultB.data.request_ids[0];
    logger.info(`✅ Job B dispatched: ${requestIdB}`);
    logger.info(`   Dependencies: [${jobDefIdA}]`);
    logger.info('');

    // Wait for indexing
    logger.info('Waiting 5 seconds for Ponder to index...');
    await new Promise(resolve => setTimeout(resolve, 5000));

    // Step 3: TEST - Try to run Job B (should fail due to unmet dependencies)
    logger.info('━━━ TEST 1: Run Job B (should skip due to unmet dependencies) ━━━');
    const test1Result = await runMechWorker(requestIdB);
    
    // Check that Job B was NOT delivered
    const jobBDeliveredAfterTest1 = await isRequestDelivered(requestIdB);
    
    if (jobBDeliveredAfterTest1) {
      logger.error('❌ TEST 1 FAILED: Job B was delivered despite unmet dependencies');
      allTestsPassed = false;
    } else if (test1Result.output.includes('Dependencies not met') || 
               test1Result.output.includes('waiting for job definitions')) {
      logger.info('✅ TEST 1 PASSED: Job B correctly skipped (dependencies not met)');
    } else {
      logger.warn('⚠️  TEST 1 UNCERTAIN: Job B not delivered, but dependency message not found in logs');
    }
    logger.info('');

    // Step 4: Run Job A until it succeeds
    logger.info('━━━ STEP 3: Execute Job A ━━━');
    const jobAResult = await runMechWorker(requestIdA);
    
    if (!jobAResult.success) {
      throw new Error('Job A execution failed');
    }
    
    // Verify Job A is delivered
    await new Promise(resolve => setTimeout(resolve, 3000)); // Wait for indexing
    const jobADelivered = await isRequestDelivered(requestIdA);
    
    if (!jobADelivered) {
      throw new Error('Job A not marked as delivered');
    }
    
    logger.info('✅ Job A completed and delivered');
    logger.info('');

    // Step 5: Verify Job Definition A is complete
    logger.info('━━━ STEP 4: Verify Job Definition A completion ━━━');
    const jobDefAComplete = await isJobDefinitionComplete(jobDefIdA);
    
    if (!jobDefAComplete) {
      throw new Error('Job Definition A not marked as complete');
    }
    
    logger.info('✅ Job Definition A is complete');
    logger.info('');

    // Step 6: TEST - Run Job B (should succeed now)
    logger.info('━━━ TEST 2: Run Job B (should execute successfully) ━━━');
    const test2Result = await runMechWorker(requestIdB);
    
    if (!test2Result.success) {
      logger.error('❌ TEST 2 FAILED: Job B execution failed');
      allTestsPassed = false;
    } else {
      logger.info('✅ Job B execution completed');
    }
    
    // Verify Job B is delivered
    await new Promise(resolve => setTimeout(resolve, 3000)); // Wait for indexing
    const jobBDelivered = await isRequestDelivered(requestIdB);
    
    if (!jobBDelivered) {
      logger.error('❌ TEST 2 FAILED: Job B not marked as delivered');
      allTestsPassed = false;
    } else {
      logger.info('✅ TEST 2 PASSED: Job B completed and delivered');
    }
    logger.info('');

    // Summary
    logger.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    logger.info('');
    logger.info('📊 TEST SUMMARY');
    logger.info('');
    logger.info(`Job A: ${requestIdA}`);
    logger.info(`Job B: ${requestIdB}`);
    logger.info(`Job Definition A: ${jobDefIdA}`);
    logger.info('');
    logger.info(`Test 1 (Job B should skip): ${!jobBDeliveredAfterTest1 ? '✅ PASSED' : '❌ FAILED'}`);
    logger.info(`Test 2 (Job B should execute): ${jobBDelivered ? '✅ PASSED' : '❌ FAILED'}`);
    logger.info('');
    
    if (allTestsPassed && jobBDelivered && !jobBDeliveredAfterTest1) {
      logger.info('✅ ALL TESTS PASSED - Dependency system working correctly!');
      process.exit(0);
    } else {
      logger.error('❌ SOME TESTS FAILED - Review output above');
      process.exit(1);
    }

  } catch (error) {
    logger.error({ error }, 'Test suite failed');
    process.exit(1);
  }
}

main();
