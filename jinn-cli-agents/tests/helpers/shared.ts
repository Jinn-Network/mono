/**
 * Shared test utilities for E2E marketplace and worker tests
 * Extracted from onchain.marketplace.e2e.test.ts for reusability
 */

import { execa, type ResultPromise } from 'execa';
import fetch from 'cross-fetch';
import path from 'node:path';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { execSync } from 'child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { loadEnvOnce } from 'jinn-node/agent/mcp/tools/shared/env.js';
import { createTenderlyClient, ethToWei, type VnetResult } from 'jinn-node/lib/tenderly.js';
import { parseRepoSlug } from './test-git-repo.js';

// Re-export types for convenience
export type { VnetResult };

async function waitForPidExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  try {
    process.kill(pid, 0);
  } catch {
    return true;
  }
  return false;
}

/**
 * MCP Client wrapper for calling tools through the MCP protocol
 */
class McpClientWrapper {
  private client: Client | null = null;
  private transport: StdioClientTransport | null = null;
  private mcpServerPid: number | null = null;

  async connect(): Promise<void> {
    if (this.client) return; // Already connected

    const repoRoot = process.env.JINN_REPO_ROOT || process.env.INIT_CWD || process.cwd();
    const resolvedCommand = process.env.JINN_MCP_COMMAND || 'yarn';
    let resolvedArgs: string[] | null = null;

    if (resolvedCommand === 'yarn') {
      resolvedArgs = ['tsx', 'gemini-agent/mcp/server.ts'];
    } else {
      try {
        if (process.env.JINN_MCP_ARGS) {
          const parsed = JSON.parse(process.env.JINN_MCP_ARGS);
          if (Array.isArray(parsed) && parsed.every(arg => typeof arg === 'string')) {
            resolvedArgs = parsed;
          }
        }
      } catch (error) {
        console.warn('[MCP] Failed to parse JINN_MCP_ARGS, falling back to defaults:', error);
      }

      if (!resolvedArgs || resolvedArgs.length === 0) {
        resolvedArgs = ['tsx', 'gemini-agent/mcp/server.ts'];
      }
    }

    this.transport = new StdioClientTransport({
      command: resolvedCommand,
      args: resolvedArgs,
      cwd: repoRoot,
      env: { ...process.env, JINN_REPO_ROOT: repoRoot } as Record<string, string>
    });

    this.client = new Client(
      { name: 'e2e-test-client', version: '1.0.0' },
      { capabilities: { tools: {} } }
    );

    await this.client.connect(this.transport);

    // Try to extract the child process PID from the transport
    // StdioClientTransport spawns a child process internally, but doesn't expose it directly
    // We'll need to find it by command/args after a short delay
    setTimeout(() => {
      this.findMcpServerPid(resolvedCommand, resolvedArgs || []);
    }, 500);
  }

  /**
   * Find the MCP server process PID by matching command and args
   * This is a fallback since StdioClientTransport doesn't expose the child process
   */
  private findMcpServerPid(command: string, args: string[]): void {
    try {
      // Find process matching the command and args
      // On macOS/Linux, we can use ps to find the process
      const psOutput = execSync('ps aux', { encoding: 'utf-8' });
      const lines = psOutput.split('\n');
      
      for (const line of lines) {
        // Look for the process with matching command and args
        if (line.includes(command) && args.some(arg => line.includes(arg))) {
          const parts = line.trim().split(/\s+/);
          const pid = parseInt(parts[1], 10);
          if (!isNaN(pid) && pid > 0) {
            this.mcpServerPid = pid;
            break;
          }
        }
      }
    } catch (err) {
      // Non-critical - we'll fall back to process group killing
    }
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      try {
        // Close the client first (this should close the transport)
        await this.client.close();
      } catch (err: any) {
        // Ignore errors during close
      }
      this.client = null;
    }

    // Ensure the MCP server child process is terminated
    if (this.mcpServerPid) {
      const trackedPid = this.mcpServerPid;
      try {
        try {
          process.kill(-trackedPid, 'SIGTERM');
        } catch {
          process.kill(trackedPid, 'SIGTERM');
        }

        let exited = await waitForPidExit(trackedPid, 3000);
        if (!exited) {
          try {
            process.kill(-trackedPid, 'SIGKILL');
          } catch {
            try {
              process.kill(trackedPid, 'SIGKILL');
            } catch {}
          }
          exited = await waitForPidExit(trackedPid, 2000);
          if (!exited) {
            console.warn(`[MCP] Warning: MCP server process ${trackedPid} did not exit after SIGKILL`);
          }
        }
      } catch {
        // Process may have already exited
      }
      this.mcpServerPid = null;
    }

    // Also try to kill any remaining MCP server processes by command pattern
    // This is a fallback if PID tracking failed
    try {
      const psOutput = execSync('ps aux | grep "tsx.*gemini-agent/mcp/server.ts" | grep -v grep', { encoding: 'utf-8' }).trim();
      if (psOutput) {
        const lines = psOutput.split('\n');
        for (const line of lines) {
          const parts = line.trim().split(/\s+/);
          const pid = parseInt(parts[1], 10);
          if (Number.isInteger(pid) && pid > 0) {
            try {
              process.kill(pid, 'SIGTERM');
              let exited = await waitForPidExit(pid, 3000);
              if (!exited) {
                try {
                  process.kill(pid, 'SIGKILL');
                } catch {}
                exited = await waitForPidExit(pid, 2000);
              }
              if (!exited) {
                console.warn(`[MCP] Warning: MCP server process ${pid} did not exit after SIGKILL`);
              }
            } catch {
              // Process may have already exited
            }
          }
        }
      }
    } catch {
      // No matching processes or command failed, ignore
    }

    this.transport = null;
  }

  async callTool(toolName: string, args: Record<string, any>): Promise<any> {
    // Auto-connect if not connected (handles module reload between test files)
    if (!this.client) {
      await this.connect();
    }
    return await this.client!.callTool({ name: toolName, arguments: args });
  }
}

let mcpClient: McpClientWrapper | null = null;

/**
 * Get or create the MCP client instance
 */
export function getMcpClient(): McpClientWrapper {
  if (!mcpClient) {
    mcpClient = new McpClientWrapper();
  }
  return mcpClient;
}

/**
 * Parse MCP tool response content
 */
export function parseToolText(result: any): any {
  try {
    const text = result?.content?.[0]?.text;
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

/**
 * Temporarily set the active job context for MCP tool calls.
 * Ensures the MCP client reloads environment variables so dispatch tools
 * record proper lineage (sourceRequestId/sourceJobDefinitionId).
 */
export async function withJobContext<T>(
  context: { requestId?: string | null; jobDefinitionId?: string | null; baseBranch?: string | null },
  fn: () => Promise<T>
): Promise<T> {
  const client = getMcpClient();

  await client.disconnect();

  if (context.requestId) {
    process.env.JINN_REQUEST_ID = context.requestId;
  } else {
    delete process.env.JINN_REQUEST_ID;
  }

  if (context.jobDefinitionId) {
    process.env.JINN_JOB_DEFINITION_ID = context.jobDefinitionId;
  } else {
    delete process.env.JINN_JOB_DEFINITION_ID;
  }

  if (context.baseBranch) {
    process.env.JINN_BASE_BRANCH = context.baseBranch;
  } else {
    delete process.env.JINN_BASE_BRANCH;
  }

  await client.connect();

  try {
    return await fn();
  } finally {
    if (context.requestId) {
      delete process.env.JINN_REQUEST_ID;
    }
    if (context.jobDefinitionId) {
      delete process.env.JINN_JOB_DEFINITION_ID;
    }
    if (context.baseBranch) {
      delete process.env.JINN_BASE_BRANCH;
    }
    await client.disconnect();
    await client.connect();
  }
}

/**
 * Reconstruct IPFS directory CID from hex ipfsHash (raw codec)
 */
function hexToBytes(hex: string): number[] {
  const s = hex.startsWith('0x') ? hex.slice(2) : hex;
  const out: number[] = [];
  for (let i = 0; i < s.length; i += 2) out.push(parseInt(s.slice(i, i + 2), 16));
  return out;
}

function toBase32LowerNoPad(bytes: number[]): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
  let bitBuffer = 0;
  let bitCount = 0;
  let out = '';
  for (const b of bytes) {
    bitBuffer = (bitBuffer << 8) | (b & 0xff);
    bitCount += 8;
    while (bitCount >= 5) {
      const idx = (bitBuffer >> (bitCount - 5)) & 0x1f;
      bitCount -= 5;
      out += alphabet[idx];
    }
  }
  if (bitCount > 0) {
    const idx = (bitBuffer << (5 - bitCount)) & 0x1f;
    out += alphabet[idx];
  }
  return out;
}

export function reconstructDirCidFromHexIpfsHash(ipfsHashHex: string): string | null {
  const s = String(ipfsHashHex).toLowerCase();
  const prefix = 'f01551220';
  if (!s.startsWith(prefix)) return null;
  const digestHex = s.slice(prefix.length);
  if (digestHex.length !== 64) return null;
  const digestBytes = hexToBytes(digestHex);
  const cidBytes = [0x01, 0x70, 0x12, 0x20, ...digestBytes];
  return 'b' + toBase32LowerNoPad(cidBytes);
}

/**
 * Fetch JSON from URL with retries
 */
export async function fetchJsonWithRetry(url: string, attempts = 5, delayMs = 1500): Promise<any> {
  for (let i = 0; i < attempts; i++) {
    try {
      const resp = await fetch(url);
      if (resp.ok) return await resp.json();
    } catch {}
    if (i < attempts - 1) await new Promise(r => setTimeout(r, delayMs));
  }
  throw new Error(`Failed to fetch JSON from ${url}`);
}

/**
 * Wait for GraphQL endpoint to become available
 */
export async function waitForGraphql(url: string, timeoutMs = 60_000): Promise<void> {
  const start = Date.now();
  const q = '{ requests(limit: 1) { items { id } } }';
  let lastErr: any = null;
  while (true) {
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: q })
      });
      if (resp.ok) return;
      lastErr = new Error(`GraphQL HTTP ${resp.status}`);
    } catch (e: any) {
      lastErr = e;
    }
    if (Date.now() - start > timeoutMs) {
      throw lastErr || new Error('Timed out waiting for GraphQL');
    }
    await new Promise(r => setTimeout(r, 1000));
  }
}

function readPonderLogTail(maxBytes = 4096): string | null {
  const logDir = process.env.TESTS_NEXT_LOG_DIR;
  if (!logDir) return null;
  try {
    const logPath = path.join(logDir, 'ponder.log');
    if (!fs.existsSync(logPath)) {
      return null;
    }
    const stats = fs.statSync(logPath);
    if (stats.size === 0) return null;
    const bytesToRead = Math.min(maxBytes, stats.size);
    const buffer = Buffer.alloc(bytesToRead);
    const fd = fs.openSync(logPath, 'r');
    try {
      fs.readSync(fd, buffer, 0, bytesToRead, stats.size - bytesToRead);
    } finally {
      fs.closeSync(fd);
    }
    return buffer.toString('utf8');
  } catch {
    return null;
  }
}

/**
 * Poll GraphQL with generic query until condition is met
 * Optional exponential backoff and log dumping on timeout
 */
export async function pollGraphQL<T>(
  url: string,
  query: string,
  variables: Record<string, any>,
  extractFn: (data: any) => T | null,
  options: { maxAttempts?: number; delayMs?: number; exponentialBackoff?: boolean } = {}
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 20;
  const baseDelayMs = options.delayMs ?? 1500;
  const useExponentialBackoff = options.exponentialBackoff ?? false;
  let lastResult: any = null;
  let lastError: string | null = null;

  for (let i = 0; i < maxAttempts; i++) {
    const delayMs =
      i === 0
        ? 0
        : useExponentialBackoff
          ? Math.min(baseDelayMs * Math.pow(1.5, i - 1), 10_000)
          : baseDelayMs;
    if (delayMs > 0) {
      await new Promise((r) => setTimeout(r, delayMs));
    }

    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query, variables })
      });
      if (!resp.ok) {
        lastError = `HTTP ${resp.status}`;
        continue;
      }
      const jr = await resp.json();
      lastResult = jr;
      const result = extractFn(jr);
      if (result !== null) return result;
    } catch (err) {
      lastError = err instanceof Error ? err.message : 'network_error';
    }
  }

  let detail = '';
  if (lastResult) {
    try {
      const resultStr = JSON.stringify(lastResult);
      detail = ` Last result: ${resultStr.slice(0, 500)}${resultStr.length > 500 ? '...' : ''}`;
    } catch {
      detail = ' Last result: [unserializable]';
    }
  } else if (lastError) {
    detail = ` Last error: ${lastError}`;
  }

  const ponderTail = readPonderLogTail();
  const logDetail = ponderTail ? `\n--- Ponder log tail ---\n${ponderTail}` : '';

  throw new Error(`Polling timed out after ${maxAttempts} attempts.${detail}${logDetail}`);
}

/**
 * Wait for job definition to be indexed
 */
export async function waitForJobIndexed(
  gqlUrl: string,
  jobDefinitionId: string,
  options?: { maxAttempts?: number; delayMs?: number }
): Promise<any> {
  const query = 'query($id:String!){ jobDefinition(id:$id){ id name enabledTools blueprint sourceRequestId sourceJobDefinitionId codeMetadata } }';
  return pollGraphQL(
    gqlUrl,
    query,
    { id: jobDefinitionId },
    (jr) => jr?.data?.jobDefinition?.id ? jr.data.jobDefinition : null,
    options
  );
}

/**
 * Wait for request to be indexed
 */
export async function waitForRequestIndexed(
  gqlUrl: string,
  requestId: string,
  options?: {
    maxAttempts?: number;
    delayMs?: number;
    exponentialBackoff?: boolean;
    predicate?: (request: {
      id: string;
      jobDefinitionId?: string | null;
      ipfsHash?: string | null;
      sourceRequestId?: string | null;
      sourceJobDefinitionId?: string | null;
      jobName?: string | null;
      enabledTools?: unknown;
    }) => boolean;
  }
): Promise<any> {
  const query =
    'query($id:String!){ request(id:$id){ id jobDefinitionId ipfsHash sourceRequestId sourceJobDefinitionId jobName enabledTools } }';
  const { predicate, ...pollOptions } = options ?? {};

  const finalOptions = {
    maxAttempts: pollOptions.maxAttempts ?? 20,
    delayMs: pollOptions.delayMs ?? 1500,
    exponentialBackoff: pollOptions.exponentialBackoff ?? false,
    ...pollOptions,
  };

  return pollGraphQL(
    gqlUrl,
    query,
    { id: requestId },
    (jr) => {
      const req = jr?.data?.request;
      if (!(req?.id && req?.ipfsHash)) {
        return null;
      }
      if (predicate && !predicate(req)) {
        return null;
      }
      return req;
    },
    finalOptions
  );
}

/**
 * Wait for delivery to be indexed
 */
export async function waitForDelivery(
  gqlUrl: string,
  requestId: string,
  options?: { maxAttempts?: number; delayMs?: number }
): Promise<any> {
  const query = 'query($id:String!){ delivery(id:$id){ id requestId ipfsHash transactionHash blockTimestamp } }';
  return pollGraphQL(
    gqlUrl,
    query,
    { id: requestId },
    (jr) => {
      const delivery = jr?.data?.delivery;
      return (delivery?.id && delivery?.ipfsHash && delivery?.transactionHash) ? delivery : null;
    },
    options
  );
}

/**
 * Wait for artifact to be indexed
 */
export async function waitForArtifact(
  gqlUrl: string,
  artifactId: string,
  options?: { maxAttempts?: number; delayMs?: number }
): Promise<any> {
  const query = 'query($id:String!){ artifact(id:$id){ id requestId name topic cid contentPreview } }';
  return pollGraphQL(
    gqlUrl,
    query,
    { id: artifactId },
    (jr) => jr?.data?.artifact?.id ? jr.data.artifact : null,
    options
  );
}

/**
 * Wait for message to be indexed
 */
export async function waitForMessage(
  gqlUrl: string,
  jobDefinitionId: string,
  expectedContent: string,
  options?: { maxAttempts?: number; delayMs?: number }
): Promise<any> {
  const query = 'query($to:String!){ messages(where:{to:$to}){ items { id content to sourceJobDefinitionId requestId blockTimestamp } } }';
  return pollGraphQL(
    gqlUrl,
    query,
    { to: jobDefinitionId },
    (jr) => {
      const messages = jr?.data?.messages?.items || [];
      return messages.find((m: any) => m.content === expectedContent) || null;
    },
    options
  );
}

/**
 * Create a test job with simplified parameters
 */
export async function createTestJob(params: {
  objective: string;
  context: string;
  acceptanceCriteria: string;
  jobName?: string;
  enabledTools?: string[];
  instructions?: string;
  deliverables?: string;
  constraints?: string;
  message?: string;
  sourceRequestId?: string;
  sourceJobDefinitionId?: string;
  blueprint?: string;
}): Promise<{ jobDefId: string; requestId: string; dispatchResult: any }> {
  const jobName = params.jobName ?? `test-job-${Date.now()}-${randomUUID().slice(0, 6)}`;
  const enabledTools = params.enabledTools ?? ['create_artifact'];

  // Generate a minimal blueprint if not provided
  const blueprint = params.blueprint ?? JSON.stringify({
    assertions: [{
      id: 'TEST-001',
      assertion: 'Complete the assigned task successfully',
      examples: {
        do: ['Follow instructions carefully', 'Validate output before submission'],
        dont: ['Skip validation steps', 'Ignore acceptance criteria']
      },
      commentary: 'Default test blueprint for automated test jobs'
    }]
  });

  // Call dispatch_new_job through MCP protocol
  const client = getMcpClient();
  const dispatchRes = await client.callTool('dispatch_new_job', {
    objective: params.objective,
    context: params.context,
    instructions: params.instructions,
    acceptanceCriteria: params.acceptanceCriteria,
    deliverables: params.deliverables,
    constraints: params.constraints,
    jobName,
    enabledTools,
    blueprint,
    message: params.message,
    sourceRequestId: params.sourceRequestId,
    sourceJobDefinitionId: params.sourceJobDefinitionId,
  });

  const parsed = parseToolText(dispatchRes);
  if (!parsed?.meta?.ok) {
    throw new Error(`Failed to create test job: ${JSON.stringify(parsed)}`);
  }

  const data = parsed.data || {};
  const requestId = data.request_ids?.[0];
  const jobDefId = data.jobDefinitionId;

  if (!requestId || !jobDefId) {
    throw new Error('Missing requestId or jobDefId in dispatch response');
  }

  const txHash = data.transaction_hash ?? data.transactionHash ?? null;
  const requestIdPreview = typeof requestId === 'string' ? `${requestId.slice(0, 10)}...` : String(requestId);
  if (txHash) {
    console.log('[dispatch] Created request', requestIdPreview, 'tx', txHash);
  } else {
    console.warn('[dispatch] Created request without transaction hash', requestIdPreview);
  }

  return { jobDefId, requestId, dispatchResult: parsed };
}

/**
 * Create a temporary .operate directory with test configuration
 */
function createTestOperateDir(): string {
  const suiteIdentifier = process.env.E2E_SUITE_ID || `pid-${process.pid}`;
  const testOperateDir = path.join(tmpdir(), `jinn-operate-test-${suiteIdentifier}`);

  // Clean up any existing test directory
  if (fs.existsSync(testOperateDir)) {
    fs.rmSync(testOperateDir, { recursive: true, force: true });
  }

  // Create directory structure
  const servicesDir = path.join(testOperateDir, 'services');
  const keysDir = path.join(testOperateDir, 'keys');
  const serviceId = 'sc-test-service';
  const serviceDir = path.join(servicesDir, serviceId);
  fs.mkdirSync(serviceDir, { recursive: true });
  fs.mkdirSync(keysDir, { recursive: true });

  // Create minimal config.json with Safe address from .env.test
  const config = {
    version: 8,
    service_config_id: serviceId,
    home_chain: "base",
    chain_configs: {
      base: {
        chain_data: {
          multisig: process.env.MECH_SAFE_ADDRESS || null,
          instances: [process.env.MECH_ADDRESS || '0x0000000000000000000000000000000000000000']
        }
      }
    }
  };

  fs.writeFileSync(
    path.join(serviceDir, 'config.json'),
    JSON.stringify(config, null, 2)
  );

  // Create private key file if MECH_PRIVATE_KEY is set
  if (process.env.MECH_PRIVATE_KEY && process.env.MECH_ADDRESS) {
    const keyFile = path.join(keysDir, process.env.MECH_ADDRESS);
    const keyData = { private_key: process.env.MECH_PRIVATE_KEY };
    fs.writeFileSync(keyFile, JSON.stringify(keyData, null, 2));
  }

  return testOperateDir;
}

// Registry of active worker processes for cleanup
const activeWorkerProcesses = new Set<ResultPromise>();

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
 */
export async function runWorkerOnce(
  targetRequestId: string,
  options: {
    gqlUrl: string;
    controlApiUrl?: string;
    model?: string;
    timeout?: number;
  }
): Promise<ResultPromise> {
  const env: any = { ...process.env };
  env.PONDER_GRAPHQL_URL = options.gqlUrl;
  env.CONTROL_API_URL = options.controlApiUrl ?? 'http://localhost:4001/graphql';
  env.USE_CONTROL_API = 'true';
  env.MECH_MODEL = options.model ?? 'gemini-2.5-pro';
  env.MECH_TARGET_REQUEST_ID = targetRequestId;
  console.log('[runWorkerOnce] launching worker', {
    requestId: targetRequestId,
    gqlUrl: env.PONDER_GRAPHQL_URL,
    controlApiUrl: env.CONTROL_API_URL,
  });

  if (!env.GITHUB_REPOSITORY && process.env.TEST_GITHUB_REPO) {
    const repoSlug = parseRepoSlug(process.env.TEST_GITHUB_REPO);
    if (repoSlug) {
      env.GITHUB_REPOSITORY = repoSlug;
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

  // Run worker CLI with --single so it exits after processing the target request.
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

/**
 * Assert artifact exists with expected metadata
 */
export async function assertArtifactExists(
  gqlUrl: string,
  requestId: string,
  expectedTopic: string,
  expectedName?: string
): Promise<any> {
  const artifact = await waitForArtifact(gqlUrl, `${requestId}:0`, { maxAttempts: 30, delayMs: 4000 });

  if (!artifact) {
    throw new Error(`Artifact not found for request ${requestId}`);
  }
  if (artifact.topic !== expectedTopic) {
    throw new Error(`Expected topic ${expectedTopic}, got ${artifact.topic}`);
  }
  if (expectedName && artifact.name !== expectedName) {
    throw new Error(`Expected name ${expectedName}, got ${artifact.name}`);
  }

  return artifact;
}

/**
 * Test infrastructure context - shared across all e2e tests via global setup
 */
export interface SharedTestInfrastructure {
  gqlUrl: string;
  controlUrl: string;
  vnetId: string;
}

/**
 * Get shared test infrastructure URLs from environment (set by global setup)
 */
export function getSharedInfrastructure(): SharedTestInfrastructure {
  const gqlUrl = process.env.E2E_GQL_URL;
  const controlUrl = process.env.E2E_CONTROL_URL;
  const vnetId = process.env.E2E_VNET_ID;

  if (!gqlUrl || !controlUrl || !vnetId) {
    throw new Error(
      'Shared infrastructure not initialized. ' +
      'Make sure vitest.config.ts has globalSetup: "./tests/e2e/setup.ts"'
    );
  }

  return { gqlUrl, controlUrl, vnetId };
}

/**
 * Reset test environment state between tests to prevent leakage
 * Call this in beforeEach() to ensure clean state
 *
 * NOTE: Does NOT disconnect/reconnect MCP client to avoid breaking active connections.
 * Tests that modify env vars and need MCP to see them should disconnect/reconnect manually.
 */
export function resetTestEnvironment(): void {
  // Clear lineage context that may have been set by previous tests
  delete process.env.JINN_REQUEST_ID;
  delete process.env.JINN_JOB_DEFINITION_ID;

  // Note: MCP client is intentionally left connected and shared across tests.
  // This avoids breaking connections during test execution.
  // Tests that set env vars for MCP must manually disconnect/reconnect.
}
