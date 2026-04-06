#!/usr/bin/env tsx
import '../env/index.js';
import { dispatchNewJob } from 'jinn-node/agent/mcp/tools/dispatch_new_job.js';

async function main() {
  console.log('Dispatching specification and documentation improver job...\n');

  const jobSpec = {
    objective: 'Analyze the codebase to fully document the current implementation of "job runs" in docs/spec/blueprint/documentation.md and specify its ideal state in docs/spec/blueprint/specification.md. The job is complete when no further meaningful additions can be made.',
    context: `You are analyzing the oaksprout/jinn-gemini repository on GitHub (branch: oak/jinn-237-memory-system-observability-and-benchmarking).

Use GitHub tools to access files:
- get_file_contents(owner: "oaksprout", repo: "jinn-gemini", path: "...", ref: "oak/jinn-237-memory-system-observability-and-benchmarking")
- search_code(query: "...", owner: "oaksprout", repo: "jinn-gemini")

Blueprint Location: docs/spec/blueprint/
- index.md: Blueprint hierarchy and structure
- requirements.md: High-level requirements that the specification must adhere to
- specification.md: How job runs SHOULD work (ideal state) - TO BE FLESHED OUT
- documentation.md: How job runs CURRENTLY work (actual implementation) - TO BE FLESHED OUT

Focus Area: "Job Runs"
- How a job execution works from start to finish
- Worker polling, claiming, executing, delivering
- Agent lifecycle, MCP tool usage, telemetry collection
- Memory system integration (recognition, reflection, situation encoding)
- On-chain delivery and artifact indexing

Your Approach:
1. Use get_file_contents to read docs/spec/blueprint/requirements.md
2. Use get_file_contents to read docs/spec/blueprint/index.md, specification.md, and documentation.md
3. Use search_code to find implementations related to "job run", "worker loop", "agent execution"
4. Use get_file_contents to read the implementation files you discover:
   - worker/mech_worker.ts (main worker loop)
   - gemini-agent/agent.ts (agent execution)
   - worker/situation_encoder.ts (memory encoding)
   - ponder/src/index.ts (event indexing)
5. Identify gaps between what the code does and what's documented
6. Create SUGGESTION artifacts with markdown content to fill these gaps

IMPORTANT: Always include owner: "oaksprout", repo: "jinn-gemini", ref: "oak/jinn-237-memory-system-observability-and-benchmarking" in get_file_contents calls.

Goal: Exhaustively document and specify everything about job runs until complete.`,
    acceptanceCriteria: `The job is successful when:

1. specification.md clearly describes how job runs SHOULD work (ideal state), including:
   - Efficient search for relevant past activity
   - Synthesis of learnings to boost performance
   - Execution of the job
   - Successful on-chain delivery meeting request demands
   - Generation of sufficient data for future network activity

2. documentation.md clearly describes how job runs CURRENTLY work (actual implementation), including:
   - Worker polling and claiming mechanism
   - Agent spawning and execution flow
   - MCP tool interactions
   - Telemetry collection process
   - Memory system integration (recognition/reflection)
   - Artifact creation and delivery
   - On-chain transaction flow

3. Both documents are comprehensive enough for a new developer to understand the complete job run lifecycle

4. All suggestions are delivered as artifacts with topic "SUGGESTION" and clear labels

5. No duplicate suggestions - use search_similar_situations to check before creating

6. The job completes when no further meaningful documentation gaps exist`,
    jobName: 'Specification and Documentation Improver - Job Runs',
    model: 'gemini-2.5-pro',
    enabledTools: [
      'get_file_contents',
      'search_code', 
      'create_artifact',
      'search_similar_situations',
      'get_details'
    ],
    deliverables: 'SUGGESTION artifacts containing markdown content for specification.md and documentation.md, focused on job runs.',
    constraints: `- ONLY focus on "job runs" - do not document other aspects of the system
- Ensure specifications are cognizant of the requirements.md constraints (especially the three levels of observability and EROI principles)
- Read the actual code implementation, don't just rely on existing documentation
- Create SUGGESTION artifacts with markdown content for specification.md and documentation.md
- Use search_similar_situations to avoid creating duplicate suggestions
- The specification.md should describe the ideal state (how it SHOULD work)
- The documentation.md should describe the current implementation (how it CURRENTLY works)
- Stop when no further meaningful additions can be identified`
  };

  try {
    const result = await dispatchNewJob(jobSpec);
    
    console.log('\n✅ Job dispatched successfully!');
    console.log('\nResult:', JSON.stringify(result, null, 2));
    
    // Parse the response to extract request ID
    const parsed = JSON.parse(result.content[0].text);
    if (parsed.data?.request_ids && parsed.data.request_ids.length > 0) {
      const requestId = parsed.data.request_ids[0];
      console.log(`\n🔗 Request ID: ${requestId}`);
      console.log(`🔗 View in explorer: http://localhost:3000/requests/${requestId}`);
      if (parsed.data.tx_hash) {
        console.log(`🔗 View on BaseScan: https://basescan.org/tx/${parsed.data.tx_hash}`);
      }
      if (parsed.data.ipfs_gateway_url) {
        console.log(`🔗 IPFS Gateway: ${parsed.data.ipfs_gateway_url}`);
      }
    }
  } catch (error: any) {
    console.error('\n❌ Failed to dispatch job:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

main();

