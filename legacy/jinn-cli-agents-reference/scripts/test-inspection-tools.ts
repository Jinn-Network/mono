/**
 * Test script for MCP inspection tools via headless Gemini CLI agent.
 *
 * This script spawns a Gemini CLI agent with inspection tools enabled
 * to analyze a specific workstream and verify the tools work correctly.
 *
 * Usage:
 *   tsx scripts/test-inspection-tools.ts [workstream_id]
 */

import { Agent } from 'jinn-node/agent/agent.js';
import dotenv from 'dotenv';
import { join } from 'path';

dotenv.config({ path: join(process.cwd(), '.env') });

const DEFAULT_WORKSTREAM_ID = '0x6eda06028388738e97a6ce0abd68439ce436a8591aaa90b264625436da0a23c4';
const workstreamId = process.argv[2] || DEFAULT_WORKSTREAM_ID;

console.log('=== MCP Inspection Tools Test ===');
console.log(`Workstream: ${workstreamId}`);
console.log('');

const agent = new Agent(
  'gemini-2.5-flash',
  [
    'inspect_workstream',
    'inspect_job',
    'inspect_job_run',
    'get_details',
  ],
  {
    jobId: `test-inspection-${Date.now()}`,
    jobDefinitionId: null,
    jobName: 'test-inspection-tools',
    workstreamId: workstreamId,
    projectRunId: null,
    sourceEventId: null,
    projectDefinitionId: null,
  },
  null,
  { isCodingJob: false }
);

const prompt = `
You have access to MCP inspection tools. Use them to analyze workstream ${workstreamId}.

STEP 1: Call inspect_workstream with:
- workstream_id: "${workstreamId}"
- sections: ["errors", "timing", "tools"]
- limit: 20

STEP 2: Based on the results, if there are any failed jobs or interesting patterns, use inspect_job_run on 1-2 specific request IDs to get more details.

STEP 3: Provide a summary including:
1. Total jobs and their status (completed/pending/failed)
2. Any errors encountered (with request IDs)
3. Tool usage patterns
4. Timing metrics (execution duration)

Format your response clearly with sections for each finding.
`;

async function main() {
  console.log('Starting agent...\n');

  try {
    const result = await agent.run(prompt);

    console.log('='.repeat(60));
    console.log('AGENT OUTPUT');
    console.log('='.repeat(60));
    console.log(result.output);
    console.log('');

    console.log('='.repeat(60));
    console.log('TELEMETRY SUMMARY');
    console.log('='.repeat(60));
    console.log(`Tool calls: ${result.telemetry.toolCalls.length}`);
    console.log(`Total tokens: ${result.telemetry.totalTokens}`);
    console.log(`Duration: ${result.telemetry.duration}ms`);
    console.log('');

    if (result.telemetry.toolCalls.length > 0) {
      console.log('Tool Call Details:');
      for (const call of result.telemetry.toolCalls) {
        const status = call.success ? '✓' : '✗';
        const duration = call.duration_ms ? ` (${call.duration_ms}ms)` : '';
        console.log(`  ${status} ${call.tool}${duration}`);
        if (!call.success && call.error) {
          console.log(`    Error: ${call.error}`);
        }
      }
    }

    if (result.structuredSummary) {
      console.log('\nStructured Summary:');
      console.log(result.structuredSummary);
    }

    process.exit(0);
  } catch (err: any) {
    console.error('='.repeat(60));
    console.error('ERROR');
    console.error('='.repeat(60));

    const error = err.error || err;
    const telemetry = err.telemetry;

    console.error('Error:', error.message || String(error));

    if (telemetry) {
      console.error('\nPartial Telemetry:');
      console.error(`  Tool calls: ${telemetry.toolCalls?.length || 0}`);
      console.error(`  Duration: ${telemetry.duration}ms`);
      if (telemetry.raw?.partialOutput) {
        console.error('\nPartial Output:');
        console.error(telemetry.raw.partialOutput);
      }
    }

    process.exit(1);
  }
}

main();
