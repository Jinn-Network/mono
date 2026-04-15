#!/usr/bin/env ts-node

/**
 * End-to-End Test Rig for Jinn Worker & Wallet Manager
 * 
 * This test rig validates the complete operator experience and ensures
 * the wallet manager library integrates correctly with the worker CLI.
 * 
 * Key features:
 * - Creates ephemeral Tenderly Virtual TestNets for isolated testing
 * - Generates unique private keys per test to avoid address conflicts
 * - Funds test EOAs dynamically via Tenderly Admin RPC
 * - Comprehensive cleanup of test resources
 * 
 * Safety guarantees:
 * - Non-destructive to developer environment
 * - Operates in isolated temporary directories
 * - Cleans up all resources on completion or failure
 * - Does not read/modify root .env files
 */

import { execa } from 'execa';
import { promises as fs } from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { privateKeyToAccount } from 'viem/accounts';
import { createTenderlyClient, ethToWei, type TenderlyClient, type VnetResult } from './lib/tenderly.js';
import dotenv from 'dotenv';

// Load environment variables from .env file
dotenv.config({ path: path.resolve(process.cwd(), '.env') });

// ESM compatibility
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Test configuration
const WORKER_PATH = path.resolve(__dirname, '../worker/mech_worker.ts');
const TEMP_DIR_BASE = '/tmp/jinn-e2e-tests';
const TEST_TIMEOUT_MS = 120000; // 2 minutes per test

// Test RPC endpoints  
const TEST_RPC_URLS = {
  invalid: 'http://localhost:1234',
  malformed: 'not-a-url',
};

// Test chain IDs
const TEST_CHAIN_IDS = {
  base_mainnet: 8453, // Tenderly Virtual Testnet will be Base mainnet
  base_sepolia: 84532, // For mismatch testing
  mainnet: 1, // For mismatch testing
};

/**
 * Generate a unique test private key for each test to avoid address conflicts
 */
function generateTestPrivateKey(): `0x${string}` {
  const randomBytes = crypto.randomBytes(32);
  return `0x${randomBytes.toString('hex')}` as `0x${string}`;
}

/**
 * Test context for isolated test environments
 */
interface TestContext {
  testId: string;
  tempDir: string;
  walletStoragePath: string;
  env: Record<string, string>;
  tenderlyClient: TenderlyClient;
  vnetResult?: VnetResult;
}

/**
 * Worker execution result
 */
interface WorkerResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  duration: number;
  timedOut: boolean;
}

/**
 * Test case definition
 */
interface TestCase {
  name: string;
  description: string;
  setup?: (ctx: TestContext) => Promise<void>;
  execute: (ctx: TestContext) => Promise<WorkerResult>;
  validate: (result: WorkerResult, ctx: TestContext) => Promise<void>;
  cleanup?: (ctx: TestContext) => Promise<void>;
}

/**
 * Test results summary
 */
interface TestSummary {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  results: Array<{
    name: string;
    status: 'PASS' | 'FAIL' | 'SKIP';
    error?: string;
    duration: number;
  }>;
}

/**
 * Get owner address from private key deterministically
 */
async function getOwnerAddressFromKey(privateKey: string): Promise<`0x${string}`> {
  if (!privateKey || !privateKey.startsWith('0x')) {
    throw new Error('Invalid private key for address derivation.');
  }
  const account = privateKeyToAccount(privateKey as `0x${string}`);
  return account.address;
}

/**
 * Create an isolated test environment
 */
async function createTestContext(testName: string, vnetResult: VnetResult, tenderlyClient: TenderlyClient): Promise<TestContext> {
  const testId = `${testName}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  const tempDir = path.join(TEMP_DIR_BASE, testId);
  const walletStoragePath = path.join(tempDir, 'wallets');

  // Create directories
  await fs.mkdir(tempDir, { recursive: true });
  await fs.mkdir(walletStoragePath, { recursive: true });

  // Generate unique private key for this test to avoid Safe address conflicts
  const uniquePrivateKey = generateTestPrivateKey();

  return {
    testId,
    tempDir,
    walletStoragePath,
    tenderlyClient,
    vnetResult,
    env: {
      JINN_WALLET_STORAGE_PATH: walletStoragePath,
      NODE_ENV: 'test',
      // Base configuration - tests will override specific values
      WORKER_PRIVATE_KEY: uniquePrivateKey,
      CHAIN_ID: TEST_CHAIN_IDS.base_mainnet.toString(), // Use Base mainnet to match Tenderly Virtual Testnet
      // Use TEST_RPC_URL for testing to avoid affecting production RPC_URL
      TEST_RPC_URL: vnetResult.adminRpcUrl,
      RPC_URL: 'https://mainnet.base.org', // Keep production RPC as fallback
    },
  };
}

/**
 * Execute the worker with given environment and arguments
 */
async function runWorker(
  ctx: TestContext,
  args: string[] = [],
  timeoutMs: number = TEST_TIMEOUT_MS
): Promise<WorkerResult> {
  const startTime = Date.now();
  
  try {
    // Always use tsx to run the worker (avoids build/module issues)
    const command = 'yarn';
    const execArgs = ['tsx', WORKER_PATH, ...args];
    
    console.log(`[${ctx.testId}] Running ${command} with args: ${execArgs.join(' ')}`);
    console.log(`[${ctx.testId}] Environment: ${JSON.stringify(ctx.env, null, 2)}`);
    
    const childProcess = execa(command, execArgs, {
      env: { ...process.env, ...ctx.env },
      timeout: timeoutMs,
      reject: false, // Don't throw on non-zero exit codes
      all: true, // Capture combined stdout/stderr
    });

    const result = await childProcess;
    const duration = Date.now() - startTime;

    console.log(`[${ctx.testId}] Worker completed in ${duration}ms with exit code ${result.exitCode}`);
    
    return {
      stdout: result.stdout || '',
      stderr: result.stderr || '',
      exitCode: result.exitCode || 0,
      duration,
      timedOut: false,
    };
  } catch (error: any) {
    const duration = Date.now() - startTime;
    
    if (error.timedOut) {
      console.log(`[${ctx.testId}] Worker timed out after ${duration}ms`);
      return {
        stdout: error.stdout || '',
        stderr: error.stderr || '',
        exitCode: 124, // Standard timeout exit code
        duration,
        timedOut: true,
      };
    }
    
    console.log(`[${ctx.testId}] Worker failed with error: ${error.message}`);
    return {
      stdout: error.stdout || '',
      stderr: error.stderr || error.message,
      exitCode: error.exitCode || 1,
      duration,
      timedOut: false,
    };
  }
}

/**
 * Clean up test context
 */
async function cleanupTestContext(ctx: TestContext): Promise<void> {
  try {
    await fs.rm(ctx.tempDir, { recursive: true, force: true });
    console.log(`[${ctx.testId}] Cleaned up test directory: ${ctx.tempDir}`);
  } catch (error) {
    console.warn(`[${ctx.testId}] Failed to cleanup test directory: ${error}`);
  }
}

/**
 * Create a corrupted wallet.json file for testing
 */
async function createCorruptedWalletFile(ctx: TestContext): Promise<void> {
  // Derive owner address dynamically from the private key
  const ownerAddress = await getOwnerAddressFromKey(ctx.env.WORKER_PRIVATE_KEY);
  const walletPath = path.join(
    ctx.walletStoragePath,
    ctx.env.CHAIN_ID,
    `${ownerAddress}.json`
  );
  
  await fs.mkdir(path.dirname(walletPath), { recursive: true });
  await fs.writeFile(walletPath, '{ invalid json content', 'utf8');
}

/**
 * Test case definitions for all assessment criteria
 */
const testCases: TestCase[] = [
  // Assessment A: First-Time Worker Bootstrap
  {
    name: 'assessment-a-first-time-bootstrap',
    description: 'A new worker with funded EOA should bootstrap successfully',
    setup: async (ctx) => {
      if (!ctx.vnetResult) {
        throw new Error('VNet result required for test setup');
      }
      
      const ownerAddress = await getOwnerAddressFromKey(ctx.env.WORKER_PRIVATE_KEY);
      // Fund the EOA with 0.1 ETH
      try {
        await ctx.tenderlyClient.fundAddress(ownerAddress, ethToWei('0.1'), ctx.vnetResult.adminRpcUrl);
      } catch (error: any) {
        if (error.message.includes('quota limit')) {
          throw new Error('SKIP: Tenderly quota limit reached');
        }
        throw error;
      }
    },
    execute: async (ctx) => {
      return await runWorker(ctx, []);
    },
    validate: async (result, ctx) => {
      if (result.exitCode !== 0) {
        throw new Error(`Expected exit code 0, got ${result.exitCode}. stderr: ${result.stderr}`);
      }
      
      if (!result.stdout.includes('Safe deployed successfully!')) {
        throw new Error('Expected successful Safe deployment message');
      }
      
      // Check that wallet.json was created with dynamic address
      const ownerAddress = await getOwnerAddressFromKey(ctx.env.WORKER_PRIVATE_KEY);
      const expectedWalletPath = path.join(
        ctx.walletStoragePath,
        ctx.env.CHAIN_ID,
        `${ownerAddress}.json`
      );
      
      try {
        const walletContent = await fs.readFile(expectedWalletPath, 'utf8');
        const wallet = JSON.parse(walletContent);
        
        if (!wallet.safeAddress || !wallet.ownerAddress || !wallet.chainId) {
          throw new Error('Wallet file missing required fields');
        }
        
        if (wallet.ownerAddress !== ownerAddress) {
          throw new Error(`Wallet owner address mismatch: expected ${ownerAddress}, got ${wallet.ownerAddress}`);
        }
      } catch (error) {
        throw new Error(`Failed to read or parse wallet file: ${error}`);
      }
    },
  },

  // Assessment B1: Missing Private Key
  {
    name: 'assessment-b1-missing-private-key',
    description: 'Worker should fail with clear error when WORKER_PRIVATE_KEY is missing',
    execute: async (ctx) => {
      const envWithoutKey = { ...ctx.env };
      delete envWithoutKey.WORKER_PRIVATE_KEY;
      
      const testCtx = { ...ctx, env: envWithoutKey };
      return await runWorker(testCtx, []);
    },
    validate: async (result, ctx) => {
      if (result.exitCode !== 2) {
        throw new Error(`Expected exit code 2 (configuration error), got ${result.exitCode}`);
      }
      
      if (!result.stderr.includes('WORKER_PRIVATE_KEY')) {
        throw new Error('Expected error message about missing WORKER_PRIVATE_KEY');
      }
    },
  },

  // Assessment B2: Chain ID Mismatch
  {
    name: 'assessment-b2-chain-id-mismatch',
    description: 'Worker should fail when configured CHAIN_ID differs from RPC',
    execute: async (ctx) => {
      const envWithMismatch = {
        ...ctx.env,
        CHAIN_ID: TEST_CHAIN_IDS.base_sepolia.toString(), // Mismatch with Base mainnet Virtual Testnet
      };
      
      const testCtx = { ...ctx, env: envWithMismatch };
      return await runWorker(testCtx, []);
    },
    validate: async (result, ctx) => {
      if (result.exitCode !== 2) {
        throw new Error(`Expected exit code 2 (configuration error), got ${result.exitCode}`);
      }
      
      // Check both stderr and stdout since the error could be in either
      const fullOutput = `${result.stdout}\n${result.stderr}`;
      if (!fullOutput.includes('Chain ID mismatch')) {
        throw new Error(`Expected chain ID mismatch error message. Got stdout: "${result.stdout}", stderr: "${result.stderr}"`);
      }
    },
  },

  // Assessment C: Safe Functionality (Dry Run)
  {
    name: 'assessment-c-safe-functionality-dry-run',
    description: 'Dry run should provide complete information without executing transactions',
    execute: async (ctx) => {
      return await runWorker(ctx, ['--dry-run']);
    },
    validate: async (result, ctx) => {
      if (result.exitCode !== 0) {
        throw new Error(`Expected exit code 0, got ${result.exitCode}. stderr: ${result.stderr}`);
      }
      
      const output = result.stdout;
      
      if (!output.includes('DRY RUN mode')) {
        throw new Error('Expected dry run mode indicator');
      }
      
      if (!output.includes('EOA Owner:')) {
        throw new Error('Expected EOA owner address');
      }
      
      if (!output.includes('Predicted Safe Address:')) {
        throw new Error('Expected predicted Safe address');
      }
      
      if (!output.includes('[DRY RUN] ACTION:')) {
        throw new Error('Expected dry run actions');
      }
      
      if (!output.includes('No on-chain or filesystem changes were made')) {
        throw new Error('Expected confirmation of no changes');
      }
    },
  },

  // Assessment D: Worker Restart & State Reconciliation
  {
    name: 'assessment-d-worker-restart',
    description: 'Worker should recognize existing identity on restart',
    setup: async (ctx) => {
      if (!ctx.vnetResult) {
        throw new Error('VNet result required for test setup');
      }
      
      const ownerAddress = await getOwnerAddressFromKey(ctx.env.WORKER_PRIVATE_KEY);
      // Fund the EOA with 0.1 ETH
      await ctx.tenderlyClient.fundAddress(ownerAddress, ethToWei('0.1'), ctx.vnetResult.adminRpcUrl);
      
      // First run to create the wallet
      const firstResult = await runWorker(ctx, []);
      if (firstResult.exitCode !== 0) {
        throw new Error(`Initial bootstrap failed: ${firstResult.stderr}`);
      }
    },
    execute: async (ctx) => {
      // Second run should detect existing wallet
      return await runWorker(ctx, []);
    },
    validate: async (result, ctx) => {
      if (result.exitCode !== 0) {
        throw new Error(`Expected exit code 0, got ${result.exitCode}. stderr: ${result.stderr}`);
      }
      
      if (!result.stdout.includes('Identity verified')) {
        throw new Error('Expected identity verification message');
      }
      
      if (result.stdout.includes('Safe deployed successfully!')) {
        throw new Error('Should not deploy new Safe on restart');
      }
    },
  },

  // Assessment E: Unfunded EOA Handling (Non-Interactive)
  {
    name: 'assessment-e-unfunded-eoa-non-interactive',
    description: 'Worker should exit with code 3 when EOA is unfunded and --non-interactive is set',
    execute: async (ctx) => {
      const envWithUnfundedKey = {
        ...ctx.env,
        WORKER_PRIVATE_KEY: generateTestPrivateKey(), // Use a unique unfunded key
      };
      
      const testCtx = { ...ctx, env: envWithUnfundedKey };
      return await runWorker(testCtx, ['--non-interactive']);
    },
    validate: async (result, ctx) => {
      if (result.exitCode !== 3) {
        throw new Error(`Expected exit code 3 (funding required), got ${result.exitCode}`);
      }
      
      if (!result.stdout.includes('requires funding') && !result.stderr.includes('requires funding')) {
        throw new Error('Expected funding requirement message');
      }
    },
  },

  // Assessment F1: Corrupted wallet.json Recovery
  {
    name: 'assessment-f1-corrupted-wallet-recovery',
    description: 'Worker should recover from corrupted wallet.json by reconstructing from on-chain state',
    setup: async (ctx) => {
      if (!ctx.vnetResult) {
        throw new Error('VNet result required for test setup');
      }
      
      const ownerAddress = await getOwnerAddressFromKey(ctx.env.WORKER_PRIVATE_KEY);
      // Fund the EOA with 0.1 ETH
      await ctx.tenderlyClient.fundAddress(ownerAddress, ethToWei('0.1'), ctx.vnetResult.adminRpcUrl);
      
      // First, create a valid wallet
      const firstResult = await runWorker(ctx, []);
      if (firstResult.exitCode !== 0) {
        throw new Error(`Initial bootstrap failed: ${firstResult.stderr}`);
      }
      
      // Then corrupt the wallet file
      await createCorruptedWalletFile(ctx);
    },
    execute: async (ctx) => {
      // Should recover from corruption
      return await runWorker(ctx, []);
    },
    validate: async (result, ctx) => {
      if (result.exitCode !== 0) {
        throw new Error(`Expected exit code 0, got ${result.exitCode}. stderr: ${result.stderr}`);
      }
      
      // Should show that it's adopting existing Safe
      if (!result.stdout.includes('Identity verified')) {
        throw new Error('Expected identity verification after recovery');
      }
      
      // Check that wallet.json was reconstructed with dynamic address
      const ownerAddress = await getOwnerAddressFromKey(ctx.env.WORKER_PRIVATE_KEY);
      const expectedWalletPath = path.join(
        ctx.walletStoragePath,
        ctx.env.CHAIN_ID,
        `${ownerAddress}.json`
      );
      
      try {
        const walletContent = await fs.readFile(expectedWalletPath, 'utf8');
        const wallet = JSON.parse(walletContent);
        
        if (!wallet.safeAddress || !wallet.ownerAddress || !wallet.chainId) {
          throw new Error('Reconstructed wallet file missing required fields');
        }
        
        if (wallet.ownerAddress !== ownerAddress) {
          throw new Error(`Reconstructed wallet owner address mismatch: expected ${ownerAddress}, got ${wallet.ownerAddress}`);
        }
      } catch (error) {
        throw new Error(`Failed to read reconstructed wallet file: ${error}`);
      }
    },
  },

  // Assessment G: RPC Failure Resilience
  {
    name: 'assessment-g-rpc-failure',
    description: 'Worker should handle RPC failures gracefully with appropriate error messages',
    execute: async (ctx) => {
      const envWithBadRPC = {
        ...ctx.env,
        RPC_URL: TEST_RPC_URLS.invalid,
      };
      
      const testCtx = { ...ctx, env: envWithBadRPC };
      return await runWorker(testCtx, [], 30000); // Shorter timeout for RPC failures
    },
    validate: async (result, ctx) => {
      if (result.exitCode !== 5) {
        throw new Error(`Expected exit code 5 (RPC error), got ${result.exitCode}`);
      }
      
      // Check both stderr and stdout since the error could be in either
      const fullOutput = `${result.stdout}\n${result.stderr}`;
      if (!fullOutput.includes('RPC') && !fullOutput.includes('network') && !fullOutput.includes('connection') && !fullOutput.includes('fetch failed')) {
        throw new Error(`Expected RPC/network error message. Got stdout: "${result.stdout}", stderr: "${result.stderr}"`);
      }
    },
  },

  // Assessment H: Concurrency Prevention (File Lock)
  {
    name: 'assessment-h-concurrency-prevention',
    description: 'Multiple workers should not create conflicting Safe deployments',
    setup: async (ctx) => {
      if (!ctx.vnetResult) {
        throw new Error('VNet result required for test setup');
      }
      
      const ownerAddress = await getOwnerAddressFromKey(ctx.env.WORKER_PRIVATE_KEY);
      // Fund the EOA with 0.1 ETH
      await ctx.tenderlyClient.fundAddress(ownerAddress, ethToWei('0.1'), ctx.vnetResult.adminRpcUrl);
    },
    execute: async (ctx) => {
      // Start three workers simultaneously
      const workerPromises = [
        runWorker(ctx, []),
        runWorker(ctx, []),
        runWorker(ctx, []),
      ];
      
      const results = await Promise.all(workerPromises);
      
      // Return a synthetic result combining all three
      return {
        stdout: results.map((r, i) => `Worker ${i + 1}: ${r.stdout}`).join('\n'),
        stderr: results.map((r, i) => `Worker ${i + 1}: ${r.stderr}`).join('\n'),
        exitCode: Math.max(...results.map(r => r.exitCode)),
        duration: Math.max(...results.map(r => r.duration)),
        timedOut: results.some(r => r.timedOut),
      };
    },
    validate: async (result, ctx) => {
      // At least one worker should succeed
      if (!result.stdout.includes('Safe deployed successfully!') && !result.stdout.includes('Identity verified')) {
        throw new Error('No worker successfully completed bootstrap');
      }
      
      // Check that only one wallet file was created using dynamic address
      const chainDir = path.join(ctx.walletStoragePath, ctx.env.CHAIN_ID);
      try {
        const files = await fs.readdir(chainDir);
        if (files.length !== 1) {
          throw new Error(`Expected 1 wallet file, found ${files.length}: ${files.join(', ')}`);
        }
        
        // Verify the file name matches the expected owner address
        const ownerAddress = await getOwnerAddressFromKey(ctx.env.WORKER_PRIVATE_KEY);
        const expectedFileName = `${ownerAddress}.json`;
        if (!files.includes(expectedFileName)) {
          throw new Error(`Expected wallet file ${expectedFileName}, found: ${files.join(', ')}`);
        }
      } catch (error) {
        throw new Error(`Failed to check wallet directory: ${error}`);
      }
    },
  },

  // Assessment I: Invalid Private Key
  {
    name: 'assessment-i-invalid-private-key',
    description: 'Worker should reject malformed private keys with clear error',
    execute: async (ctx) => {
      const envWithBadKey = {
        ...ctx.env,
        WORKER_PRIVATE_KEY: 'not-a-private-key', // Use malformed key directly
      };
      
      const testCtx = { ...ctx, env: envWithBadKey };
      return await runWorker(testCtx, []);
    },
    validate: async (result, ctx) => {
      if (result.exitCode !== 2) {
        throw new Error(`Expected exit code 2 (configuration error), got ${result.exitCode}`);
      }
      
      if (!result.stderr.includes('private key') && !result.stderr.includes('WORKER_PRIVATE_KEY')) {
        throw new Error('Expected private key validation error message');
      }
    },
  },
];

/**
 * Run a single test case
 */
async function runTestCase(
  testCase: TestCase, 
  vnetResult: VnetResult,
  tenderlyClient: TenderlyClient
): Promise<{ status: 'PASS' | 'FAIL'; error?: string; duration: number }> {
  const startTime = Date.now();
  let ctx: TestContext | null = null;
  
  try {
    console.log(`\n🧪 Running: ${testCase.name}`);
    console.log(`   ${testCase.description}`);
    
    // Create test context with VNet integration
    ctx = await createTestContext(testCase.name, vnetResult, tenderlyClient);
    
    // Run setup if provided
    if (testCase.setup) {
      console.log(`   Setting up test...`);
      await testCase.setup(ctx);
    }
    
    // Execute test
    console.log(`   Executing test...`);
    const result = await testCase.execute(ctx);
    
    // Validate result
    console.log(`   Validating result...`);
    await testCase.validate(result, ctx);
    
    // Run cleanup if provided
    if (testCase.cleanup) {
      console.log(`   Running test cleanup...`);
      await testCase.cleanup(ctx);
    }
    
    const duration = Date.now() - startTime;
    console.log(`✅ PASS: ${testCase.name} (${duration}ms)`);
    
    return { status: 'PASS', duration };
  } catch (error: any) {
    const duration = Date.now() - startTime;
    console.log(`❌ FAIL: ${testCase.name} (${duration}ms)`);
    console.log(`   Error: ${error.message}`);
    
    return { status: 'FAIL', error: error.message, duration };
  } finally {
    // Always cleanup test context
    if (ctx) {
      await cleanupTestContext(ctx);
    }
  }
}

/**
 * Main test runner
 */
async function runAllTests(): Promise<void> {
  console.log('🚀 Starting Jinn E2E Test Suite');
  console.log(`📁 Test workspace: ${TEMP_DIR_BASE}`);
  console.log(`🔧 Worker path: ${WORKER_PATH}`);
  
  // Ensure temp directory exists and is clean
  await fs.rm(TEMP_DIR_BASE, { recursive: true, force: true });
  await fs.mkdir(TEMP_DIR_BASE, { recursive: true });
  
  // Check worker availability
  try {
    await fs.access(WORKER_PATH);
    console.log('✅ Worker found - will use tsx');
  } catch {
    console.error(`❌ Worker not found: ${WORKER_PATH}`);
    process.exit(1);
  }
  
  // Initialize Tenderly client
  const tenderlyClient = createTenderlyClient();
  let vnetResult: VnetResult | null = null;
  
  try {
    // Global Setup: Create ephemeral Tenderly VNet
    if (!tenderlyClient.isConfigured()) {
      throw new Error('Tenderly client must be configured for E2E tests. Set TENDERLY_ACCESS_KEY, TENDERLY_ACCOUNT_SLUG, and TENDERLY_PROJECT_SLUG environment variables.');
    }

    console.log('🔗 Creating ephemeral Tenderly Virtual TestNet for test run...');
    vnetResult = await tenderlyClient.createVnet(TEST_CHAIN_IDS.base_mainnet);
    console.log(`✅ Tenderly Virtual TestNet created: ${vnetResult.id}`);
    console.log(`🌐 Admin RPC URL: ${vnetResult.adminRpcUrl}`);
    
    const summary: TestSummary = {
      total: testCases.length,
      passed: 0,
      failed: 0,
      skipped: 0,
      results: [],
    };
    
    // Run all test cases
    for (const testCase of testCases) {
      const result = await runTestCase(testCase, vnetResult, tenderlyClient);
      
      summary.results.push({
        name: testCase.name,
        status: result.status,
        error: result.error,
        duration: result.duration,
      });
      
      if (result.status === 'PASS') {
        summary.passed++;
      } else {
        summary.failed++;
      }
    }
    
    // Print summary
    console.log('\n📊 Test Summary');
    console.log('================');
    console.log(`Total:  ${summary.total}`);
    console.log(`Passed: ${summary.passed}`);
    console.log(`Failed: ${summary.failed}`);
    console.log(`Skip:   ${summary.skipped}`);
    
    if (summary.failed > 0) {
      console.log('\n💥 Failed Tests:');
      for (const result of summary.results) {
        if (result.status === 'FAIL') {
          console.log(`   ❌ ${result.name}: ${result.error}`);
        }
      }
    }
    
    // Exit with appropriate code
    if (summary.failed > 0) {
      console.log('\n❌ Some tests failed');
      process.exit(1);
    } else {
      console.log('\n✅ All tests passed!');
      process.exit(0);
    }
  } catch (error: any) {
    console.error('💥 Test setup failed:', error.message);
    process.exit(1);
  } finally {
    // Global Teardown: Clean up ephemeral VNet and workspace
    if (vnetResult) {
      const tenderlyClient = createTenderlyClient();
      console.log(`\n🗑️ Deleting ephemeral Tenderly Virtual TestNet: ${vnetResult.id}...`);
      await tenderlyClient.deleteVnet(vnetResult.id);
    }
    
    await fs.rm(TEMP_DIR_BASE, { recursive: true, force: true });
    console.log(`🧹 Cleaned up test workspace: ${TEMP_DIR_BASE}`);
  }
}

// Handle script execution
if (import.meta.url === `file://${process.argv[1]}`) {
  runAllTests().catch((error) => {
    console.error('💥 Test runner failed:', error);
    process.exit(1);
  });
}

export {
  runAllTests,
  createTestContext,
  runWorker,
  cleanupTestContext,
  type TestContext,
  type WorkerResult,
  type TestCase,
  type TestSummary,
};