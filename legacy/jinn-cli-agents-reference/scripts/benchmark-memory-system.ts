#!/usr/bin/env ts-node
// @ts-nocheck
/**
 * Memory System Benchmarking Suite
 * 
 * This script benchmarks the Phase 1 Memory Management system by comparing
 * agent performance with and without memory injection.
 * 
 * Usage:
 *   yarn ts-node scripts/benchmark-memory-system.ts --baseline
 *   yarn ts-node scripts/benchmark-memory-system.ts --with-memory
 */

import '../env/index.js';
import { Agent } from 'jinn-node/agent/agent.js';
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';

interface BenchmarkJob {
  name: string;
  prompt: string;
  enabledTools: string[];
  expectedOutcome?: string;
}

interface BenchmarkResult {
  jobName: string;
  iteration: number;
  success: boolean;
  durationMs: number;
  totalTokens: number;
  toolCalls: number;
  toolErrors: number;
  output: string;
  error?: string;
}

interface BenchmarkReport {
  mode: 'baseline' | 'with-memory';
  timestamp: string;
  results: BenchmarkResult[];
  summary: {
    totalJobs: number;
    totalIterations: number;
    successRate: number;
    avgDurationMs: number;
    avgTokens: number;
    avgToolCalls: number;
    avgToolErrors: number;
  };
}

// Define test jobs covering various scenarios
const TEST_JOBS: BenchmarkJob[] = [
  {
    name: 'Simple Data Fetch',
    prompt: 'Fetch the current OLAS token price from CoinGecko API',
    enabledTools: [],
    expectedOutcome: 'Returns current price data',
  },
  {
    name: 'Multi-Step Research',
    prompt: 'Research the top 3 staking contracts deployed on Base chain and compare their APYs. Create an artifact with your findings.',
    enabledTools: ['create_artifact', 'search_code'],
    expectedOutcome: 'Artifact with staking contract comparison',
  },
  {
    name: 'Error-Prone RPC Task',
    prompt: 'Query the Ethereum mainnet for the latest 10 blocks and extract transaction counts. Handle rate limiting gracefully.',
    enabledTools: [],
    expectedOutcome: 'Transaction counts for 10 blocks',
  },
  {
    name: 'Code Generation',
    prompt: 'Generate a TypeScript function that calculates compound interest with proper type annotations and error handling.',
    enabledTools: ['create_artifact'],
    expectedOutcome: 'TypeScript code artifact',
  },
  {
    name: 'Job Decomposition',
    prompt: 'Break down the task "Deploy a staking contract to Base testnet" into 3-5 subtasks using dispatch_new_job for each.',
    enabledTools: ['dispatch_new_job'],
    expectedOutcome: 'Multiple child jobs created',
  },
];

const ITERATIONS_PER_JOB = 10;
const RESULTS_DIR = join(process.cwd(), 'benchmark-results');

async function runBenchmarkJob(job: BenchmarkJob, iteration: number): Promise<BenchmarkResult> {
  const startTime = Date.now();
  
  try {
    const agent = new Agent(
      'gemini-2.5-flash',
      job.enabledTools,
      {
        jobId: `benchmark-${job.name}-${iteration}`,
        jobDefinitionId: null,
        jobName: job.name,
        projectRunId: null,
        sourceEventId: null,
        projectDefinitionId: null,
      }
    );

    const result = await agent.run(job.prompt);
    const durationMs = Date.now() - startTime;

    const telemetry = result.telemetry || {};
    const toolCalls = Array.isArray(telemetry.toolCalls) ? telemetry.toolCalls.length : 0;
    const toolErrors = Array.isArray(telemetry.toolCalls) 
      ? telemetry.toolCalls.filter((tc: any) => !tc.success).length 
      : 0;

    return {
      jobName: job.name,
      iteration,
      success: true,
      durationMs,
      totalTokens: telemetry.totalTokens || 0,
      toolCalls,
      toolErrors,
      output: result.output.substring(0, 200),
    };
  } catch (error: any) {
    const durationMs = Date.now() - startTime;
    return {
      jobName: job.name,
      iteration,
      success: false,
      durationMs,
      totalTokens: 0,
      toolCalls: 0,
      toolErrors: 1,
      output: '',
      error: error.message || String(error),
    };
  }
}

async function runBenchmark(mode: 'baseline' | 'with-memory'): Promise<BenchmarkReport> {
  console.log(`\n🚀 Running benchmark in ${mode.toUpperCase()} mode...\n`);
  
  const results: BenchmarkResult[] = [];
  
  for (const job of TEST_JOBS) {
    console.log(`📋 Testing: ${job.name}`);
    
    for (let i = 1; i <= ITERATIONS_PER_JOB; i++) {
      process.stdout.write(`  Iteration ${i}/${ITERATIONS_PER_JOB}... `);
      
      const result = await runBenchmarkJob(job, i);
      results.push(result);
      
      console.log(result.success ? '✅' : '❌');
      
      // Small delay to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    
    console.log('');
  }
  
  // Calculate summary statistics
  const successfulResults = results.filter(r => r.success);
  const successRate = (successfulResults.length / results.length) * 100;
  const avgDurationMs = successfulResults.reduce((sum, r) => sum + r.durationMs, 0) / successfulResults.length;
  const avgTokens = successfulResults.reduce((sum, r) => sum + r.totalTokens, 0) / successfulResults.length;
  const avgToolCalls = successfulResults.reduce((sum, r) => sum + r.toolCalls, 0) / successfulResults.length;
  const avgToolErrors = results.reduce((sum, r) => sum + r.toolErrors, 0) / results.length;
  
  return {
    mode,
    timestamp: new Date().toISOString(),
    results,
    summary: {
      totalJobs: TEST_JOBS.length,
      totalIterations: results.length,
      successRate,
      avgDurationMs,
      avgTokens,
      avgToolCalls,
      avgToolErrors,
    },
  };
}

function saveReport(report: BenchmarkReport): string {
  const filename = `benchmark-${report.mode}-${Date.now()}.json`;
  const filepath = join(RESULTS_DIR, filename);
  
  // Ensure results directory exists
  if (!existsSync(RESULTS_DIR)) {
    mkdirSync(RESULTS_DIR, { recursive: true });
  }
  
  writeFileSync(filepath, JSON.stringify(report, null, 2));
  console.log(`\n💾 Results saved to: ${filepath}`);
  
  return filepath;
}

function printSummary(report: BenchmarkReport) {
  console.log(`\n📊 ${report.mode.toUpperCase()} BENCHMARK SUMMARY`);
  console.log('='.repeat(50));
  console.log(`Total Jobs: ${report.summary.totalJobs}`);
  console.log(`Total Iterations: ${report.summary.totalIterations}`);
  console.log(`Success Rate: ${report.summary.successRate.toFixed(2)}%`);
  console.log(`Avg Duration: ${report.summary.avgDurationMs.toFixed(0)}ms`);
  console.log(`Avg Tokens: ${report.summary.avgTokens.toFixed(0)}`);
  console.log(`Avg Tool Calls: ${report.summary.avgToolCalls.toFixed(2)}`);
  console.log(`Avg Tool Errors: ${report.summary.avgToolErrors.toFixed(2)}`);
  console.log('='.repeat(50));
}

function compareReports(baselinePath: string, memoryPath: string) {
  const baseline: BenchmarkReport = JSON.parse(readFileSync(baselinePath, 'utf-8'));
  const memory: BenchmarkReport = JSON.parse(readFileSync(memoryPath, 'utf-8'));
  
  console.log(`\n📈 COMPARISON: BASELINE vs WITH-MEMORY`);
  console.log('='.repeat(50));
  
  const successRateDiff = memory.summary.successRate - baseline.summary.successRate;
  const durationDiff = ((memory.summary.avgDurationMs - baseline.summary.avgDurationMs) / baseline.summary.avgDurationMs) * 100;
  const tokenDiff = ((memory.summary.avgTokens - baseline.summary.avgTokens) / baseline.summary.avgTokens) * 100;
  const toolCallsDiff = memory.summary.avgToolCalls - baseline.summary.avgToolCalls;
  const toolErrorsDiff = memory.summary.avgToolErrors - baseline.summary.avgToolErrors;
  
  console.log(`Success Rate: ${successRateDiff > 0 ? '+' : ''}${successRateDiff.toFixed(2)}%`);
  console.log(`Avg Duration: ${durationDiff > 0 ? '+' : ''}${durationDiff.toFixed(2)}%`);
  console.log(`Avg Tokens: ${tokenDiff > 0 ? '+' : ''}${tokenDiff.toFixed(2)}%`);
  console.log(`Avg Tool Calls: ${toolCallsDiff > 0 ? '+' : ''}${toolCallsDiff.toFixed(2)}`);
  console.log(`Avg Tool Errors: ${toolErrorsDiff > 0 ? '+' : ''}${toolErrorsDiff.toFixed(2)}`);
  console.log('='.repeat(50));
  
  // Verdict
  console.log('\n🎯 VERDICT:');
  if (successRateDiff > 5 || tokenDiff < -10 || toolErrorsDiff < -0.5) {
    console.log('✅ Memory system shows SIGNIFICANT IMPROVEMENT');
  } else if (successRateDiff > 0 || tokenDiff < 0 || toolErrorsDiff < 0) {
    console.log('🟡 Memory system shows MARGINAL IMPROVEMENT');
  } else {
    console.log('❌ Memory system shows NO IMPROVEMENT or REGRESSION');
  }
}

async function main() {
  const args = process.argv.slice(2);
  
  if (args.includes('--baseline')) {
    // Run baseline benchmark (memory system disabled)
    process.env.DISABLE_MEMORY_INJECTION = 'true';
    const report = await runBenchmark('baseline');
    printSummary(report);
    saveReport(report);
  } else if (args.includes('--with-memory')) {
    // Run with memory system enabled
    process.env.DISABLE_MEMORY_INJECTION = 'false';
    const report = await runBenchmark('with-memory');
    printSummary(report);
    saveReport(report);
  } else if (args.includes('--compare')) {
    // Compare existing reports
    const baselineFile = args[args.indexOf('--compare') + 1];
    const memoryFile = args[args.indexOf('--compare') + 2];
    
    if (!baselineFile || !memoryFile) {
      console.error('Usage: --compare <baseline-file> <memory-file>');
      process.exit(1);
    }
    
    compareReports(baselineFile, memoryFile);
  } else {
    console.log(`
Memory System Benchmarking Suite

Usage:
  yarn ts-node scripts/benchmark-memory-system.ts --baseline
    Run baseline benchmark (memory system disabled)
  
  yarn ts-node scripts/benchmark-memory-system.ts --with-memory
    Run benchmark with memory system enabled
  
  yarn ts-node scripts/benchmark-memory-system.ts --compare <baseline-file> <memory-file>
    Compare two benchmark reports

Workflow:
  1. Run baseline first to establish performance metrics
  2. Run with-memory to test the memory system
  3. Compare the results to quantify improvements
`);
    process.exit(0);
  }
}

main().catch(error => {
  console.error('Benchmark failed:', error);
  process.exit(1);
});

