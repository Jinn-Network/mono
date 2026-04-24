/**
 * MCP server for jinn-client — exposes tools to agent subprocesses.
 *
 * Spawned by ClaudeRunner as a subprocess via StdioServerTransport.
 * Receives context via env vars:
 *   DESIRED_STATE_ID          — ID of the current desired state
 *   DESIRED_STATE_DESCRIPTION — Human-readable description
 *   DESIRED_STATE_CONTEXT     — JSON context (optional)
 *   REQUEST_ID                — On-chain request ID
 *   RESTORATION_DELIVERY_DATA — JSON delivery data (evaluation requests only)
 *
 * Usage: yarn exec tsx src/mcp/server.ts
 */

import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { Store } from '../store/store.js';

const server = new McpServer({
  name: 'jinn-client',
  version: '0.1.0',
});

// Read desired state from env vars (passed by ClaudeRunner)
const restorationJob = {
  id: process.env['DESIRED_STATE_ID'] ?? '',
  description: process.env['DESIRED_STATE_DESCRIPTION'] ?? '',
  context: process.env['DESIRED_STATE_CONTEXT']
    ? JSON.parse(process.env['DESIRED_STATE_CONTEXT']) as Record<string, unknown>
    : undefined,
  type: process.env['DESIRED_STATE_TYPE'] ?? '',
  restorationRequestId: process.env['RESTORATION_REQUEST_ID'] ?? '',
};

const requestId = process.env['REQUEST_ID'] ?? '';
const storePath = process.env['STORE_PATH'] ?? '';
const store = storePath ? new Store(storePath) : null;
const daemonApiUrl = process.env['DAEMON_API_URL'] ?? '';

// ── Tools ────────────────────────────────────────────────────────────────────

server.tool(
  'get_desired_state',
  'Get the current desired state that needs to be restored',
  {},
  async () => ({
    content: [{
      type: 'text' as const,
      text: JSON.stringify({
        id: restorationJob.id,
        description: restorationJob.description,
        context: restorationJob.context,
        type: restorationJob.type || undefined,
        restorationRequestId: restorationJob.restorationRequestId || undefined,
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
    const isEvaluation = restorationJob.type === 'evaluation';
    const resultTag = isEvaluation ? 'evaluation-verdict' : 'restoration-result';
    const id = randomUUID();

    const artifact = {
      id,
      desiredStateId: restorationJob.id,
      requestId,
      title: `${resultTag}: ${description.slice(0, 80)}`,
      content: data ?? description,
      tags: [resultTag, success ? 'success' : 'failure'],
      outcome: (success ? 'SUCCESS' : 'FAILURE') as 'SUCCESS' | 'FAILURE' | 'UNKNOWN',
    };

    // Publish via daemon API if available, otherwise direct store write
    if (daemonApiUrl) {
      try {
        const response = await fetch(`${daemonApiUrl}/artifacts`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(artifact),
        });
        if (!response.ok) {
          console.error(`[mcp] Failed to POST artifact to daemon: ${response.status}`);
        }
      } catch (err) {
        console.error(`[mcp] Failed to POST artifact to daemon:`, err);
      }
    } else if (store) {
      store.insertArtifact(artifact);
    }

    console.error(`[mcp] Result published as artifact: ${id} [${resultTag}]`);
    return {
      content: [{ type: 'text' as const, text: JSON.stringify({ submitted: true, id, tag: resultTag }) }],
    };
  },
);

server.tool(
  'get_restoration_delivery',
  'Get the restoration result that needs to be evaluated (only available for evaluation requests)',
  {},
  async () => {
    const raw = process.env['RESTORATION_DELIVERY_DATA'];
    if (!raw) {
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ error: 'Not an evaluation request or no delivery data available' }),
        }],
      };
    }
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          restorationRequestId: restorationJob.restorationRequestId,
          deliveryData: JSON.parse(raw),
        }),
      }],
    };
  },
);

server.tool(
  'publish_artifact',
  'Publish a knowledge artifact for future agents to reference',
  {
    title: z.string().describe('Short title for the artifact'),
    content: z.string().describe('The artifact content (text, JSON, etc)'),
    tags: z.array(z.string()).optional().describe('Tags for categorization'),
    outcome: z.enum(['SUCCESS', 'FAILURE', 'UNKNOWN']).optional().describe('Outcome of the work this artifact relates to'),
  },
  async ({ title, content, tags, outcome }) => {
    const id = randomUUID();
    if (store) {
      store.insertArtifact({
        id,
        desiredStateId: restorationJob.id,
        requestId,
        title,
        content,
        tags: tags ?? [],
        outcome: outcome ?? 'UNKNOWN',
      });
    }
    console.error(`[mcp] Artifact published: ${id} — ${title}`);
    return {
      content: [{ type: 'text' as const, text: JSON.stringify({ published: true, id, title }) }],
    };
  },
);

server.tool(
  'search_artifacts',
  'Search previously published knowledge artifacts',
  {
    tags: z.array(z.string()).optional().describe('Filter by tags (e.g. ["restoration-result", "success"])'),
    outcome: z.enum(['SUCCESS', 'FAILURE', 'UNKNOWN']).optional().describe('Filter by outcome'),
    requestId: z.string().optional().describe('Filter by on-chain request ID'),
    desiredStateId: z.string().optional().describe('Filter by desired state ID'),
    after: z.string().optional().describe('Only return artifacts created after this ISO timestamp'),
    before: z.string().optional().describe('Only return artifacts created before this ISO timestamp'),
    limit: z.number().optional().describe('Max results (default 50)'),
  },
  async ({ tags, outcome, requestId, desiredStateId, after, before, limit }) => {
    if (!store) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ error: 'No store configured', results: [] }) }],
      };
    }
    const results = store.searchArtifacts({ tags, outcome, requestId, desiredStateId, after, before, limit });
    return {
      content: [{ type: 'text' as const, text: JSON.stringify({ results }) }],
    };
  },
);

server.tool(
  'acquire_artifact',
  'Fetch the content of a remote artifact from a peer node',
  {
    id: z.string().describe('Artifact ID to acquire'),
  },
  async ({ id }) => {
    if (!store) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ error: 'No store configured' }) }],
      };
    }

    // Check if content is already cached locally
    const cached = store.getArtifactContent(id);
    if (cached) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ id, content: cached, cached: true }) }],
      };
    }

    // Check if we know where to fetch it
    const remoteInfo = store.getRemoteArtifactInfo(id);
    if (!remoteInfo) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ error: `Artifact ${id} not found (no remote info)` }) }],
      };
    }

    // Fetch from peer
    try {
      const response = await fetch(`${remoteInfo.endpoint}/artifacts/${id}/content`);
      if (!response.ok) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: `Fetch failed: ${response.status}` }) }],
        };
      }
      const data = await response.json() as { content: string };
      store.cacheRemoteContent(id, data.content);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ id, content: data.content, cached: false }) }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ error: `Fetch error: ${err instanceof Error ? err.message : String(err)}` }) }],
      };
    }
  },
);

// ── Start ────────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
