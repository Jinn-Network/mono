#!/usr/bin/env tsx
import '../env/index.js';
import { dispatchNewJob } from 'jinn-node/agent/mcp/tools/dispatch_new_job.js';

async function main() {
  console.log('Dispatching code spec verification job...\n');

  const jobSpec = {
    objective: 'Continuously verify main branch of the codebase against venture code-spec.',
    context: 'Repository: oaksprout/jinn-gemini. Find the code spec in docs/code-spec.',
    acceptanceCriteria: 'This workstream – i.e. children downstream of this job – should produce a steady flow of significant codebase violations. Do not duplicate any violations which have been discovered previously. Reports include file context, line numbers, violation explanation, and remediation guidance.',
    jobName: 'Code Spec Verifier for oaksprout/jinn-gemini',
    model: 'gemini-2.5-flash',
    enabledTools: ['get_file_contents', 'create_artifact'],
    deliverables: 'Violation reports as JSON artifacts with file paths, line numbers, explanations, and remediation guidance.',
    constraints: 'Focus on significant violations only. Skip duplicate violations that have been reported before.'
  };

  try {
    const result = await dispatchNewJob(jobSpec);
    
    console.log('\n✅ Job dispatched successfully!');
    console.log('\nResult:', JSON.stringify(result, null, 2));
    
    // Parse the response to extract request ID
    const parsed = JSON.parse(result.content[0].text);
    if (parsed.data?.requestId) {
      console.log(`\n🔗 View in explorer: http://localhost:3000/requests/${parsed.data.requestId}`);
      console.log(`🔗 View on BaseScan: https://basescan.org/tx/${parsed.data.tx_hash}`);
    }
  } catch (error: any) {
    console.error('\n❌ Failed to dispatch job:', error.message);
    process.exit(1);
  }
}

main();
