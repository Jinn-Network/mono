#!/usr/bin/env tsx
/**
 * Dispatch corrected spec-violation-analyzer job with GitHub tools enabled
 */

import { dispatchNewJob } from 'jinn-node/agent/mcp/tools/dispatch_new_job.js';

async function main() {
  console.log('Dispatching corrected spec-violation-analyzer job...\n');

  const result = await dispatchNewJob({
    jobName: 'spec-violation-analyzer-v2',
    objective: 'Continuously verify the codebase against the provided code specification and report significant violations.',
    context: `This job verifies the 'oaksprout/jinn-gemini' codebase on the 'main' branch against the consolidated code specification. The code specification is provided in the 'consolidated-code-specification' artifact (CID: bafkreigoyhaewn5qyno73ku54ywmr7tzke4pzi5cprsbxyh4uqkflv3l6i).`,
    deliverables: 'Violation reports as JSON artifacts with file paths, line numbers, explanations, and remediation guidance.',
    acceptanceCriteria: 'Produce JSON artifacts with file paths, line numbers, explanations, and remediation guidance for significant codebase violations. Avoid duplicating previously discovered violations. Each report must include file context, line numbers, violation explanation, and remediation guidance.',
    constraints: 'Focus on significant violations only. Skip duplicate violations that have been reported before.',
    model: 'gemini-2.5-flash',
    enabledTools: [
      'github_get_file_contents',
      'github_search_code', 
      'github_list_commits',
      'google_web_search',
      'web_fetch',
      'create_artifact',
      'search_artifacts',
      'get_details'
    ],
  });

  if (result.content && result.content[0] && result.content[0].type === 'text') {
    const parsed = JSON.parse(result.content[0].text);
    console.log('\n✅ Job dispatched successfully!');
    console.log(JSON.stringify(parsed, null, 2));
    
    if (parsed.data?.request_ids && parsed.data.request_ids.length > 0) {
      const requestId = parsed.data.request_ids[0];
      console.log(`\n📋 Request ID: ${requestId}`);
      console.log(`\n🚀 Run with:`);
      console.log(`   MECH_TARGET_REQUEST_ID=${requestId} yarn mech --single`);
    }
  }
}

main().catch((error) => {
  console.error('Error:', error);
  process.exit(1);
});

