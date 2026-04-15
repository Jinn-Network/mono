#!/usr/bin/env tsx

/**
 * Venture Launch Helper
 *
 * Dispatches a new job to launch an agentic venture.
 * Reads parameters from command line arguments and environment variables.
 */

import { dispatchNewJob } from 'jinn-node/agent/mcp/tools/dispatch_new_job.js';
import { dispatchExistingJob } from 'jinn-node/agent/mcp/tools/dispatch_existing_job.js';

interface LaunchParams {
  jobName: string;
  objective: string;
  context: string;
  acceptanceCriteria: string;
  deliverables?: string;
  constraints?: string;
  enabledTools?: string[];
  contextFile?: string;
}

async function main() {
  // Parse command line arguments
  const args = process.argv.slice(2);
  const params: Partial<LaunchParams> = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const value = args[i + 1];

    switch (arg) {
      case '--job-name':
        params.jobName = value;
        i++;
        break;
      case '--objective':
        params.objective = value;
        i++;
        break;
      case '--context':
        params.context = value;
        i++;
        break;
      case '--context-file':
        params.contextFile = value;
        i++;
        break;
      case '--acceptance-criteria':
        params.acceptanceCriteria = value;
        i++;
        break;
      case '--deliverables':
        params.deliverables = value;
        i++;
        break;
      case '--constraints':
        params.constraints = value;
        i++;
        break;
      case '--enabled-tools':
        params.enabledTools = value.split(',');
        i++;
        break;
    }
  }

  // Read context from file if --context-file is provided
  if (params.contextFile) {
    try {
      const fs = await import('fs/promises');
      params.context = await fs.readFile(params.contextFile, 'utf-8');
    } catch (error: any) {
      console.error(`Error reading context file: ${error.message}`);
      process.exit(1);
    }
  }

  // Validate required parameters
  if (!params.jobName || !params.objective || !params.context || !params.acceptanceCriteria) {
    console.error('Error: Missing required parameters');
    console.error('Required: --job-name, --objective, --context (or --context-file), --acceptance-criteria');
    process.exit(1);
  }

  // Default enabled tools for ventures
  const defaultTools = [
    'read',
    'write',
    'edit',
    'bash',
    'glob',
    'grep',
    'web_fetch',
    'web_search',
    'dispatch_new_job',
    'dispatch_existing_job',
    'create_artifact',
    'get_details',
    'search_artifacts',
    'finalize_job',
    'list_tools'
  ];

  try {
    console.log(`\n🚀 Launching venture: ${params.jobName}`);
    console.log(`📍 CODE_METADATA_REPO_ROOT: ${process.env.CODE_METADATA_REPO_ROOT || 'not set'}\n`);

    const result = await dispatchNewJob({
      jobName: params.jobName,
      objective: params.objective,
      context: params.context,
      acceptanceCriteria: params.acceptanceCriteria,
      deliverables: params.deliverables,
      constraints: params.constraints,
      enabledTools: params.enabledTools || defaultTools,
    });

    // Parse result
    const response = result?.content?.[0]?.text;
    if (response) {
      const parsed = JSON.parse(response);

      if (!parsed.meta?.ok) {
        console.error(`\n❌ Dispatch failed: ${parsed.meta?.message || 'Unknown error'}`);
        console.error(JSON.stringify(parsed, null, 2));
        process.exit(1);
      }

      // Check if job already exists
      if (parsed.meta?.code === 'JOB_EXISTS') {
        console.log(`\n⚠️  Job definition already exists. Re-dispatching existing job...\n`);

        // Dispatch the existing job
        const redispatchResult = await dispatchExistingJob({
          jobName: params.jobName,
        });

        const redispatchResponse = redispatchResult?.content?.[0]?.text;
        if (!redispatchResponse) {
          console.error('\n❌ Failed to re-dispatch existing job');
          process.exit(1);
        }

        const redispatchParsed = JSON.parse(redispatchResponse);
        if (!redispatchParsed.meta?.ok) {
          console.error(`\n❌ Re-dispatch failed: ${redispatchParsed.meta?.message || 'Unknown error'}`);
          console.error(JSON.stringify(redispatchParsed, null, 2));
          process.exit(1);
        }

        // Use the redispatch result for output
        const data = redispatchParsed.data ?? {};
        const requestId = data.request_id || data.requestId || (Array.isArray(data.request_ids) ? data.request_ids[0] : undefined);
        const ipfsHash = data.ipfs_hash || data.ipfsHash || undefined;
        const ipfsUrl = data.ipfs_gateway_url || (ipfsHash ? `https://gateway.autonolas.tech/ipfs/${ipfsHash}` : undefined);

        console.log('✅ Existing job re-dispatched successfully!\n');
        console.log(`Request ID: ${requestId || 'N/A'}`);
        console.log(`IPFS Hash: ${ipfsHash || 'N/A'}`);
        if (ipfsUrl) {
          console.log(`IPFS URL: ${ipfsUrl}`);
        }

        console.log(`\nView in Ponder:`);
        console.log(`  http://localhost:${process.env.PONDER_PORT || 42069}/graphql`);
        if (requestId) {
          console.log(`\nQuery:`);
          console.log(`  query { request(id: "${requestId}") { id jobName delivered } }`);
        }
        return;
      }

      const data = parsed.data ?? {};
      const requestId = data.request_id || data.requestId || (Array.isArray(data.request_ids) ? data.request_ids[0] : undefined);
      const ipfsHash = data.ipfs_hash || data.ipfsHash || undefined;
      const ipfsUrl = data.ipfs_gateway_url || (ipfsHash ? `https://gateway.autonolas.tech/ipfs/${ipfsHash}` : undefined);

      console.log('✅ Venture launched successfully!\n');
      console.log(`Request ID: ${requestId || 'N/A'}`);
      console.log(`IPFS Hash: ${ipfsHash || 'N/A'}`);
      if (ipfsUrl) {
        console.log(`IPFS URL: ${ipfsUrl}`);
      }

      console.log(`\nView in Ponder:`);
      console.log(`  http://localhost:${process.env.PONDER_PORT || 42069}/graphql`);
      if (requestId) {
        console.log(`\nQuery:`);
        console.log(`  query { request(id: "${requestId}") { id jobName delivered } }`);
      } else {
        console.warn('\n⚠️  Dispatch response did not include a request ID. Full payload:');
        console.warn(JSON.stringify(data, null, 2));
      }
    }
  } catch (error: any) {
    console.error(`\n❌ Error launching venture: ${error.message}`);
    if (error.stack) {
      console.error(error.stack);
    }
    process.exit(1);
  }
}

main();
