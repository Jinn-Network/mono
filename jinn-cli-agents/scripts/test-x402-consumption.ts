#!/usr/bin/env tsx
/**
 * x402 Gateway Consumption Test
 *
 * Tests the full x402 gateway flow:
 *   1. Discover agents (GET /templates)
 *   2. Get agent details (GET /templates/:id)
 *   3. Execute agent (POST /templates/:id/execute) — with x402 payment signing
 *   4. Poll status (GET /runs/:requestId/status)
 *   5. Fetch result (GET /runs/:requestId/result)
 *
 * Usage:
 *   tsx scripts/test-x402-consumption.ts                          # List agents only
 *   tsx scripts/test-x402-consumption.ts --templateSlug <slug>    # Execute specific agent (with payment)
 *   tsx scripts/test-x402-consumption.ts --requestId <id>         # Poll existing run
 *   tsx scripts/test-x402-consumption.ts --all                    # Test all endpoints
 *
 * Options:
 *   --gateway <url>       Gateway URL (default: production)
 *   --templateSlug <slug> Execute a specific template by slug/name match
 *   --requestId <id>      Poll an existing request (skip execution)
 *   --all                 Run full discovery + execution test
 *   --dry-run             Show what would be executed without dispatching
 *   --no-pay              Skip x402 payment (will get 402 if gateway requires payment)
 *   --timeout <ms>        Max poll time in ms (default: 600000 = 10 min)
 *   --poll-interval <ms>  Status poll interval (default: 15000 = 15 sec)
 *
 * Environment:
 *   PRIVATE_KEY           Hex private key for x402 payment signing (must hold USDC on Base)
 */

import 'dotenv/config';
import { createWalletClient, createPublicClient, http, formatUnits } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';
import { wrapFetchWithPayment } from 'x402-fetch';

// ============================================================================
// Config
// ============================================================================

const DEFAULT_GATEWAY = 'https://x402-gateway-production-1b84.up.railway.app';
const DEFAULT_TIMEOUT_MS = 600_000;
const DEFAULT_POLL_INTERVAL_MS = 15_000;

// USDC on Base mainnet
const USDC_ADDRESS = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as const;
const USDC_DECIMALS = 6;
const ERC20_ABI = [
  {
    name: 'balanceOf',
    type: 'function',
    stateMutability: 'view' as const,
    inputs: [{ name: 'account', type: 'address' as const }],
    outputs: [{ name: '', type: 'uint256' as const }],
  },
] as const;

// ============================================================================
// CLI Arg Parsing
// ============================================================================

interface Args {
  gateway: string;
  templateSlug?: string;
  requestId?: string;
  all: boolean;
  dryRun: boolean;
  noPay: boolean;
  timeoutMs: number;
  pollIntervalMs: number;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const args: Args = {
    gateway: DEFAULT_GATEWAY,
    all: false,
    dryRun: false,
    noPay: false,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
  };

  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--gateway':
        args.gateway = argv[++i];
        break;
      case '--templateSlug':
        args.templateSlug = argv[++i];
        break;
      case '--requestId':
        args.requestId = argv[++i];
        break;
      case '--all':
        args.all = true;
        break;
      case '--dry-run':
        args.dryRun = true;
        break;
      case '--no-pay':
        args.noPay = true;
        break;
      case '--timeout':
        args.timeoutMs = parseInt(argv[++i], 10);
        break;
      case '--poll-interval':
        args.pollIntervalMs = parseInt(argv[++i], 10);
        break;
    }
  }

  return args;
}

// ============================================================================
// Gateway Client
// ============================================================================

async function fetchJson<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options?.headers,
    },
  });

  // Handle 402 Payment Required
  if (res.status === 402) {
    const body = await res.text();
    throw new Error(`402 Payment Required — x402 payment needed.\n  Response: ${body.slice(0, 500)}`);
  }

  if (!res.ok && res.status !== 202) {
    const body = await res.text();
    throw new Error(`HTTP ${res.status}: ${body.slice(0, 500)}`);
  }

  return res.json() as Promise<T>;
}

interface Agent {
  templateId: string;
  name: string;
  description: string;
  tags: string[];
  price: string;
  priceWei: string;
  outputSpecSummary: string;
  runCount: number;
  successCount: number;
}

interface AgentDetail extends Agent {
  inputSchema: Record<string, any>;
  outputSpec: Record<string, any>;
  enabledTools: string[];
  blueprint: string;
  status: string;
}

interface ExecuteResult {
  requestId: string;
  jobDefinitionId: string;
  templateId: string;
  statusUrl: string;
  resultUrl: string;
  explorerUrl: string;
}

interface StatusResult {
  requestId: string;
  status: 'not_found' | 'in_progress' | 'completed';
  jobName?: string;
  createdAt?: string;
}

interface RunResult {
  status: 'completed' | 'in_progress' | 'error' | 'not_found';
  result?: any;
  error?: string;
}

// ============================================================================
// Test Steps
// ============================================================================

async function testDiscovery(gateway: string): Promise<Agent[]> {
  console.log('\n--- Step 1: Discover Agents ---');
  console.log(`  GET ${gateway}/templates`);

  const data = await fetchJson<{ templates: Agent[]; source: string }>(`${gateway}/templates`);

  console.log(`  Source: ${data.source}`);
  console.log(`  Found ${data.templates.length} templates:\n`);

  for (const agent of data.templates) {
    const successRate = agent.runCount > 0
      ? `${((agent.successCount / agent.runCount) * 100).toFixed(0)}%`
      : 'n/a';
    console.log(`    ${agent.name}`);
    console.log(`      ID: ${agent.templateId}`);
    console.log(`      Price: ${agent.price} | Runs: ${agent.runCount} | Success: ${successRate}`);
    console.log(`      Tags: ${agent.tags?.join(', ') || 'none'}`);
    console.log('');
  }

  return data.templates;
}

async function testWellKnown(gateway: string): Promise<void> {
  console.log('\n--- Step 1b: x402 Discovery Manifest ---');
  console.log(`  GET ${gateway}/.well-known/x402`);

  const manifest = await fetchJson<any>(`${gateway}/.well-known/x402`);

  console.log(`  Total items: ${manifest.pagination?.total ?? manifest.items?.length ?? '?'}`);

  if (manifest.items?.[0]) {
    const first = manifest.items[0];
    console.log(`  First item: ${first.name || first.description || 'unnamed'}`);
    console.log(`  payTo: ${first.payTo || first.accepts?.payTo || 'not set'}`);
  }

  // Check if payTo is the Venture Safe
  const payToCheck = JSON.stringify(manifest);
  if (payToCheck.includes('0x900Db2954a6c14C011dBeBE474e3397e58AE5421')) {
    console.log('  ✓ payTo is Venture Safe');
  } else if (payToCheck.includes('0x0000000000000000000000000000000000000000')) {
    console.log('  ✗ payTo is zero address — PAYMENT_WALLET_ADDRESS not set');
  } else {
    console.log('  ? payTo address not recognized');
  }
}

async function testAgentDetail(gateway: string, templateId: string): Promise<AgentDetail> {
  console.log('\n--- Step 2: Agent Detail ---');
  console.log(`  GET ${gateway}/templates/${templateId}`);

  const detail = await fetchJson<AgentDetail>(`${gateway}/templates/${templateId}`);

  console.log(`  Name: ${detail.name}`);
  console.log(`  Status: ${detail.status}`);
  console.log(`  Price: ${detail.price}`);
  console.log(`  Tools: ${detail.enabledTools?.length || 0}`);

  if (detail.inputSchema?.properties) {
    const props = Object.keys(detail.inputSchema.properties);
    const required = detail.inputSchema.required || [];
    console.log(`  Input fields: ${props.join(', ')}`);
    console.log(`  Required: ${required.join(', ') || 'none'}`);
  }

  return detail;
}

function buildMinimalInput(inputSchema: Record<string, any>): Record<string, any> {
  const input: Record<string, any> = {};
  const props = inputSchema?.properties || {};
  const required = inputSchema?.required || [];

  for (const [field, spec] of Object.entries(props)) {
    const fieldSpec = spec as any;

    // Fill required fields with defaults or minimal values
    if (required.includes(field) || fieldSpec.default !== undefined) {
      if (fieldSpec.default !== undefined) {
        input[field] = fieldSpec.default;
      } else if (fieldSpec.type === 'string') {
        input[field] = fieldSpec.examples?.[0] || `test-${field}`;
      } else if (fieldSpec.type === 'number' || fieldSpec.type === 'integer') {
        input[field] = fieldSpec.minimum || 1;
      } else if (fieldSpec.type === 'boolean') {
        input[field] = false;
      } else if (fieldSpec.type === 'array') {
        input[field] = [];
      } else if (fieldSpec.type === 'object') {
        input[field] = {};
      }
    }
  }

  return input;
}

async function testExecute(
  gateway: string,
  templateId: string,
  input: Record<string, any>,
  dryRun: boolean,
  payFetch?: typeof fetch,
): Promise<ExecuteResult | null> {
  console.log('\n--- Step 3: Execute Agent ---');
  console.log(`  POST ${gateway}/templates/${templateId}/execute`);
  console.log(`  Input: ${JSON.stringify(input, null, 2)}`);
  console.log(`  Payment: ${payFetch ? 'x402 signed' : 'none (use PRIVATE_KEY to enable)'}`);

  if (dryRun) {
    console.log('  [DRY-RUN] Skipping execution');
    return null;
  }

  const url = `${gateway}/templates/${templateId}/execute`;
  const body = JSON.stringify({ input, cyclic: false });

  if (payFetch) {
    // Use x402 payment-wrapped fetch — handles 402 challenge/response automatically
    const res = await payFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });

    if (!res.ok && res.status !== 202) {
      const errBody = await res.text();
      throw new Error(`HTTP ${res.status}: ${errBody.slice(0, 500)}`);
    }

    const result = await res.json() as ExecuteResult;
    console.log(`  ✓ Request dispatched (with x402 payment)`);
    console.log(`    Request ID: ${result.requestId}`);
    console.log(`    Job Def ID: ${result.jobDefinitionId}`);
    console.log(`    Status URL: ${result.statusUrl}`);
    console.log(`    Result URL: ${result.resultUrl}`);
    console.log(`    Explorer:   ${result.explorerUrl}`);
    return result;
  }

  // No payment — plain fetch, catches 402
  try {
    const result = await fetchJson<ExecuteResult>(url, {
      method: 'POST',
      body,
    });

    console.log(`  ✓ Request dispatched`);
    console.log(`    Request ID: ${result.requestId}`);
    console.log(`    Job Def ID: ${result.jobDefinitionId}`);
    console.log(`    Status URL: ${result.statusUrl}`);
    console.log(`    Result URL: ${result.resultUrl}`);
    console.log(`    Explorer:   ${result.explorerUrl}`);

    return result;
  } catch (e: any) {
    if (e.message.includes('402')) {
      console.log('  ✗ Payment required — set PRIVATE_KEY env var to enable x402 payment');
      console.log(`    ${e.message}`);
      return null;
    }
    throw e;
  }
}

async function testPollStatus(
  gateway: string,
  requestId: string,
  timeoutMs: number,
  pollIntervalMs: number,
): Promise<StatusResult> {
  console.log('\n--- Step 4: Poll Status ---');
  console.log(`  GET ${gateway}/runs/${requestId}/status`);

  const startTime = Date.now();
  let lastStatus = '';

  while (Date.now() - startTime < timeoutMs) {
    const status = await fetchJson<StatusResult>(`${gateway}/runs/${requestId}/status`);

    if (status.status !== lastStatus) {
      console.log(`  [${new Date().toISOString()}] Status: ${status.status} (${status.jobName || 'unnamed'})`);
      lastStatus = status.status;
    }

    if (status.status === 'completed') {
      console.log(`  ✓ Completed in ${((Date.now() - startTime) / 1000).toFixed(0)}s`);
      return status;
    }

    if (status.status === 'not_found') {
      // Request may not be indexed yet — keep polling
      console.log(`  ... waiting for indexing (${((Date.now() - startTime) / 1000).toFixed(0)}s elapsed)`);
    }

    await new Promise(r => setTimeout(r, pollIntervalMs));
  }

  console.log(`  ✗ Timed out after ${timeoutMs / 1000}s`);
  return { requestId, status: 'in_progress' };
}

async function testFetchResult(gateway: string, requestId: string): Promise<RunResult> {
  console.log('\n--- Step 5: Fetch Result ---');
  console.log(`  GET ${gateway}/runs/${requestId}/result`);

  const result = await fetchJson<RunResult>(`${gateway}/runs/${requestId}/result`);

  console.log(`  Status: ${result.status}`);

  if (result.status === 'completed' && result.result) {
    console.log(`  Result keys: ${Object.keys(result.result).join(', ')}`);

    // Show truncated result
    const resultStr = JSON.stringify(result.result, null, 2);
    if (resultStr.length > 1000) {
      console.log(`  Result (truncated): ${resultStr.slice(0, 1000)}...`);
    } else {
      console.log(`  Result: ${resultStr}`);
    }
  } else if (result.error) {
    console.log(`  Error: ${result.error}`);
  }

  return result;
}

// ============================================================================
// Main
// ============================================================================

async function setupPaymentFetch(): Promise<typeof fetch | undefined> {
  const privateKey = process.env.PRIVATE_KEY;
  if (!privateKey) return undefined;

  const account = privateKeyToAccount(privateKey as `0x${string}`);

  const publicClient = createPublicClient({
    chain: base,
    transport: http(),
  });

  const walletClient = createWalletClient({
    account,
    chain: base,
    transport: http(),
  });

  // Check USDC balance
  const usdcBalance = await publicClient.readContract({
    address: USDC_ADDRESS,
    abi: ERC20_ABI,
    functionName: 'balanceOf',
    args: [account.address],
  });

  const balanceFormatted = formatUnits(usdcBalance, USDC_DECIMALS);
  console.log(`  Wallet: ${account.address}`);
  console.log(`  USDC Balance: ${balanceFormatted}`);

  if (usdcBalance === 0n) {
    console.log('  ! Zero USDC balance — payments will fail');
  }

  return wrapFetchWithPayment(fetch, walletClient);
}

async function main() {
  const args = parseArgs();

  console.log('=== x402 Gateway Consumption Test ===');
  console.log(`  Gateway: ${args.gateway}`);
  if (args.dryRun) console.log('  Mode: DRY-RUN');

  // Set up x402 payment if PRIVATE_KEY is available and --no-pay not passed
  let payFetch: typeof fetch | undefined;
  if (!args.noPay && !args.dryRun && (args.templateSlug || args.all)) {
    payFetch = await setupPaymentFetch();
    if (payFetch) {
      console.log('  Payment: x402 enabled');
    } else {
      console.log('  Payment: disabled (no PRIVATE_KEY)');
    }
  }

  // If just polling an existing request
  if (args.requestId) {
    const status = await testPollStatus(
      args.gateway, args.requestId, args.timeoutMs, args.pollIntervalMs,
    );
    if (status.status === 'completed') {
      await testFetchResult(args.gateway, args.requestId);
    }
    return;
  }

  // Step 1: Discover agents
  const agents = await testDiscovery(args.gateway);

  if (agents.length === 0) {
    console.log('\n✗ No agents found. Is the gateway connected to Ponder?');
    process.exit(1);
  }

  // Step 1b: Check well-known manifest
  await testWellKnown(args.gateway);

  // If --templateSlug or --all, continue to execution
  if (!args.templateSlug && !args.all) {
    console.log('\n✓ Discovery test passed. Use --templateSlug <slug> or --all to test execution.');
    return;
  }

  // Select agent
  let targetAgent: Agent;
  if (args.templateSlug) {
    const match = agents.find(
      a => a.templateId === args.templateSlug
        || a.name.toLowerCase().includes(args.templateSlug!.toLowerCase()),
    );
    if (!match) {
      console.error(`\n✗ No agent matching "${args.templateSlug}". Available: ${agents.map(a => a.name).join(', ')}`);
      process.exit(1);
    }
    targetAgent = match;
  } else {
    // Pick the cheapest or first agent
    targetAgent = agents[0];
  }

  console.log(`\n  Selected agent: ${targetAgent.name} (${targetAgent.templateId})`);

  // Step 2: Get detail
  const detail = await testAgentDetail(args.gateway, targetAgent.templateId);

  // Step 3: Build minimal input and execute
  const input = buildMinimalInput(detail.inputSchema || {});
  const execResult = await testExecute(args.gateway, targetAgent.templateId, input, args.dryRun, payFetch);

  if (!execResult) {
    console.log('\n✓ Test completed (no execution — dry-run or payment required).');
    return;
  }

  // Step 4: Poll status
  const status = await testPollStatus(
    args.gateway, execResult.requestId, args.timeoutMs, args.pollIntervalMs,
  );

  // Step 5: Fetch result
  if (status.status === 'completed') {
    await testFetchResult(args.gateway, execResult.requestId);
    console.log('\n✓ Full consumption test passed!');
  } else {
    console.log(`\n⚠ Test incomplete — status: ${status.status}. Use --requestId ${execResult.requestId} to resume polling.`);
  }
}

main().catch((err) => {
  console.error('\nFatal error:', err.message || err);
  process.exit(1);
});
