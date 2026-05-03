/**
 * MCP server for jinn-client — exposes tools to agent subprocesses.
 *
 * Spawned by ClaudeRunner as a subprocess via StdioServerTransport.
 * Receives Task context via env vars:
 *   DESIRED_STATE_ID          — Task ID
 *   DESIRED_STATE_DESCRIPTION — Human-readable task description
 *   DESIRED_STATE_CONTEXT     — JSON task context (optional)
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
import { createCorpus, type Corpus } from '../corpus/index.js';
import { handleSearchArtifactsOrLocalFallback } from './search-artifacts.js';
import { handleAcquireArtifact } from './acquire-artifact.js';

const server = new McpServer({
  name: 'jinn-client',
  version: '0.1.0',
});

// Read task from env vars (passed by ClaudeRunner)
const task = {
  id: process.env['DESIRED_STATE_ID'] ?? '',
  description: process.env['DESIRED_STATE_DESCRIPTION'] ?? '',
  context: process.env['DESIRED_STATE_CONTEXT']
    ? JSON.parse(process.env['DESIRED_STATE_CONTEXT']) as Record<string, unknown>
    : undefined,
  role: process.env['DESIRED_STATE_ROLE'] ?? '',
  restorationRequestId: process.env['RESTORATION_REQUEST_ID'] ?? '',
};

const requestId = process.env['REQUEST_ID'] ?? '';
const storePath = process.env['STORE_PATH'] ?? '';
const store = storePath ? new Store(storePath) : null;
const daemonApiUrl = process.env['DAEMON_API_URL'] ?? '';
// Bearer token for daemon API cost-mutating routes. Empty string when
// unset (e.g. legacy harness wiring) — the daemon will respond 401.
const daemonApiToken = process.env['DAEMON_API_TOKEN'] ?? '';

// ── Corpus ──────────────────────────────────────────────────────────────────
// Build a query-only corpus capability when the daemon supplied the keyless
// URLs. The MCP subprocess gets `Pick<Corpus, 'query'>` — `acquire` and
// `acquireBySha256` are NOT exposed here, so any future call site in this
// process structurally cannot reach into the signer. `acquire_artifact`
// proxies to the daemon over DAEMON_API_URL (which holds the agent EOA
// private key in-process). See spec §4.
//
// `signer.privateKey` and `selfSafeAddress` are required by CorpusOptions
// but unused by corpus.query. Placeholder values are confined to this
// closure and never escape via the returned object.
function buildCorpusQuery(): Pick<Corpus, 'query'> | null {
  if (!store) return null;
  const subgraphUrl = process.env['JINN_CORPUS_SUBGRAPH_URL'] ?? '';
  const ipfsGatewayUrl = process.env['JINN_CORPUS_IPFS_GATEWAY_URL'] ?? '';
  if (!subgraphUrl || !ipfsGatewayUrl) {
    return null;
  }
  const full = createCorpus({
    subgraphUrl,
    ipfsGatewayUrl,
    store,
    signer: { privateKey: '0x0' },
    selfSafeAddress: '0x0000000000000000000000000000000000000000',
  });
  return { query: full.query.bind(full) };
}
const corpus = buildCorpusQuery();

// ── Tools ────────────────────────────────────────────────────────────────────

server.tool(
  'get_task',
  // NOTE: Returns the RUNTIME shape (Task fields + attempt/request metadata),
  // NOT the signed wire format (SignedTaskV1). The signed Task, if present, was
  // uploaded to IPFS at job creation time and is referenced by the on-chain CID.
  // Claude receives this runtime shape to understand what objective to pursue —
  // it does not need to verify or re-sign the task envelope.
  'Get the current Task. Returns runtime Task context: id, description, role (restoration|evaluation), restorationRequestId, requestId, and optional context bag. This is the RUNTIME shape — not the signed task.v1 wire format.',
  {},
  async () => ({
    content: [{
      type: 'text' as const,
      text: JSON.stringify({
        id: task.id,
        description: task.description,
        context: task.context,
        role: task.role || undefined,
        restorationRequestId: task.restorationRequestId || undefined,
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
    const isEvaluation = task.role === 'evaluation';
    const resultTag = isEvaluation ? 'evaluation-verdict' : 'restoration-result';
    const id = randomUUID();

    const artifact = {
      id,
      taskId: task.id,
      requestId,
      title: `${resultTag}: ${description.slice(0, 80)}`,
      content: data ?? description,
      tags: [resultTag, success ? 'success' : 'failure'],
      outcome: (success ? 'SUCCESS' : 'FAILURE') as 'SUCCESS' | 'FAILURE' | 'UNKNOWN',
    };

    // Always write to the local store when available so ClaudeRunner can
    // synchronously read the submitted result before the engine packages the
    // marketplace delivery. The daemon API publish path is still used for
    // runtime notifications.
    if (store) {
      store.insertArtifact(artifact);
    }

    // Publish via daemon API if available.
    if (daemonApiUrl) {
      try {
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (daemonApiToken) headers['Authorization'] = `Bearer ${daemonApiToken}`;
        const response = await fetch(`${daemonApiUrl}/artifacts`, {
          method: 'POST',
          headers,
          body: JSON.stringify(artifact),
        });
        if (!response.ok) {
          console.error(`[mcp] Failed to POST artifact to daemon: ${response.status}`);
        }
      } catch (err) {
        console.error(`[mcp] Failed to POST artifact to daemon:`, err);
      }
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
          restorationRequestId: task.restorationRequestId,
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
        taskId: task.id,
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
  'Search the corpus for relevant past trajectories and artifacts. Returns local fast-path hits (own served + cached network) plus subgraph-indexed network manifests with their full envelopes.',
  {
    solverType: z.string().optional().describe('SolverType filter, e.g. "prediction.v1"'),
    artifactType: z.string().optional().describe('Artifact type filter, e.g. "output.prediction.v1"'),
    taskCid: z.string().optional().describe('Filter to a specific task CID'),
    evidenceTier: z.enum(['self-signed', 'committed', 'attested']).optional(),
    generatedAfter: z.number().int().optional().describe('Unix seconds — only manifests published after this time'),
    generatedBefore: z.number().int().optional().describe('Unix seconds — only manifests published before this time'),
    limit: z.number().int().optional().describe('Max results (default 50)'),
  },
  async (args) => {
    if (!store) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ error: 'no store configured', local: [], network: [] }) }],
      };
    }
    const out = await handleSearchArtifactsOrLocalFallback(corpus, store, args);
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(out) }],
    };
  },
);

server.tool(
  'acquire_artifact',
  'Fetch artifact bytes by sha256. Hits local-store (own served) and corpus cache fast paths first; proxies to the daemon for network fetches (the daemon owns the agent EOA private key for x402 payments). Returns base64-encoded bytes and the fetch source.',
  {
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    access: z.object({
      endpoint: z.string().url(),
      priceUsdc: z.string().regex(/^\d+(\.\d+)?$/),
    }),
    envelopeCid: z.string().optional(),
    artifactType: z.string().optional(),
  },
  async (args) => {
    if (!store) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ error: 'no store configured' }) }],
      };
    }
    const result = await handleAcquireArtifact(
      daemonApiUrl || undefined,
      store,
      args,
      daemonApiToken || undefined,
    );
    if (result.ok) {
      const out = result.content;
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({
          sha256: out.sha256,
          bytes: out.bytes.toString('base64'),
          artifactType: out.artifactType,
          source: out.source,
          paidAmountUsdc: out.paidAmountUsdc,
          ...(out.sourceOperator ? { sourceOperator: out.sourceOperator } : {}),
        }) }],
      };
    }
    // Structured failure — surface daemon-side reason verbatim so callers can
    // discriminate hash_mismatch (don't retry) vs origin_null (transient).
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          error: result.error,
          reason: result.reason,
          sha256: result.sha256,
          retryable: result.retryable,
          ...(result.message ? { message: result.message } : {}),
          ...(result.sourceOperator ? { sourceOperator: result.sourceOperator } : {}),
        }),
      }],
    };
  },
);

// ── Start ────────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
