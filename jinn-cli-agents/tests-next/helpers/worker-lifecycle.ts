// @ts-nocheck
/**
 * Worker process lifecycle management for tests
 * Migrated from tests/helpers/shared.ts and adapted for tests-next
 */

import fs from 'node:fs';
import path from 'node:path';
import { execa, type ExecaChildProcess } from 'execa';

// Registry of active worker processes for cleanup
const activeWorkerProcesses = new Set<ExecaChildProcess>();

/**
 * Cleanup all tracked worker processes
 * Call this from test teardown to ensure processes exit cleanly
 */
export async function cleanupWorkerProcesses(): Promise<void> {
  const processes = Array.from(activeWorkerProcesses);
  activeWorkerProcesses.clear();

  for (const proc of processes) {
    if (!proc.pid) continue;

    try {
      // Check if process is still running by attempting to kill it
      // This will throw if the process doesn't exist
      proc.kill('SIGTERM');

      // Wait a short time for graceful shutdown
      await Promise.race([
        proc.catch(() => {}), // Ignore rejections on kill
        new Promise(resolve => setTimeout(resolve, 2000))
      ]);

      // Force kill if process might still be running
      // Note: We can't reliably check if process is alive, so just attempt SIGKILL
      // execa will handle the case where process is already dead
      try {
        proc.kill('SIGKILL');
      } catch {
        // Process may have already exited, ignore
      }
    } catch (err: any) {
      // Non-critical - process may have already exited
      // Only warn if it's not a "process not found" type error
      if (!err.message?.includes('not found') && !err.message?.includes('no such process')) {
        console.warn(`[test-cleanup] Warning killing worker process ${proc.pid}:`, err.message);
      }
    }
  }
}

/**
 * Run worker single-shot targeting a specific request
 * Compatible with tests-next ProcessHarness pattern
 */
export async function runWorkerOnce(
  targetRequestId: string,
  options: {
    gqlUrl: string;
    controlApiUrl?: string;
    model?: string;
    timeout?: number;
  }
): Promise<ExecaChildProcess> {
  const env: any = { ...process.env };
  env.PONDER_GRAPHQL_URL = options.gqlUrl;
  env.CONTROL_API_URL = options.controlApiUrl ?? 'http://localhost:4001/graphql';
  env.USE_CONTROL_API = 'true';
  // Model comes from job metadata, not environment - don't set MECH_MODEL
  env.MECH_TARGET_REQUEST_ID = targetRequestId;

  console.log('[runWorkerOnce] launching worker', {
    requestId: targetRequestId,
    gqlUrl: env.PONDER_GRAPHQL_URL,
    controlApiUrl: env.CONTROL_API_URL,
  });

  // Use GITHUB_REPOSITORY from env if available
  if (!env.GITHUB_REPOSITORY && process.env.TEST_GITHUB_REPO) {
    // Extract owner/repo from TEST_GITHUB_REPO URL
    const match = process.env.TEST_GITHUB_REPO.match(/github\.com[:/]([^/]+\/[^/.]+)/);
    if (match) {
      env.GITHUB_REPOSITORY = match[1];
    }
  }

  const workerStdIO = process.env.TESTS_NEXT_WORKER_STDIO === 'inherit' ? 'inherit' : 'pipe';
  const workerLogDir = process.env.TESTS_NEXT_LOG_DIR;
  let workerLogStream: fs.WriteStream | null = null;
  if (workerStdIO !== 'inherit' && workerLogDir) {
    try {
      fs.mkdirSync(workerLogDir, { recursive: true });
      workerLogStream = fs.createWriteStream(path.join(workerLogDir, 'worker.log'), { flags: 'a' });
    } catch {}
  }

  // Run worker CLI with --single so it exits after processing the target request
  const workerProc = execa('yarn', ['dev:mech', '--', '--single'], {
    cwd: process.cwd(),
    env,
    stdio: workerStdIO === 'inherit' ? 'inherit' : 'pipe',
    timeout: options.timeout ?? 300_000,
    cleanup: true, // Kill child processes on exit
    forceKillAfterTimeout: 2000 // Force-kill after 2s if SIGTERM doesn't work
  });

  // Track process for cleanup
  activeWorkerProcesses.add(workerProc);

  // Remove from registry when process exits (successfully or not)
  workerProc.finally(() => {
    activeWorkerProcesses.delete(workerProc);
    workerLogStream?.end();
  });

  // Track quota errors
  let quotaErrorDetected = false;

  // Forward output for debugging and detect quota errors
  if (workerStdIO !== 'inherit') {
    const handleChunk = (d: any) => {
      try {
        const output = d.toString();
        process.stderr.write(`[worker] ${output}`);
        workerLogStream?.write(output);

        if (output.includes('quota limit') && !quotaErrorDetected) {
          quotaErrorDetected = true;
          process.stderr.write('\n[test] ⚠️  Tenderly quota limit detected - test will fail (vitest bail:1 will stop suite)\n');
          workerProc.kill('SIGTERM');
        }
      } catch {}
    };
    workerProc.stdout?.on('data', handleChunk);
    workerProc.stderr?.on('data', handleChunk);
  }

  // Wrap the original promise to reject immediately on quota error
  const originalPromise = workerProc;
  const wrappedPromise = new Promise<void>((resolve, reject) => {
    originalPromise.then(
      () => {
        if (quotaErrorDetected) {
          reject(new Error('Tenderly quota limit reached - test cannot proceed without RPC access'));
        } else {
          resolve();
        }
      },
      (err) => {
        if (quotaErrorDetected) {
          reject(new Error('Tenderly quota limit reached - test cannot proceed without RPC access'));
        } else {
          reject(err);
        }
      }
    );
  });

  return wrappedPromise as any;
}
