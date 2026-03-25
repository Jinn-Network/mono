/**
 * mock-agent.ts — Deterministic MCP client that acts as a mock LLM agent.
 *
 * Reads an MCP config file from --mcp-config, spawns the jinn-client MCP server
 * as a subprocess via StdioClientTransport, discovers tools, and executes
 * a deterministic restoration sequence.
 *
 * Matches the protocol repo's mock-agent.ts pattern — the agent is a separate
 * process that interacts with the system via MCP tools, not inline code.
 *
 * Args: -p <prompt> --mcp-config <path> [--allowedTools <filter>] [--model <model>]
 *
 * Usage: npx tsx scripts/mock-agent.ts -p "prompt" --mcp-config /path/to/config.json
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
  // No MCP config — fall back to simple prompt-in/result-out mode
  // (backwards compatible with non-MCP usage)
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
process.stderr.write(`[mock-agent] Connecting to MCP server '${serverName}': ${serverDef.command} ${serverDef.args.join(' ')}\n`);

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
process.stderr.write('[mock-agent] Connected to MCP server\n');

// ── Discover tools ───────────────────────────────────────────────────────────

const { tools } = await client.listTools();
process.stderr.write(`[mock-agent] Discovered ${tools.length} tools: ${tools.map(t => t.name).join(', ')}\n`);

// ── Helper ───────────────────────────────────────────────────────────────────

async function callTool(name: string, toolArgs: Record<string, unknown>): Promise<string> {
  process.stderr.write(`[mock-agent] Calling tool: ${name}(${JSON.stringify(toolArgs)})\n`);
  const result = await client.callTool({ name, arguments: toolArgs });
  const content = result.content as Array<{ type: string; text?: string }>;
  const text = content
    .filter((c) => c.type === 'text' && c.text)
    .map(c => c.text!)
    .join('\n');
  process.stderr.write(`[mock-agent] Result: ${text.slice(0, 200)}\n`);
  return text;
}

// ── Execute deterministic restoration sequence ───────────────────────────────

// Step 1: Get desired state from MCP server
process.stderr.write('[mock-agent] Step 1: Getting desired state...\n');
const stateJson = await callTool('get_desired_state', {});
const state = JSON.parse(stateJson) as { id: string; description: string; requestId: string };

// Step 2: Report progress
process.stderr.write('[mock-agent] Step 2: Reporting progress...\n');
await callTool('report_progress', { message: `Starting restoration for: ${state.description}` });

// Step 3: Submit restoration result
process.stderr.write('[mock-agent] Step 3: Submitting result...\n');
await callTool('submit_restoration_result', {
  success: true,
  description: `Mock restoration completed for: ${state.description}`,
  data: JSON.stringify({
    protocol: 'jinn-client/v1',
    type: 'restoration-result',
    desiredStateId: state.id,
    requestId: state.requestId,
    restoredAt: new Date().toISOString(),
    agent: 'mock-agent',
  }),
});

// Step 4: Write final result to stdout (captured by ClaudeRunner)
const finalResult = JSON.stringify({
  protocol: 'jinn-client/v1',
  type: 'restoration-result',
  desiredStateId: state.id,
  description: state.description,
  success: true,
  agent: 'mock-agent',
});
process.stdout.write(finalResult);

process.stderr.write('[mock-agent] Restoration complete. Exiting.\n');

// ── Cleanup ──────────────────────────────────────────────────────────────────

await client.close();
process.exit(0);
