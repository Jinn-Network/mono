#!/usr/bin/env tsx
/**
 * Post Chief Orchestrator job via Control API (proper way for on-chain jobs)
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import fetch from 'cross-fetch';
import { getMechAddress } from 'jinn-node/env/operate-profile.js';

const CONTROL_API_URL = process.env.CONTROL_API_URL || 'http://localhost:4001/graphql';
const MECH_WORKER_ADDRESS = getMechAddress();
const PRIORITY_MECH = getMechAddress() || '0x8c083Dfe9bee719a05Ba3c75A9B16BE4ba52c299';
const PROMPT_FILE = process.argv[2] || join(process.cwd(), 'docs/prompts/chief-orchestrator-prompt.md');

async function postJobViaControlApi() {
  console.log('📄 Reading prompt from:', PROMPT_FILE);
  const promptContent = readFileSync(PROMPT_FILE, 'utf-8');
  
  // Parse the markdown prompt to extract structured fields
  const objective = 'Lead discovery of profitable crypto opportunities by directing specialized agents to find expectation vs. reality gaps in the market';
  const context = 'Chief Orchestrator role - strategic direction and delegation of high-level goals across workstreams. This is the top-level job that will spawn sub-jobs.';
  const acceptanceCriteria = 'Successfully dispatches workstream agents, integrates signals, and identifies alpha opportunities based on market misalignments';
  const deliverables = 'Market analysis reports, identified opportunities, delegated sub-jobs to specialized agents';
  const constraints = 'Must delegate work to specialized agents, not perform groundwork directly. Focus on strategic direction and coordination.';
  
  const jobName = 'Chief Orchestrator - Crypto Alpha Hunter';
  const jobDefinitionId = randomUUID();
  const enabledTools = [
    'dispatch_new_job',
    'dispatch_existing_job',
    'get_details',
    'search_artifacts',
    'search_jobs',
    'create_artifact'
  ];

  console.log('');
  console.log('🎯 Job Configuration:');
  console.log('   Name:', jobName);
  console.log('   Definition ID:', jobDefinitionId);
  console.log('   Priority Mech:', PRIORITY_MECH);
  console.log('   Enabled Tools:', enabledTools.join(', '));
  console.log('');
  console.log('🚀 Posting job via Control API...');

  const mutation = `
    mutation DispatchNewJob(
      $objective: String!
      $context: String!
      $acceptanceCriteria: String!
      $deliverables: String
      $constraints: String
      $jobName: String!
      $enabledTools: [String!]
    ) {
      dispatchNewJob(
        objective: $objective
        context: $context
        acceptanceCriteria: $acceptanceCriteria
        deliverables: $deliverables
        constraints: $constraints
        jobName: $jobName
        enabledTools: $enabledTools
      ) {
        ok
        code
        message
        data {
          jobDefinitionId
          request_ids
          transaction_hash
          ipfs_metadata_url
        }
      }
    }
  `;

  const variables = {
    objective,
    context,
    acceptanceCriteria,
    deliverables,
    constraints,
    jobName,
    enabledTools,
  };

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  if (MECH_WORKER_ADDRESS) {
    headers['X-Worker-Address'] = MECH_WORKER_ADDRESS;
  }

  try {
    const response = await fetch(CONTROL_API_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        query: mutation,
        variables,
      }),
    });

    const result = await response.json();

    if (result.errors) {
      console.error('❌ GraphQL Errors:', JSON.stringify(result.errors, null, 2));
      process.exit(1);
    }

    const data = result.data?.dispatchNewJob;
    
    if (!data?.ok) {
      console.error('❌ Job dispatch failed:', data?.message || 'Unknown error');
      process.exit(1);
    }

    console.log('');
    console.log('✅ SUCCESS!');
    console.log('━'.repeat(60));
    console.log('📋 Job Details:');
    console.log('   Job Definition ID:', data.data?.jobDefinitionId || jobDefinitionId);
    if (data.data?.request_ids?.length) {
      console.log('   Request IDs:', data.data.request_ids.join(', '));
    }
    if (data.data?.transaction_hash) {
      console.log('   Transaction Hash:', data.data.transaction_hash);
      console.log('   View on BaseScan: https://basescan.org/tx/' + data.data.transaction_hash);
    }
    if (data.data?.ipfs_metadata_url) {
      console.log('   IPFS Metadata:', data.data.ipfs_metadata_url);
    }
    console.log('━'.repeat(60));
    console.log('');
    console.log('👀 Monitor the job graph at: http://localhost:3000/graph');
    console.log('');
    
  } catch (error: any) {
    console.error('❌ Error posting job:', error.message);
    process.exit(1);
  }
}

postJobViaControlApi();








