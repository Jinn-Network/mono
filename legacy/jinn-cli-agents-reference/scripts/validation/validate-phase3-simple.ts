#!/usr/bin/env tsx
/**
 * Simple Phase 3 Validation: Progress Checkpoint
 * 
 * Creates a linear sequence of 3 jobs to validate workstream progress visibility:
 * 1. Job A: Research task (creates artifacts)
 * 2. Job B: Different research task (creates artifacts)  
 * 3. Job C: Synthesis task (should see A and B's progress via checkpoint)
 * 
 * Success criteria:
 * - C's worker logs show workstream progress fetch
 * - C's worker logs show AI summarization
 * - C's blueprint is augmented with progress summary
 * - C's output demonstrates awareness of A and B's work
 */

import { dispatchNewJob } from 'jinn-node/agent/mcp/tools/dispatch_new_job.js';
import { GraphQLClient, gql } from 'graphql-request';
import { spawn } from 'child_process';
import { config } from 'dotenv';

config();

const PONDER_URL = process.env.PONDER_GRAPHQL_URL || 'https://indexer.jinn.network/graphql';
const client = new GraphQLClient(PONDER_URL);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function log(msg: string) {
  console.log(`[VALIDATION] ${msg}`);
}

async function runWorker(requestId: string, timeout: number = 600000): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    log(`Starting worker for request ${requestId.slice(0, 10)}... (timeout: ${timeout/1000}s)`);
    
    let stdout = '';
    let stderr = '';
    let progressInterval: NodeJS.Timeout;
    let lastProgressTime = Date.now();
    
    const worker = spawn('yarn', ['dev:mech', '--single'], {
      env: {
        ...process.env,
        MECH_TARGET_REQUEST_ID: requestId,
      },
      cwd: process.cwd(),
    });
    
    worker.stdout.on('data', (data) => {
      stdout += data.toString();
      lastProgressTime = Date.now();
    });
    
    worker.stderr.on('data', (data) => {
      stderr += data.toString();
      lastProgressTime = Date.now();
    });
    
    const timeoutId = setTimeout(() => {
      worker.kill();
      clearInterval(progressInterval);
      reject(new Error(`Worker timeout after ${timeout}ms`));
    }, timeout);
    
    progressInterval = setInterval(() => {
      const elapsed = Math.floor((Date.now() - lastProgressTime) / 1000);
      log(`  Worker still running... (${elapsed}s since last output)`);
    }, 30000);
    
    worker.on('close', (code) => {
      clearTimeout(timeoutId);
      clearInterval(progressInterval);
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(`Worker exited with code ${code}`));
      }
    });
  });
}

async function waitForDelivery(requestId: string, maxWait: number = 30000): Promise<boolean> {
  const query = gql`
    query GetDelivery($id: String!) {
      request(id: $id) {
        delivered
      }
    }
  `;
  
  const startTime = Date.now();
  while (Date.now() - startTime < maxWait) {
    try {
      const result = await client.request<{ request: { delivered: boolean } | null }>(query, { id: requestId });
      if (result.request?.delivered) {
        return true;
      }
    } catch (e) {
      // Continue waiting
    }
    await sleep(2000);
  }
  return false;
}

async function main() {
  console.log('\n========================================');
  console.log('Phase 3 Simple Validation: Progress Checkpoint');
  console.log('========================================\n');
  
  const timestamp = Date.now();
  const workstreamId = `phase3-simple-${timestamp}`;
  
  let jobAId: string | null = null;
  let jobBId: string | null = null;
  let jobCId: string | null = null;
  
  try {
    // ===== Job A: First research task =====
    log('Creating Job A (Research: Token Utility)...');
    
    const jobAResult = await dispatchNewJob({
      objective: 'Research OLAS token utility and create summary artifact',
      blueprint: JSON.stringify({
        assertions: [
          {
            id: 'RESEARCH-A',
            assertion: 'Create artifact with research findings',
            examples: {
              do: ['Use web_search to research OLAS token utility', 'Create artifact with findings'],
              dont: ['Skip artifact creation'],
            },
            commentary: 'Research task must produce artifact with findings',
          },
        ],
      }),
      model: 'gemini-2.5-flash',
      enabledTools: ['web_search', 'create_artifact'],
      jobName: `${workstreamId}-job-a`,
      skipBranch: true,
      message: `workstreamId: ${workstreamId}`,
    });
    
    const jobAParsed = JSON.parse(jobAResult.content[0].text);
    if (!jobAParsed.data?.request_ids?.[0]) {
      throw new Error(`Job A dispatch failed: ${JSON.stringify(jobAParsed)}`);
    }
    jobAId = jobAParsed.data.request_ids[0];
    log(`Job A created: ${jobAId.slice(0, 10)}...`);
    
    // Run Job A
    log('Running Job A...');
    await runWorker(jobAId);
    const jobADelivered = await waitForDelivery(jobAId);
    if (!jobADelivered) {
      throw new Error('Job A failed to deliver');
    }
    log('✅ Job A completed\n');
    
    // ===== Job B: Second research task =====
    log('Creating Job B (Research: Staking Mechanisms)...');
    
    const jobBResult = await dispatchNewJob({
      objective: 'Research OLAS staking mechanisms and create summary artifact',
      blueprint: JSON.stringify({
        assertions: [
          {
            id: 'RESEARCH-B',
            assertion: 'Create artifact with research findings',
            examples: {
              do: ['Use web_search to research OLAS staking', 'Create artifact with findings'],
              dont: ['Skip artifact creation'],
            },
            commentary: 'Research task must produce artifact with findings',
          },
        ],
      }),
      model: 'gemini-2.5-flash',
      enabledTools: ['web_search', 'create_artifact'],
      jobName: `${workstreamId}-job-b`,
      skipBranch: true,
      message: `workstreamId: ${workstreamId}`,
    });
    
    const jobBParsed = JSON.parse(jobBResult.content[0].text);
    if (!jobBParsed.data?.request_ids?.[0]) {
      throw new Error(`Job B dispatch failed: ${JSON.stringify(jobBParsed)}`);
    }
    jobBId = jobBParsed.data.request_ids[0];
    log(`Job B created: ${jobBId.slice(0, 10)}...`);
    
    // Run Job B
    log('Running Job B...');
    await runWorker(jobBId);
    const jobBDelivered = await waitForDelivery(jobBId);
    if (!jobBDelivered) {
      throw new Error('Job B failed to deliver');
    }
    log('✅ Job B completed\n');
    
    // ===== Job C: Synthesis task (with progress checkpoint) =====
    log('Creating Job C (Synthesis with progress checkpoint)...');
    
    const jobCResult = await dispatchNewJob({
      objective: 'Synthesize findings from prior workstream research into comprehensive report',
      blueprint: JSON.stringify({
        assertions: [
          {
            id: 'SYNTHESIS-C',
            assertion: 'Must reference and build upon prior workstream research',
            examples: {
              do: [
                'Acknowledge research from earlier jobs in workstream',
                'Integrate findings from multiple sources',
                'Create comprehensive synthesis artifact',
              ],
              dont: ['Ignore prior workstream context', 'Start research from scratch'],
            },
            commentary: 'Synthesis requires awareness of workstream history',
          },
        ],
      }),
      model: 'gemini-2.5-flash',
      enabledTools: ['create_artifact', 'search_artifacts'],
      jobName: `${workstreamId}-job-c`,
      skipBranch: true,
      message: `workstreamId: ${workstreamId}`,
    });
    
    const jobCParsed = JSON.parse(jobCResult.content[0].text);
    if (!jobCParsed.data?.request_ids?.[0]) {
      throw new Error(`Job C dispatch failed: ${JSON.stringify(jobCParsed)}`);
    }
    jobCId = jobCParsed.data.request_ids[0];
    log(`Job C created: ${jobCId.slice(0, 10)}...`);
    
    // Run Job C and capture logs
    log('Running Job C (this should show progress checkpoint in action)...');
    const jobCRun = await runWorker(jobCId, 900000); // 15 min
    
    // Validate progress checkpoint worked
    log('\n=== VALIDATION CHECKS ===\n');
    
    // Check 1: Worker logs show workstream fetch
    const hasWorkstreamFetch = jobCRun.stderr.includes('workstreamId') || jobCRun.stdout.includes('workstreamId');
    log(`Check 1 - Workstream data fetch: ${hasWorkstreamFetch ? '✅' : '❌'}`);
    
    // Check 2: Worker logs show AI summarization
    const hasAISummary = jobCRun.stderr.includes('AI summarization') || jobCRun.stderr.includes('summarizeWorkstreamProgress');
    log(`Check 2 - AI summarization invoked: ${hasAISummary ? '✅' : '❌'}`);
    
    // Check 3: Job C completed
    const jobCDelivered = await waitForDelivery(jobCId!);
    log(`Check 3 - Job C delivered: ${jobCDelivered ? '✅' : '❌'}`);
    
    // Check 4: Inspect Job C output for awareness of A and B
    log('\nFetching Job C output...');
    const inspectQuery = gql`
      query GetJobOutput($id: String!) {
        request(id: $id) {
          deliveryIpfsHash
        }
      }
    `;
    const jobCData = await client.request<{ request: { deliveryIpfsHash?: string } | null }>(inspectQuery, { id: jobCId });
    
    if (jobCData.request?.deliveryIpfsHash) {
      // Fetch delivery content from IPFS
      const ipfsUrl = `https://gateway.autonolas.tech/ipfs/${jobCData.request.deliveryIpfsHash}`;
      const deliveryResponse = await fetch(ipfsUrl);
      const deliveryContent = await deliveryResponse.json();
      
      const output = deliveryContent.output || '';
      const hasJobAAwareness = output.toLowerCase().includes('utility') || output.toLowerCase().includes('token');
      const hasJobBAwareness = output.toLowerCase().includes('staking');
      const hasSynthesis = output.toLowerCase().includes('synthesis') || output.toLowerCase().includes('findings');
      
      log(`\nCheck 4 - Job C output analysis:`);
      log(`  - References utility research (Job A): ${hasJobAAwareness ? '✅' : '❌'}`);
      log(`  - References staking research (Job B): ${hasJobBAwareness ? '✅' : '❌'}`);
      log(`  - Demonstrates synthesis: ${hasSynthesis ? '✅' : '❌'}`);
      
      log(`\n=== Job C Output Preview ===`);
      log(output.substring(0, 500) + '...\n');
    }
    
    log('\n=== VALIDATION COMPLETE ===');
    log(`\nWorkstream ID: ${workstreamId}`);
    log(`Job A: ${jobAId}`);
    log(`Job B: ${jobBId}`);
    log(`Job C: ${jobCId}`);
    log(`\nInspect with: yarn inspect-job-run ${jobCId}`);
    
  } catch (error: any) {
    console.error('\n❌ VALIDATION ERROR:', error.message);
    console.error('\nPartial results:');
    if (jobAId) console.log(`Job A: ${jobAId}`);
    if (jobBId) console.log(`Job B: ${jobBId}`);
    if (jobCId) console.log(`Job C: ${jobCId}`);
    process.exit(1);
  }
}

main().catch(console.error);
