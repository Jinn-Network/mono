#!/usr/bin/env tsx
import { dispatchNewJob } from 'jinn-node/agent/mcp/tools/dispatch_new_job.js';

const prompt = `# Objective
Continuously verify codebase against venture spec

# Context
# Role: Spec Verification Orchestrator (Test Run v2)

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

My entire operation ladders up to one mandate: **Detect spec-code divergence by orchestrating specialized verification agents, then synthesize findings into actionable guidance.**

# Deliverables
Continuous stream of violation report artifacts, each framed as a complete prompt for an AI agent to fix the issue, including all necessary context from the codebase.

# Acceptance Criteria
Each run produces violation report artifacts that serve as actionable prompts for AI agents to fix issues. Reports include file context, line numbers, violation explanation, and remediation guidance.`;

const enabledTools = [
  'web_fetch',
  'google_web_search',
  'get_file_contents',
  'search_code',
  'search_repositories',
  'list_commits'
];

async function main() {
  console.log('📤 Dispatching NEW spec verification job (fresh job definition)\n');
  
  const result = await dispatchNewJob({
    objective: 'Continuously verify codebase against venture spec - Test Run with Retry Logic',
    context: 'Repository: oaksprout/jinn-gemini. This is a test run to verify IPFS retry logic and reflection on all job outcomes.',
    prompt,
    enabledTools,
    jobName: 'venture_spec_verification_v2_test',
    acceptanceCriteria: 'Each run produces violation report artifacts that serve as actionable prompts for AI agents to fix issues. Reports include file context, line numbers, violation explanation, and remediation guidance.'
  });
  
  console.log('\nFull result:', JSON.stringify(result, null, 2));
  
  const parsed = JSON.parse(result.content[0].text);
  console.log('\nParsed result:', JSON.stringify(parsed, null, 2));
  
  if (parsed.data) {
    const data = parsed.data;
    console.log('\n✅ Job dispatched successfully!');
    console.log(`📋 Request ID: ${data.request_ids[0]}`);
    console.log(`🆔 Job Definition ID: ${data.jobDefinitionId}`);
    console.log(`🔗 Transaction: ${data.transaction_url}`);
    console.log(`\n➡️  Run worker with: MECH_TARGET_REQUEST_ID=${data.request_ids[0]} yarn mech --single`);
  } else {
    console.log('\n⚠️  No data in response');
  }
}

main().catch(console.error);

