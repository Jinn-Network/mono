#!/usr/bin/env tsx
/**
 * Ethereum Protocol Research - Entry Point
 * 
 * Single entry point for Ethereum protocol research venture:
 * - Phase 1: Blueprint-driven execution (structured assertions)
 * - Phase 2: Agent autonomously decides execution strategy (direct work vs delegation)
 * - Phase 3: Recognition phase (learns from similar past research)
 * 
 * The agent receives a blueprint defining success criteria:
 * - Data sourcing requirements
 * - Analysis methodology
 * - Output specifications
 * - Trade idea generation
 * 
 * The agent may choose to:
 * - Execute all work directly
 * - Delegate to specialized child jobs
 * - Hybrid approach based on task complexity
 */

import 'dotenv/config';
import { dispatchNewJob } from 'jinn-node/agent/mcp/tools/dispatch_new_job.js';
import { readFile } from 'fs/promises';
import { join } from 'path';

async function loadBlueprint(filename: string): Promise<string> {
  const blueprintPath = join(process.cwd(), 'blueprints', filename);
  const content = await readFile(blueprintPath, 'utf-8');
  return content;
}

function parseDispatchResponse(result: any): { jobDefinitionId: string; requestId: string } {
  const response = JSON.parse(result.content[0].text);
  
  if (!response.meta?.ok) {
    throw new Error(`Dispatch failed: ${response.meta?.message}`);
  }
  
  const data = response.data;
  const requestId = Array.isArray(data.request_ids) ? data.request_ids[0] : data.request_id;
  const jobDefinitionId = data.jobDefinitionId;
  
  if (!jobDefinitionId) {
    throw new Error('No jobDefinitionId in response');
  }
  
  return { jobDefinitionId, requestId };
}

async function main() {
  console.log('╔═══════════════════════════════════════════════════════════════════════╗');
  console.log('║  Ethereum On-chain Activity Research - Entry Point                   ║');
  console.log('╚═══════════════════════════════════════════════════════════════════════╝');
  console.log('\nThis venture tests:');
  console.log('  ✓ Phase 1: Blueprint-driven execution');
  console.log('  ✓ Phase 2: Autonomous work decomposition (agent decides delegation)');
  console.log('  ✓ Phase 3: Recognition learning from past executions');
  console.log('\nDispatching entry point job...\n');

  try {
    // Target date for analysis (use yesterday by default to ensure data availability)
    const targetDate = new Date();
    targetDate.setUTCDate(targetDate.getUTCDate() - 1);
    targetDate.setUTCHours(0, 0, 0, 0);
    
    const endDate = new Date(targetDate);
    endDate.setUTCDate(endDate.getUTCDate() + 1);
    
    const dateStr = targetDate.toISOString().split('T')[0]; // YYYY-MM-DD
    const shortId = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel'][Math.floor(Math.random() * 8)];
    const jobName = `Ethereum On-chain Activity – ${dateStr} – ${shortId}`;
    
    const blueprint = await loadBlueprint('ethereum-protocol-research.json');
    
    console.log('📊 Dispatching: Ethereum On-chain Activity Research\n');
    console.log(`   Job Name: ${jobName}`);
    console.log(`   Scope: ${targetDate.toISOString()} → ${endDate.toISOString()}`);
    console.log('   Focus: Major DeFi protocols (Uniswap, Aave, Lido, Maker, Curve)');
    console.log('   Output: Structured Daily Report (Markdown Artifact)\n');
    
    // Inject the specific date scope into the blueprint with EXPLICIT emphasis
    const dateScope = [
      `CRITICAL DATE CONSTRAINT: You are researching the 24-hour period from ${targetDate.toISOString()} to ${endDate.toISOString()}.`,
      `This is ${dateStr} in YYYY-MM-DD format.`,
      `DO NOT use "today" or "current date" - the analysis target is ${dateStr}, which may be in the past.`,
      `When performing web searches, explicitly include "${dateStr}" in your queries.`,
      `All metrics, events, and data MUST be from this specific date window only.`
    ].join(' ');
    
    // Parse blueprint JSON, add context field, re-serialize
    const blueprintObj = JSON.parse(blueprint);
    blueprintObj.context = dateScope;
    const finalBlueprint = JSON.stringify(blueprintObj);

    const result = await dispatchNewJob({
      jobName,
      blueprint: finalBlueprint,
      model: 'gemini-2.5-flash',
      enabledTools: [
        'web_search',
        'create_artifact',
        'write_file',
        'read_file',
        'replace',
        'list_directory',
        'run_shell_command',
      ],
      // skipBranch auto-detected: no CODE_METADATA_REPO_ROOT = artifact-only mode
    });
    
    const { jobDefinitionId, requestId } = parseDispatchResponse(result);
    
    console.log('✅ Research job dispatched successfully!\n');
    console.log('═══════════════════════════════════════════════════════════════════════');
    console.log(`\n📋 ${jobName}`);
    console.log(`   Target Date: ${dateStr}`);
    console.log(`   Request ID: ${requestId}\n`);
    
    console.log('🔧 Run workstream (processes 15 jobs):');
    console.log(`   yarn dev:mech --workstream=${requestId} --runs=15\n`);
    
    console.log('🌐 View in explorer:');
    console.log(`   https://explorer.jinn.network/workstreams/${requestId}\n`);
    
  } catch (error) {
    console.error('\n❌ Failed to dispatch job:', error);
    if (error instanceof Error) {
      console.error('   Message:', error.message);
      console.error('   Stack:', error.stack);
    }
    process.exit(1);
  }
}

main();

