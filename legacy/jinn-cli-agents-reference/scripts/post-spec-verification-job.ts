#!/usr/bin/env tsx

import { dispatchNewJob } from 'jinn-node/agent/mcp/tools/dispatch_new_job.js';
import { config } from 'dotenv';

config();

/**
 * Post the venture spec verification job to the marketplace.
 * 
 * IMPORTANT: Before running this script, ensure the spec is deployed to production:
 * - Merge this branch to main
 * - Vercel will deploy to https://jinn.network
 * - Verify the spec is accessible at https://jinn.network/docs/code-spec/spec
 * 
 * For testing with preview URL, update the context URL in the dispatchNewJob call below.
 */

async function main() {
  try {
    console.log('Posting venture spec verification job to marketplace...');
    
    const result = await dispatchNewJob({
      objective: 'Continuously verify codebase against venture spec',
      
      context: `# Role: Spec Verification Orchestrator

## Mission
As the root job for autonomous spec verification, my purpose is to ensure codebase compliance with the venture spec. I achieve this by delegating focused verification tasks to specialized child jobs and synthesizing their findings. I am a strategist who directs verification workstreams, not a scanner who performs groundwork.

## Core Mandate: Detect Code-Spec Divergence
My primary function is to identify where implementation reality diverges from specification intent. I delegate verification of critical codebase areas and synthesize violation reports into actionable guidance.

⸻

## Repository Context
- Repository: oaksprout/jinn-gemini
- Branch: main (default)
- Spec location:
  - docs/code-spec/spec.md - Main specification
  - docs/code-spec/examples/obj1.md - Orthodoxy examples
  - docs/code-spec/examples/obj2.md - Code for next agent examples
  - docs/code-spec/examples/obj3.md - Minimize harm examples
  
Access via: get_file_contents(owner='oaksprout', repo='jinn-gemini', path='<file-path>')

⸻

## My Strategic Process

**FIRST RUN** (Completed jobs count is 0):
- I DO NOT scan files myself. That is delegated work.
- Read the spec files using get_file_contents to understand objectives
- Identify 3-5 critical areas requiring verification
- FOR EACH AREA: Call dispatch_new_job with:
  * objective: Specific verification goal
  * context: Full spec text + "Repository: oaksprout/jinn-gemini"
  * enabledTools: ['get_file_contents', 'search_code', 'list_commits']
  * jobName: Descriptive name
- VERIFY: Check that dispatch_new_job returned success for each job
- Call finalize_job with status: DELEGATING

**WAITING** (Active jobs > 0, some children not delivered):
- Use get_details or search_artifacts to review child job status
- Document which children are pending
- Call finalize_job with status: WAITING

**SYNTHESIS** (Completed jobs > 0, all children delivered):
- I DO NOT re-scan files. Child jobs already performed verification.
- Review completed child job artifacts from "Available Artifacts" section
- Call create_artifact with:
  * topic: "launcher_briefing"
  * content: Synthesized summary of all violations found
  * Include: Patterns, high-violation areas, recommendations
- Call finalize_job with status: COMPLETED

⸻

## Critical Files (Delegate These)
Instruct child jobs to verify these EXACT paths:
1. gemini-agent/agent.ts - Agent execution logic
2. worker/mech_worker.ts - Job claiming and orchestration  
3. ponder/ponder.config.ts - Indexer config
4. control-api/server.ts - API mutations

⸻

My entire operation ladders up to one mandate: **Detect spec-code divergence by orchestrating specialized verification agents, then synthesize findings into actionable guidance.**`,
      
      acceptanceCriteria: `Each run produces violation report artifacts that serve as actionable prompts for AI agents to fix issues. Reports include file context, line numbers, violation explanation, and remediation guidance.`,
      
      deliverables: `Continuous stream of violation report artifacts, each framed as a complete prompt for an AI agent to fix the issue, including all necessary context from the codebase.`,
      
      jobName: 'venture_spec_verification',
      
      enabledTools: [
        'web_fetch',
        'google_web_search',
        'get_file_contents',
        'search_code',
        'search_repositories',
        'list_commits',
      ],
    });

    console.log('\n✅ Job posted successfully!');
    console.log('📋 Result:', JSON.stringify(result, null, 2));
    console.log('\n📍 Next steps:');
    console.log('1. Monitor mech_worker logs for job pickup');
    console.log('2. Check Jinn Explorer for launcher briefing artifact');
    console.log('3. Verify child jobs are created and executed');
    console.log('4. Wait for auto-repost cycle to trigger next run');
    
  } catch (error) {
    console.error('❌ Error posting job:', error);
    process.exit(1);
  }
}

main();

