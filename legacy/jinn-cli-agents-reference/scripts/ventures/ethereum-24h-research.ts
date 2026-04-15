#!/usr/bin/env tsx
/**
 * Ethereum 24H Research Venture Dispatch Script
 * 
 * Tests Context Management System (Phase 1, 2, 3):
 * - Phase 1: Blueprint-driven execution (structured assertions)
 * - Phase 2: Dependency enforcement (synthesis waits for research tracks)
 * - Phase 3: Progress checkpointing (synthesis sees completed research)
 * 
 * Job Structure:
 * 1. Root: Ethereum 24H Market Analysis (orchestrator)
 * 2-4. Three parallel research tracks (protocol, whale, smart contract)
 * 5. Synthesis job (depends on tracks 1-3, generates trade ideas)
 */

import 'dotenv/config';
import { dispatchNewJob } from 'jinn-node/agent/mcp/tools/dispatch_new_job.js';
import { readFile } from 'fs/promises';
import { join } from 'path';

interface DispatchResult {
  jobDefinitionId: string;
  requestId: string;
  jobName: string;
}

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

async function dispatchRootJob(): Promise<DispatchResult> {
  console.log('\n📋 [1/5] Dispatching Root Job: Ethereum 24H Market Analysis...');
  
  const blueprint = await loadBlueprint('ethereum-research-root.json');
  
  const result = await dispatchNewJob({
    jobName: 'ethereum-24h-market-analysis',
    blueprint,
    model: 'gemini-2.5-flash',
    enabledTools: [
      'dispatch_new_job',
      'get_details',
      'create_artifact',
    ],
    // skipBranch auto-detected: research venture, no CODE_METADATA_REPO_ROOT
  });
  
  const { jobDefinitionId, requestId } = parseDispatchResponse(result);
  
  console.log(`   ✅ Root Job Created`);
  console.log(`      Job Definition ID: ${jobDefinitionId}`);
  console.log(`      Request ID: ${requestId}`);
  
  return { jobDefinitionId, requestId, jobName: 'ethereum-24h-market-analysis' };
}

async function dispatchProtocolAnalysis(): Promise<DispatchResult> {
  console.log('\n📊 [2/5] Dispatching Track 1: Protocol Activity Analysis...');
  
  const blueprint = await loadBlueprint('protocol-activity-analysis.json');
  
  const result = await dispatchNewJob({
    jobName: 'protocol-activity-analysis',
    blueprint,
    model: 'gemini-2.5-flash',
    enabledTools: [
      'web_fetch',
      'web_search',
      'create_artifact',
    ],
    updateExisting: false,
  });
  
  const { jobDefinitionId, requestId } = parseDispatchResponse(result);
  
  console.log(`   ✅ Protocol Analysis Job Created`);
  console.log(`      Job Definition ID: ${jobDefinitionId}`);
  console.log(`      Request ID: ${requestId}`);
  
  return { jobDefinitionId, requestId, jobName: 'protocol-activity-analysis' };
}

async function dispatchWhaleAnalysis(): Promise<DispatchResult> {
  console.log('\n🐋 [3/5] Dispatching Track 2: Whale Wallet Movements...');
  
  const blueprint = await loadBlueprint('whale-movements-analysis.json');
  
  const result = await dispatchNewJob({
    jobName: 'whale-wallet-movements',
    blueprint,
    model: 'gemini-2.5-flash',
    enabledTools: [
      'web_fetch',
      'web_search',
      'create_artifact',
    ],
    updateExisting: false,
  });
  
  const { jobDefinitionId, requestId } = parseDispatchResponse(result);
  
  console.log(`   ✅ Whale Analysis Job Created`);
  console.log(`      Job Definition ID: ${jobDefinitionId}`);
  console.log(`      Request ID: ${requestId}`);
  
  return { jobDefinitionId, requestId, jobName: 'whale-wallet-movements' };
}

async function dispatchSmartContractEvents(): Promise<DispatchResult> {
  console.log('\n🔍 [4/5] Dispatching Track 3: Smart Contract Events...');
  
  const blueprint = await loadBlueprint('smart-contract-events.json');
  
  const result = await dispatchNewJob({
    jobName: 'smart-contract-events',
    blueprint,
    model: 'gemini-2.5-flash',
    enabledTools: [
      'web_fetch',
      'web_search',
      'create_artifact',
    ],
    updateExisting: false,
  });
  
  const { jobDefinitionId, requestId } = parseDispatchResponse(result);
  
  console.log(`   ✅ Smart Contract Events Job Created`);
  console.log(`      Job Definition ID: ${jobDefinitionId}`);
  console.log(`      Request ID: ${requestId}`);
  
  return { jobDefinitionId, requestId, jobName: 'smart-contract-events' };
}

async function dispatchSynthesis(dependencies: string[]): Promise<DispatchResult> {
  console.log('\n🎯 [5/5] Dispatching Track 4: Market Synthesis & Trade Ideas...');
  console.log(`   Dependencies: ${dependencies.length} job definitions`);
  dependencies.forEach((dep, i) => {
    console.log(`      ${i + 1}. ${dep}`);
  });
  
  const blueprint = await loadBlueprint('market-synthesis.json');
  
  const result = await dispatchNewJob({
    jobName: 'market-synthesis-trade-ideas',
    blueprint,
    model: 'gemini-2.5-pro', // Use Pro model for synthesis
    enabledTools: [
      'get_details',
      'web_search',
      'create_artifact',
    ],
    dependencies, // Depends on all 3 research tracks
    updateExisting: false,
  });
  
  const { jobDefinitionId, requestId } = parseDispatchResponse(result);
  
  console.log(`   ✅ Synthesis Job Created (with dependencies)`);
  console.log(`      Job Definition ID: ${jobDefinitionId}`);
  console.log(`      Request ID: ${requestId}`);
  
  return { jobDefinitionId, requestId, jobName: 'market-synthesis-trade-ideas' };
}

async function main() {
  console.log('╔═══════════════════════════════════════════════════════════════════════╗');
  console.log('║  Ethereum 24H Research Venture - Context Management System Test      ║');
  console.log('╚═══════════════════════════════════════════════════════════════════════╝');
  console.log('\nThis venture tests:');
  console.log('  ✓ Phase 1: Blueprint-driven execution');
  console.log('  ✓ Phase 2: Dependency enforcement');
  console.log('  ✓ Phase 3: Progress checkpointing\n');
  console.log('Dispatching 5 jobs: 1 root + 3 research tracks + 1 synthesis...');

  try {
    // Step 1: Dispatch root orchestrator job
    const rootJob = await dispatchRootJob();
    
    // Step 2: Dispatch 3 parallel research tracks (no dependencies)
    const protocolJob = await dispatchProtocolAnalysis();
    const whaleJob = await dispatchWhaleAnalysis();
    const smartContractJob = await dispatchSmartContractEvents();
    
    // Step 3: Dispatch synthesis job with dependencies on all 3 research tracks
    const synthesisJob = await dispatchSynthesis([
      protocolJob.jobDefinitionId,
      whaleJob.jobDefinitionId,
      smartContractJob.jobDefinitionId,
    ]);
    
    // Summary
    console.log('\n╔═══════════════════════════════════════════════════════════════════════╗');
    console.log('║  ✅ All 5 Jobs Dispatched Successfully                                ║');
    console.log('╚═══════════════════════════════════════════════════════════════════════╝');
    console.log('\n📊 Venture Structure:');
    console.log(`\n   Root: ${rootJob.jobName}`);
    console.log(`   └─ Request ID: ${rootJob.requestId}`);
    console.log(`\n   Track 1: ${protocolJob.jobName}`);
    console.log(`   └─ Request ID: ${protocolJob.requestId}`);
    console.log(`\n   Track 2: ${whaleJob.jobName}`);
    console.log(`   └─ Request ID: ${whaleJob.requestId}`);
    console.log(`\n   Track 3: ${smartContractJob.jobName}`);
    console.log(`   └─ Request ID: ${smartContractJob.requestId}`);
    console.log(`\n   Track 4 (Synthesis): ${synthesisJob.jobName}`);
    console.log(`   ├─ Request ID: ${synthesisJob.requestId}`);
    console.log(`   └─ Dependencies: [Track 1, Track 2, Track 3]`);
    
    console.log('\n\n🔧 Next Steps:');
    console.log('\n1. Start worker to process all jobs in the workstream:');
    console.log(`   yarn dev:mech --workstream=${rootJob.requestId}`);
    
    console.log('\n2. Monitor execution:');
    console.log('   - Watch worker logs for blueprint usage');
    console.log('   - Track dependency checking for synthesis job');
    console.log('   - Observe progress checkpointing in Track 4');
    
    console.log('\n3. Validate results:');
    console.log(`   yarn inspect-job-run ${synthesisJob.requestId}`);
    
    console.log('\n4. View in explorer:');
    console.log(`   http://localhost:3000/requests/${synthesisJob.requestId}`);
    
    console.log('\n\n📝 Validation Checklist:');
    console.log('   [ ] Phase 1: No blueprint search attempts in telemetry');
    console.log('   [ ] Phase 2: Synthesis job waits for all 3 research tracks');
    console.log('   [ ] Phase 3: Synthesis job references prior research findings');
    console.log('   [ ] Output: Top 3 Ethereum trade ideas with multi-source rationale');
    
  } catch (error) {
    console.error('\n❌ Failed to dispatch venture:', error);
    if (error instanceof Error) {
      console.error('   Message:', error.message);
      console.error('   Stack:', error.stack);
    }
    process.exit(1);
  }
}

main();

