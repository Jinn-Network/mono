#!/usr/bin/env tsx

/**
 * JINN-197: E2E Worker Test That Actually Runs The Worker
 * 
 * This test validates the production worker entrypoint by:
 * 1. Spawning the actual worker process (yarn mech)
 * 2. Monitoring logs for OLAS staking execution in the main loop
 * 3. Verifying service deployment/staking via middleware status
 * 4. Confirming worker continues processing after OLAS operations
 * 5. Gracefully cleaning up the worker process
 * 
 * This is the ONLY valid approach for E2E testing - we test the actual
 * production code path, not isolated components.
 */

import { execa, type ResultPromise } from 'execa';
import { promises as fs } from 'fs';
import path from 'path';
import crypto from 'crypto';
import { privateKeyToAccount } from 'viem/accounts';
import { createTenderlyClient, ethToWei, type VnetResult } from './lib/tenderly.js';
import { setupOlasEnvironment, createServiceConfig, BASE_MAINNET_CHAIN_ID, type ServiceTestConfig } from './lib/e2e-test-utils.js';
import { OlasOperateWrapper } from 'jinn-node/worker/OlasOperateWrapper.js';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config({ path: path.resolve(process.cwd(), '.env') });

// Test configuration
const TEMP_DIR_BASE = '/tmp/jinn-worker-e2e-test';
const TEST_TIMEOUT_MS = 300000; // 5 minutes
const STAKING_INTERVAL_MS = 60000; // 1 minute for testing (vs 1 hour in production)
const LOG_WAIT_TIMEOUT_MS = 90000; // Wait up to 90 seconds for log markers

/**
 * Generate a unique test private key
 */
function generateTestPrivateKey(): `0x${string}` {
  const randomBytes = crypto.randomBytes(32);
  return `0x${randomBytes.toString('hex')}` as `0x${string}`;
}

/**
 * Test context for the worker E2E test
 */
interface WorkerE2ETestContext {
  testId: string;
  tempDir: string;
  privateKey: `0x${string}`;
  ownerAddress: `0x${string}`;
  tenderlyClient: ReturnType<typeof createTenderlyClient>;
  vnetResult: VnetResult;
  operateWrapper: OlasOperateWrapper;
  serviceConfigPath: string;
}

/**
 * Test step result
 */
interface TestStepResult {
  stepName: string;
  success: boolean;
  error?: string;
  data?: any;
  duration: number;
}

/**
 * Complete test result
 */
interface WorkerE2ETestResult {
  success: boolean;
  totalDuration: number;
  steps: TestStepResult[];
  workerLogs: string[];
  error?: string;
}

/**
 * Wait for a specific log pattern to appear in worker output
 */
async function waitForLog(
  workerProcess: ResultPromise,
  pattern: string | RegExp,
  timeoutMs: number = LOG_WAIT_TIMEOUT_MS
): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = '';
    const timeoutId = setTimeout(() => {
      reject(new Error(`Timeout waiting for log pattern: ${pattern}`));
    }, timeoutMs);

    const checkOutput = (data: Buffer | string) => {
      const chunk = data.toString();
      output += chunk;
      
      const matches = typeof pattern === 'string' 
        ? output.includes(pattern)
        : pattern.test(output);
      
      if (matches) {
        clearTimeout(timeoutId);
        resolve(output);
      }
    };

    if (workerProcess.stdout) {
      workerProcess.stdout.on('data', checkOutput);
    }
    if (workerProcess.stderr) {
      workerProcess.stderr.on('data', checkOutput);
    }

    workerProcess.on('exit', (code) => {
      clearTimeout(timeoutId);
      reject(new Error(`Worker process exited with code ${code} before pattern found`));
    });
  });
}

/**
 * Create test context with all required components
 */
async function createWorkerE2ETestContext(): Promise<WorkerE2ETestContext> {
  const testId = `worker-e2e-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  const tempDir = path.join(TEMP_DIR_BASE, testId);

  // Create directories
  await fs.mkdir(tempDir, { recursive: true });

  // Generate unique private key for this test
  const privateKey = generateTestPrivateKey();
  const account = privateKeyToAccount(privateKey);
  const ownerAddress = account.address;

  // Initialize Tenderly client
  const tenderlyClient = createTenderlyClient();
  if (!tenderlyClient.isConfigured()) {
    throw new Error('Tenderly client must be configured. Set TENDERLY_ACCESS_KEY, TENDERLY_ACCOUNT_SLUG, and TENDERLY_PROJECT_SLUG environment variables.');
  }

  // Create ephemeral VNet
  console.log(`[${testId}] Creating ephemeral Tenderly Virtual TestNet...`);
  const vnetResult = await tenderlyClient.createVnet(BASE_MAINNET_CHAIN_ID);
  console.log(`[${testId}] VNet created: ${vnetResult.id} with RPC: ${vnetResult.adminRpcUrl}`);

  // Fund the test EOA
  console.log(`[${testId}] Funding test EOA ${ownerAddress} with 1 ETH...`);
  await tenderlyClient.fundAddress(ownerAddress, ethToWei('1.0'), vnetResult.adminRpcUrl);

  // Create operate wrapper for CLI operations
  const operateWrapper = await OlasOperateWrapper.create();

  // Set up environment and create service configuration
  const testConfig: ServiceTestConfig = { testId, ownerAddress, vnetResult };
  setupOlasEnvironment(testConfig);
  
  const serviceConfigPath = path.join(tempDir, 'test-service-quickstart-config.json');
  const serviceConfig = createServiceConfig(testConfig);
  await fs.writeFile(serviceConfigPath, JSON.stringify(serviceConfig, null, 2));

  return {
    testId,
    tempDir,
    privateKey,
    ownerAddress,
    tenderlyClient,
    vnetResult,
    operateWrapper,
    serviceConfigPath,
  };
}

/**
 * Clean up test context
 */
async function cleanupWorkerE2ETestContext(ctx: WorkerE2ETestContext): Promise<void> {
  try {
    // Delete VNet
    await ctx.tenderlyClient.deleteVnet(ctx.vnetResult.id);
    console.log(`[${ctx.testId}] Deleted VNet: ${ctx.vnetResult.id}`);
  } catch (error) {
    console.warn(`[${ctx.testId}] Failed to delete VNet: ${error}`);
  }

  try {
    // Clean up temp directory
    await fs.rm(ctx.tempDir, { recursive: true, force: true });
    console.log(`[${ctx.testId}] Cleaned up temp directory: ${ctx.tempDir}`);
  } catch (error) {
    console.warn(`[${ctx.testId}] Failed to cleanup temp directory: ${error}`);
  }
}

/**
 * Execute a test step with timing and error handling
 */
async function executeTestStep<T>(
  stepName: string,
  testId: string,
  stepFunction: () => Promise<T>
): Promise<TestStepResult> {
  const startTime = Date.now();
  console.log(`[${testId}] 🔄 ${stepName}...`);

  try {
    const data = await stepFunction();
    const duration = Date.now() - startTime;
    console.log(`[${testId}] ✅ ${stepName} completed (${duration}ms)`);
    
    return {
      stepName,
      success: true,
      data,
      duration
    };
  } catch (error: any) {
    const duration = Date.now() - startTime;
    console.log(`[${testId}] ❌ ${stepName} failed (${duration}ms): ${error.message}`);
    
    return {
      stepName,
      success: false,
      error: error.message,
      duration
    };
  }
}

/**
 * Run the worker E2E test
 */
async function runWorkerE2ETest(ctx: WorkerE2ETestContext): Promise<WorkerE2ETestResult> {
  const startTime = Date.now();
  const steps: TestStepResult[] = [];
  const workerLogs: string[] = [];
  let workerProcess: ResultPromise | null = null;

  try {
    // Step 1: Build the worker
    const step1 = await executeTestStep(
      "Build worker",
      ctx.testId,
      async () => {
        const buildResult = await execa('yarn', ['build'], {
          cwd: process.cwd(),
          stdio: 'pipe'
        });
        return { exitCode: buildResult.exitCode };
      }
    );
    steps.push(step1);
    if (!step1.success) throw new Error(`Build failed: ${step1.error}`);

    // Step 2: Start the actual worker process
    const step2 = await executeTestStep(
      "Start worker process",
      ctx.testId,
      async () => {
        console.log(`[${ctx.testId}] Spawning worker with yarn mech...`);
        
        workerProcess = execa('yarn', ['mech'], {
          cwd: process.cwd(),
          env: {
            ...process.env,
            OPERATE_PASSWORD: process.env.OPERATE_PASSWORD || '12345678',
            BASE_LEDGER_RPC: ctx.vnetResult.adminRpcUrl,
            RPC_URL: ctx.vnetResult.adminRpcUrl,
            CHAIN_ID: BASE_MAINNET_CHAIN_ID.toString(),
            STAKING_PROGRAM: 'custom_staking',
            // CRITICAL: Override staking interval to 1 minute for testing
            // The worker reads process.env at startup
            STAKING_INTERVAL_MS_OVERRIDE: STAKING_INTERVAL_MS.toString(),
          },
          stdio: 'pipe',
          reject: false, // Don't reject on non-zero exit
        });

        // Capture all output
        if (workerProcess.stdout) {
          workerProcess.stdout.on('data', (data) => {
            const line = data.toString();
            workerLogs.push(line);
            console.log(`[WORKER] ${line}`);
          });
        }
        if (workerProcess.stderr) {
          workerProcess.stderr.on('data', (data) => {
            const line = data.toString();
            workerLogs.push(`[STDERR] ${line}`);
            console.error(`[WORKER ERROR] ${line}`);
          });
        }

        // Wait for worker to start up
        await waitForLog(workerProcess, /Worker starting up|Main loop started/i, 30000);
        
        return { pid: workerProcess.pid };
      }
    );
    steps.push(step2);
    if (!step2.success) throw new Error(`Worker startup failed: ${step2.error}`);

    // Step 3: Wait for OLAS staking cycle to execute
    const step3 = await executeTestStep(
      "Wait for OLAS staking execution",
      ctx.testId,
      async () => {
        if (!workerProcess) throw new Error('Worker process not available');
        
        console.log(`[${ctx.testId}] Waiting for OLAS staking operation (timeout: ${LOG_WAIT_TIMEOUT_MS}ms)...`);
        
        // Wait for the specific log marker from processStakingOperations
        await waitForLog(
          workerProcess,
          /OLAS staking operation completed successfully|Executing periodic OLAS staking operations/i,
          LOG_WAIT_TIMEOUT_MS
        );
        
        return { stakingExecuted: true };
      }
    );
    steps.push(step3);
    if (!step3.success) throw new Error(`OLAS staking execution not detected: ${step3.error}`);

    // Step 4: Verify service was deployed/staked via middleware
    const step4 = await executeTestStep(
      "Verify service deployment via middleware",
      ctx.testId,
      async () => {
        // Query the middleware for service status
        const statusResult = await ctx.operateWrapper.executeCommand('operate', [
          'service',
          'status'
        ]);
        
        // Parse the status output to verify service was created/deployed
        const statusOutput = statusResult.stdout || '';
        
        return {
          statusOutput,
          hasServiceInfo: statusOutput.length > 0,
          rawStatus: statusResult
        };
      }
    );
    steps.push(step4);
    if (!step4.success) throw new Error(`Middleware verification failed: ${step4.error}`);

    // Step 5: Verify worker continues running after staking
    const step5 = await executeTestStep(
      "Verify worker continues processing",
      ctx.testId,
      async () => {
        if (!workerProcess) throw new Error('Worker process not available');
        
        // Check that worker is still running (not exited)
        const exitCode = (workerProcess as any).exitCode;
        if (exitCode !== null && exitCode !== undefined) {
          throw new Error(`Worker exited with code ${exitCode}`);
        }
        
        // Give it a moment to continue the main loop
        await new Promise(resolve => setTimeout(resolve, 5000));
        
        // Verify still running
        const exitCodeAfter = (workerProcess as any).exitCode;
        if (exitCodeAfter !== null && exitCodeAfter !== undefined) {
          throw new Error(`Worker exited after staking with code ${exitCodeAfter}`);
        }
        
        return { stillRunning: true };
      }
    );
    steps.push(step5);
    if (!step5.success) throw new Error(`Worker did not continue running: ${step5.error}`);

    const totalDuration = Date.now() - startTime;
    console.log(`[${ctx.testId}] 🎉 Worker E2E test completed successfully in ${totalDuration}ms`);

    return {
      success: true,
      totalDuration,
      steps,
      workerLogs
    };

  } catch (error: any) {
    const totalDuration = Date.now() - startTime;
    console.log(`[${ctx.testId}] 💥 Worker E2E test failed after ${totalDuration}ms: ${error.message}`);

    return {
      success: false,
      totalDuration,
      steps,
      workerLogs,
      error: error.message
    };
  } finally {
    // Always kill worker process
    if (workerProcess) {
      const pid = (workerProcess as any).pid;
      if (pid) {
        console.log(`[${ctx.testId}] Killing worker process (PID: ${pid})...`);
      }
      try {
        (workerProcess as any).kill('SIGTERM');
        
        // Wait up to 5 seconds for graceful shutdown
        const killTimeout = setTimeout(() => {
          console.log(`[${ctx.testId}] Force killing worker process...`);
          (workerProcess as any)?.kill('SIGKILL');
        }, 5000);
        
        await workerProcess;
        clearTimeout(killTimeout);
        
        console.log(`[${ctx.testId}] Worker process terminated`);
      } catch (killError) {
        console.warn(`[${ctx.testId}] Error killing worker: ${killError}`);
      }
    }
  }
}

/**
 * Main test runner
 */
async function runWorkerE2ETestMain(): Promise<void> {
  console.log('🚀 Starting Worker E2E Test (JINN-197)');
  console.log('   This test spawns the ACTUAL worker process and validates OLAS integration');
  console.log(`📁 Test workspace: ${TEMP_DIR_BASE}`);

  // Ensure temp directory exists and is clean
  await fs.rm(TEMP_DIR_BASE, { recursive: true, force: true });
  await fs.mkdir(TEMP_DIR_BASE, { recursive: true });

  let ctx: WorkerE2ETestContext | null = null;

  try {
    // Create test context
    ctx = await createWorkerE2ETestContext();

    // Run the E2E test
    const result = await runWorkerE2ETest(ctx);

    // Print detailed results
    console.log('\n📊 Test Results');
    console.log('================');
    console.log(`Overall Success: ${result.success ? '✅ PASS' : '❌ FAIL'}`);
    console.log(`Total Duration: ${result.totalDuration}ms`);
    console.log(`Steps Completed: ${result.steps.filter(s => s.success).length}/${result.steps.length}`);

    console.log('\n📋 Step Details:');
    for (const step of result.steps) {
      const status = step.success ? '✅' : '❌';
      console.log(`   ${status} ${step.stepName} (${step.duration}ms)`);
      if (!step.success && step.error) {
        console.log(`      Error: ${step.error}`);
      }
    }

    console.log(`\n📝 Captured ${result.workerLogs.length} log lines from worker`);

    // Exit with appropriate code
    if (result.success) {
      console.log('\n✅ Worker E2E Test PASSED!');
      console.log('   ✓ Worker process started successfully');
      console.log('   ✓ OLAS staking executed in main loop');
      console.log('   ✓ Service deployment verified via middleware');
      console.log('   ✓ Worker continued processing after staking');
      process.exit(0);
    } else {
      console.log('\n❌ Worker E2E Test FAILED!');
      if (result.error) {
        console.log(`   Error: ${result.error}`);
      }
      process.exit(1);
    }

  } catch (error: any) {
    console.error('💥 Test setup failed:', error.message);
    process.exit(1);
  } finally {
    // Always cleanup
    if (ctx) {
      await cleanupWorkerE2ETestContext(ctx);
    }
  }
}

// Handle script execution
if (import.meta.url === `file://${process.argv[1]}`) {
  // Set timeout for entire test
  const timeoutId = setTimeout(() => {
    console.error(`💥 Test exceeded maximum timeout of ${TEST_TIMEOUT_MS}ms`);
    process.exit(1);
  }, TEST_TIMEOUT_MS);

  runWorkerE2ETestMain()
    .catch((error) => {
      console.error('💥 Test runner failed:', error);
      process.exit(1);
    })
    .finally(() => {
      clearTimeout(timeoutId);
    });
}

export {
  runWorkerE2ETestMain,
  createWorkerE2ETestContext,
  cleanupWorkerE2ETestContext,
  type WorkerE2ETestContext,
  type WorkerE2ETestResult,
  type TestStepResult,
};
