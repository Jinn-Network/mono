/**
 * Shared stdio MCP-server plumbing for the claude-mcp-prediction* impls.
 *
 * Both venues' `startMcpServer` build a venue publicClient + tool array, then
 * register the tools on an `McpServer` over `StdioServerTransport` and keep the
 * process alive until stdin closes. Only the venue-specific publicClient +
 * tool-factory + submission field names differ; those stay per-venue. The
 * register loop, transport connect, and stdin keepalive are unified here, along
 * with the JSONL submission appender the onSubmit closure uses.
 */

import { appendFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { z } from 'zod';

/** Minimal structural shape both venue tool-definition types satisfy. */
export interface StdioMcpTool {
  name: string;
  description: string;
  schema: z.ZodObject<z.ZodRawShape>;
  handler: (args: unknown) => Promise<{ content: { type: 'text'; text: string }[] }>;
}

export interface CreateStdioMcpServerOptions {
  serverName: string;
  version: string;
  tools: StdioMcpTool[];
}

/**
 * Append a submission record as a JSON line. The daemon tails this file across
 * the process boundary to detect the submit-tool call; each record is stamped
 * with a `ts`. This is the only IPC mechanism that survives the wrapper
 * subprocess boundary.
 */
export function appendSubmissionRecord(path: string, record: Record<string, unknown>): void {
  appendFileSync(path, JSON.stringify({ ts: Date.now(), ...record }) + '\n', { encoding: 'utf-8' });
}

/**
 * Register the given tools on a fresh stdio `McpServer` and keep the process
 * alive until stdin closes (Claude closes it at session end).
 */
export async function createStdioMcpServer(opts: CreateStdioMcpServerOptions): Promise<void> {
  const server = new McpServer({ name: opts.serverName, version: opts.version });

  // Same cast-around-MCP-index-signature pattern as hyperliquid's startMcpServer.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const registerTool = server.tool.bind(server) as (...args: any[]) => void;

  for (const tool of opts.tools) {
    const shape = (tool.schema as z.ZodObject<z.ZodRawShape>).shape ?? {};
    registerTool(tool.name, tool.description, shape, async (args: unknown) => tool.handler(args));
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Keep alive until stdin closes (Claude closes it at session end).
  await new Promise<void>((resolve) => {
    process.stdin.on('close', resolve);
    process.stdin.on('end', resolve);
  });
}
