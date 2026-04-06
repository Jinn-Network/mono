/**
 * MCP client utilities for test environment
 * Migrated from tests/helpers/shared.ts
 */

import { randomUUID } from 'node:crypto';
import { execSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

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
      resolvedArgs = ['tsx', 'jinn-node/src/agent/mcp/server.ts'];
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
        resolvedArgs = ['tsx', 'jinn-node/src/agent/mcp/server.ts'];
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
      const psOutput = execSync('ps aux | grep "tsx.*jinn-node/src/agent/mcp/server.ts" | grep -v grep', { encoding: 'utf-8' }).trim();
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
 * Disconnect and cleanup the global MCP client instance
 * This forces the next getMcpClient() call to create a fresh subprocess
 */
export async function disconnectMcpClient(): Promise<void> {
  if (mcpClient) {
    await mcpClient.disconnect();
    mcpClient = null;
  }
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
 * Create a test job with simplified parameters
 * Uses MCP protocol to create real on-chain requests
 */
export async function createTestJob(params: {
  blueprint: string;
  jobName?: string;
  enabledTools?: string[];
  message?: string;
  sourceRequestId?: string;
  sourceJobDefinitionId?: string;
  dependencies?: string[];
}): Promise<{ jobDefId: string; requestId: string; dispatchResult: any }> {
  const jobName = params.jobName ?? `test-job-${Date.now()}-${randomUUID().slice(0, 6)}`;
  const enabledTools = params.enabledTools ?? ['create_artifact'];

  // Call dispatch_new_job through MCP protocol
  const client = getMcpClient();
  const dispatchRes = await client.callTool('dispatch_new_job', {
    blueprint: params.blueprint,
    jobName,
    enabledTools,
    message: params.message,
    sourceRequestId: params.sourceRequestId,
    sourceJobDefinitionId: params.sourceJobDefinitionId,
    dependencies: params.dependencies,
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
