/**
 * mock-agent.ts — Deterministic MCP client that acts as a mock LLM agent.
 *
 * Reads an MCP config file from --mcp-config, spawns the jinn-client MCP server
 * as a subprocess via StdioClientTransport, discovers tools, and executes
 * a deterministic sequence based on the request type.
 *
 * For restoration requests: produces a mock restoration result.
 * For evaluation requests: fetches the restoration context, produces a verdict.
 *
 * Args: -p <prompt> --mcp-config <path> [--allowedTools <filter>] [--model <model>]
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// ── Parse args ───────────────────────────────────────────────────────────────

const args = process.argv.slice(2);

function getArg(flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : undefined;
}

const prompt = getArg('-p');
const mcpConfigPath = getArg('--mcp-config');

if (!prompt) {
  process.stderr.write('mock-agent: no prompt provided (expected -p <prompt>)\n');
  process.exit(1);
}

if (!mcpConfigPath) {
  const descMatch = prompt.match(/Description:\s*(.+)/);
  const description = descMatch?.[1]?.trim() ?? 'unknown';
  process.stdout.write(JSON.stringify({
    protocol: 'jinn-client/v1',
    type: 'restoration-result',
    description,
    agent: 'mock-agent',
    success: true,
  }));
  process.exit(0);
}

// ── Read MCP config ──────────────────────────────────────────────────────────

interface McpServerDef {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

interface McpConfig {
  mcpServers: Record<string, McpServerDef>;
}

const fullConfigPath = resolve(mcpConfigPath);
const config = JSON.parse(readFileSync(fullConfigPath, 'utf-8')) as McpConfig;

const serverName = Object.keys(config.mcpServers)[0];
if (!serverName) {
  process.stderr.write('mock-agent: no MCP server found in config\n');
  process.exit(1);
}

const serverDef = config.mcpServers[serverName]!;
process.stderr.write(`[mock-agent] Connecting to MCP server '${serverName}'\n`);

// ── Spawn MCP server and connect ─────────────────────────────────────────────

const transport = new StdioClientTransport({
  command: serverDef.command,
  args: serverDef.args,
  env: { ...process.env, ...serverDef.env } as Record<string, string>,
});

const client = new Client({
  name: 'mock-agent',
  version: '0.0.1',
});

await client.connect(transport);

const { tools } = await client.listTools();
process.stderr.write(`[mock-agent] Discovered ${tools.length} tools\n`);

// ── Helper ───────────────────────────────────────────────────────────────────

async function callTool(name: string, toolArgs: Record<string, unknown>): Promise<string> {
  process.stderr.write(`[mock-agent] Calling: ${name}\n`);
  const result = await client.callTool({ name, arguments: toolArgs });
  const content = result.content as Array<{ type: string; text?: string }>;
  return content
    .filter((c) => c.type === 'text' && c.text)
    .map(c => c.text!)
    .join('\n');
}

// ── Get desired state ────────────────────────────────────────────────────────

const stateJson = await callTool('get_desired_state', {});
const state = JSON.parse(stateJson) as {
  id: string;
  description: string;
  requestId: string;
  type?: string;
  restorationRequestId?: string;
};

const isEvaluation = state.type === 'evaluation';
process.stderr.write(`[mock-agent] Request type: ${state.type || 'restoration'}\n`);

// ── Execute based on type ────────────────────────────────────────────────────

if (isEvaluation) {
  // ── Evaluation flow ──────────────────────────────────────────────────────
  // A real agent would:
  // 1. Fetch the restoration delivery from IPFS using restorationRequestId
  // 2. Read the original desired state description
  // 3. Compare: did the restoration achieve the desired state?
  // 4. Return a verdict

  await callTool('report_progress', {
    message: `Evaluating restoration ${state.restorationRequestId?.slice(0, 14)}... for: ${state.description}`,
  });

  // Mock evaluation: always succeeds (deterministic)
  // A real agent would do actual verification here
  const verdict = {
    protocol: 'jinn-client/v1',
    type: 'evaluation-verdict',
    desiredStateId: state.id,
    restorationRequestId: state.restorationRequestId,
    requestId: state.requestId,
    success: true,
    reason: `Mock evaluation: desired state "${state.description}" verified as restored`,
    evaluatedAt: new Date().toISOString(),
    agent: 'mock-agent',
  };

  await callTool('submit_restoration_result', {
    success: true,
    description: verdict.reason,
    data: JSON.stringify(verdict),
  });

  process.stdout.write(JSON.stringify(verdict));
  process.stderr.write('[mock-agent] Evaluation verdict delivered.\n');

} else {
  // ── Restoration flow ─────────────────────────────────────────────────────

  await callTool('report_progress', {
    message: `Restoring: ${state.description}`,
  });

  const result = {
    protocol: 'jinn-client/v1',
    type: 'restoration-result',
    desiredStateId: state.id,
    requestId: state.requestId,
    description: state.description,
    success: true,
    restoredAt: new Date().toISOString(),
    agent: 'mock-agent',
  };

  await callTool('submit_restoration_result', {
    success: true,
    description: `Mock restoration completed for: ${state.description}`,
    data: JSON.stringify(result),
  });

  process.stdout.write(JSON.stringify(result));
  process.stderr.write('[mock-agent] Restoration delivered.\n');
}

// ── Cleanup ──────────────────────────────────────────────────────────────────

await client.close();
process.exit(0);
