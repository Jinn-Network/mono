#!/usr/bin/env tsx

import { readFileSync } from 'fs';
import { join } from 'path';
import { config } from 'dotenv';
import { dispatchNewJob } from 'jinn-node/agent/mcp/tools/dispatch_new_job.js';

// Load environment variables
config();

async function main() {
  try {
    const promptPath = join(process.cwd(), 'docs/prompts/chief-orchestrator-prompt.md');
    const prompt = readFileSync(promptPath, 'utf-8');
    
    console.log('📄 Reading prompt from:', promptPath);
    console.log('🚀 Posting Chief Orchestrator job...');
    
    const result = await dispatchNewJob({
      objective: 'Lead discovery of profitable crypto opportunities by directing specialized agents to find expectation vs. reality gaps',
      context: 'Chief Orchestrator role - strategic direction and delegation across 5 workstreams: emerging narratives, capital allocation, market infrastructure, incentives/catalysts, and macro/policy shifts',
      acceptanceCriteria: 'Successfully identifies and dispatches workstream agents, integrates signals, and surfaces market misalignments',
      deliverables: 'Market analysis reports, identified opportunities, and delegated sub-jobs to specialized agents',
      constraints: 'Must delegate work to specialized agents, not perform groundwork directly',
      jobName: 'Chief Orchestrator: Crypto Alpha Hunter',
      enabledTools: [
        'dispatch_new_job',
        'dispatch_existing_job', 
        'get_details',
        'search_artifacts',
        'search_jobs',
        'create_artifact',
        'google_web_search',
        'web_fetch'
      ],
    });

    console.log('✅ Job posted successfully!');
    console.log('📋 Result:', JSON.stringify(result, null, 2));
    
  } catch (error) {
    console.error('❌ Error:', error);
    process.exit(1);
  }
}

main();
