/**
 * MCP server for jinn-client — exposes tools to agent subprocesses.
 *
 * Spawned by ClaudeRunner as a subprocess via StdioServerTransport.
 * Receives context via env vars:
 *   DESIRED_STATE_ID          — ID of the current desired state
 *   DESIRED_STATE_DESCRIPTION — Human-readable description
 *   DESIRED_STATE_CONTEXT     — JSON context (optional)
 *   REQUEST_ID                — On-chain request ID
 *
 * Usage: npx tsx src/mcp/server.ts
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({
  name: 'jinn-client',
  version: '0.1.0',
});

// Read desired state from env vars (passed by ClaudeRunner)
const desiredState = {
  id: process.env['DESIRED_STATE_ID'] ?? '',
  description: process.env['DESIRED_STATE_DESCRIPTION'] ?? '',
  context: process.env['DESIRED_STATE_CONTEXT']
    ? JSON.parse(process.env['DESIRED_STATE_CONTEXT']) as Record<string, unknown>
    : undefined,
  type: process.env['DESIRED_STATE_TYPE'] ?? '',
  restorationRequestId: process.env['RESTORATION_REQUEST_ID'] ?? '',
};

const requestId = process.env['REQUEST_ID'] ?? '';

// ── Tools ────────────────────────────────────────────────────────────────────

server.tool(
  'get_desired_state',
  'Get the current desired state that needs to be restored',
  {},
  async () => ({
    content: [{
      type: 'text' as const,
      text: JSON.stringify({
        id: desiredState.id,
        description: desiredState.description,
        context: desiredState.context,
        type: desiredState.type || undefined,
        restorationRequestId: desiredState.restorationRequestId || undefined,
        requestId,
      }),
    }],
  }),
);

server.tool(
  'report_progress',
  'Report progress on the restoration',
  { message: z.string().describe('Progress message') },
  async ({ message }) => {
    console.error(`[mcp] Progress: ${message}`);
    return {
      content: [{ type: 'text' as const, text: 'Progress reported' }],
    };
  },
);

server.tool(
  'submit_restoration_result',
  'Submit the result of a restoration attempt',
  {
    success: z.boolean().describe('Whether the restoration was successful'),
    description: z.string().describe('Description of what was done'),
    data: z.string().optional().describe('Result data or artifact content'),
  },
  async ({ success, description, data }) => {
    // Write result to stdout as JSON — ClaudeRunner captures this
    const result = {
      protocol: 'jinn-client/v1',
      type: 'restoration-result',
      requestId,
      desiredStateId: desiredState.id,
      success,
      description,
      data: data ?? description,
      completedAt: new Date().toISOString(),
    };
    // Use stderr for the structured result (stdout is for MCP protocol)
    console.error(`[mcp] Result: ${JSON.stringify(result)}`);
    return {
      content: [{ type: 'text' as const, text: JSON.stringify({ submitted: true, ...result }) }],
    };
  },
);

// ── Start ────────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
