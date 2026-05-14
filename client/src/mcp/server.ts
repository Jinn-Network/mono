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
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { Store } from '../store/store.js';
import { createCorpus, type Corpus } from '../corpus/index.js';
import { createHttpDiscoveryAPI } from '../discovery/http.js';
import { handleInspectRecord, handleSearchRecords, type InspectRecordArgs } from './search-records.js';
import { handleAcquireArtifact } from './acquire-artifact.js';
import { SOLVER_TYPE_PAYLOADS } from '../types/payloads/index.js';
import { CanonicalRoleSchema, normalizeEnvelopeRole } from '../types/envelope.js';

const server = new McpServer({
  name: 'jinn-client',
  version: '0.1.0',
});

const metadataValueSchema = z.union([z.string(), z.number(), z.boolean()]);
const artifactSourceSchema = z.object({
  kind: z.literal('ipfs'),
  cid: z.string().min(1),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  encoding: z.literal('jinn.artifact.donation.v1'),
});

// Read task from env vars (passed by ClaudeRunner)
const task = {
  id: process.env['DESIRED_STATE_ID'] ?? '',
  description: process.env['DESIRED_STATE_DESCRIPTION'] ?? '',
  context: process.env['DESIRED_STATE_CONTEXT']
    ? JSON.parse(process.env['DESIRED_STATE_CONTEXT']) as Record<string, unknown>
    : undefined,
  role: process.env['DESIRED_STATE_ROLE'] ?? '',
  solverType: process.env['DESIRED_STATE_SOLVER_TYPE'] ?? '',
  restorationRequestId: process.env['RESTORATION_REQUEST_ID'] ?? '',
};

const workingDir = process.env['JINN_WORKING_DIR'] ?? process.env['WORKING_DIR'] ?? '';

const requestId = process.env['REQUEST_ID'] ?? '';
const storePath = process.env['STORE_PATH'] ?? '';
const store = storePath ? new Store(storePath) : null;
const daemonApiUrl = process.env['DAEMON_API_URL'] ?? '';
// Bearer token for daemon API cost-mutating routes. Empty string when
// unset (e.g. legacy harness wiring) — the daemon will respond 401.
const daemonApiToken = process.env['DAEMON_API_TOKEN'] ?? '';

// ── Corpus ──────────────────────────────────────────────────────────────────
// Build a read-only corpus capability when the daemon supplied the keyless
// URLs. The MCP subprocess gets only `query` and `fetchManifest`; `read`,
// `acquire`, and `acquireBySha256` are NOT exposed here, so discovery and
// inspection can fetch manifests but cannot trigger x402/payment or artifact
// byte acquisition. `acquire_artifact` proxies to the daemon over
// DAEMON_API_URL (which holds the agent EOA private key in-process). See spec
// §4.
//
// `signer.privateKey` and `selfSafeAddress` are required by CorpusOptions
// but unused by corpus.query/fetchManifest. Placeholder values are confined
// to this closure and never escape via the returned object.
function buildReadOnlyCorpus(): Pick<Corpus, 'query' | 'fetchManifest'> | null {
  if (!store) return null;
  // Discovery config: prefer JINN_DISCOVERY_URL (Ponder indexer) over the
  // legacy JINN_CORPUS_SUBGRAPH_URL. JINN_DISCOVERY_MODE defaults to 'http'
  // when a URL is present, 'onchain' otherwise.
  const discoveryUrl = process.env['JINN_DISCOVERY_URL'] ?? '';
  const discoveryMode = process.env['JINN_DISCOVERY_MODE'] ?? (discoveryUrl ? 'http' : 'onchain');
  const ipfsGatewayUrl = process.env['JINN_CORPUS_IPFS_GATEWAY_URL'] ?? '';
  const rpcUrl = process.env['JINN_CORPUS_RPC_URL'] ?? '';
  const chainIdRaw = process.env['JINN_CORPUS_CHAIN_ID'] ?? '';
  const chainId = chainIdRaw ? Number.parseInt(chainIdRaw, 10) : undefined;
  const identityRegistryAddress = process.env['JINN_CORPUS_IDENTITY_REGISTRY_ADDRESS'] ?? '';
  const fromBlockRaw = process.env['JINN_CORPUS_FROM_BLOCK'] ?? '';
  const fromBlock = fromBlockRaw ? Number.parseInt(fromBlockRaw, 10) : undefined;
  const hasOnchainCorpus = Boolean(rpcUrl && chainId && identityRegistryAddress);
  const hasDiscovery = Boolean(discoveryUrl && discoveryMode === 'http');
  if (!ipfsGatewayUrl || (!hasDiscovery && !hasOnchainCorpus)) {
    return null;
  }

  // Build a DiscoveryAPI from the discovery env when a URL is available.
  const discovery = hasDiscovery
    ? createHttpDiscoveryAPI({ url: discoveryUrl, fetchImpl: globalThis.fetch })
    : undefined;

  const full = createCorpus({
    ...(discovery ? { discovery } : {}),
    ipfsGatewayUrl,
    store,
    signer: { privateKey: '0x0' },
    selfSafeAddress: '0x0000000000000000000000000000000000000000',
    ...(hasOnchainCorpus
      ? {
          onchain: {
            rpcUrl,
            chainId: chainId!,
            identityRegistryAddress: identityRegistryAddress as `0x${string}`,
            ...(fromBlock !== undefined ? { fromBlock } : {}),
          },
        }
      : {}),
  });
  return {
    query: full.query.bind(full),
    fetchManifest: full.fetchManifest.bind(full),
  };
}
const corpus = buildReadOnlyCorpus();

/**
 * Format a structured error response for an MCP tool call. The body is a
 * JSON-encoded object so callers can mechanically detect failure and
 * inspect the kind / details, rather than parsing free-form prose.
 */
function mcpError(detail: Record<string, unknown>): {
  content: Array<{ type: 'text'; text: string }>;
} {
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({ ok: false, error: detail }),
      },
    ],
  };
}

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
  'submit_typed_payload',
  'Submit the result of the active Task as a typed structured payload. Validated against the SolverNet contract\'s schema for this task\'s (solverType, role) pair before being persisted; on validation failure, the Zod error tree is returned so the agent can correct and retry. On success, the validated payload is persisted to <WORKING_DIR>/.execute/solution-payload.json for the daemon harness to read post-execution. Use this for all SolverNets with typed payload schemas (prediction.v1, swe-rebench-v2.v1, etc.); use submit_restoration_result for free-form text artifacts.',
  {
    payload: z
      .record(z.unknown())
      .describe(
        'Typed payload object. The required shape is defined by the active SolverNet contract — check the contract\'s solution / verdict schema for the field set.',
      ),
  },
  async ({ payload }) => {
    const role = task.role === 'evaluation' ? 'verdict' : 'solution';
    if (!task.solverType) {
      return mcpError({
        kind: 'missing_solver_type',
        message:
          'DESIRED_STATE_SOLVER_TYPE not set in env. The harness adapter spawning this MCP server must inject it; submit_typed_payload cannot validate without knowing the SolverNet contract.',
      });
    }
    const bucket = SOLVER_TYPE_PAYLOADS[task.solverType];
    if (!bucket) {
      return mcpError({
        kind: 'unknown_solver_type',
        message: `No typed payload schema registered for solverType=${task.solverType}. submit_restoration_result still works for free-form artifacts.`,
        solverType: task.solverType,
      });
    }
    const schema = bucket[normalizeEnvelopeRole(role)];
    if (!schema) {
      return mcpError({
        kind: 'unknown_role',
        message: `No ${role} schema registered for solverType=${task.solverType}.`,
        solverType: task.solverType,
        role,
      });
    }
    const parsed = schema.safeParse(payload);
    if (!parsed.success) {
      return mcpError({
        kind: 'schema_validation_failed',
        message: `Payload failed validation against ${task.solverType}/${role} schema. Inspect issues[] and retry.`,
        solverType: task.solverType,
        role,
        issues: parsed.error.issues,
      });
    }

    if (!workingDir) {
      return mcpError({
        kind: 'missing_working_dir',
        message:
          'JINN_WORKING_DIR / WORKING_DIR not set in env. Cannot persist the validated payload.',
      });
    }

    const dir = join(workingDir, '.execute');
    await mkdir(dir, { recursive: true });
    const path = join(dir, 'solution-payload.json');
    await writeFile(path, JSON.stringify(parsed.data, null, 2));
    console.error(
      `[mcp] submit_typed_payload accepted ${task.solverType}/${role} payload → ${path}`,
    );
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            accepted: true,
            solverType: task.solverType,
            role,
            persistedTo: path,
          }),
        },
      ],
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
  'search_records',
  'Search local and network corpus records. Returns lightweight record refs, envelope refs, artifact refs, source, access, and price metadata. This tool is read-only and never acquires artifact bytes.',
  {
    solverType: z.string().optional().describe('SolverType filter, e.g. "prediction.v1"'),
    artifactType: z.string().optional().describe('Artifact type filter, e.g. "output.prediction.v1"'),
    taskCid: z.string().optional().describe('Filter to a specific task CID'),
    role: z.preprocess(normalizeEnvelopeRole, CanonicalRoleSchema).optional().describe('Envelope role filter'),
    taskId: z.string().optional().describe('Runtime task id filter for local envelope projections'),
    requestId: z.string().optional().describe('On-chain request id filter'),
    participant: z.object({
      safeAddress: z.string().optional().describe('Participant Safe address filter'),
      agentEoa: z.string().optional().describe('Participant agent EOA filter for local envelope projections'),
    }).optional().describe('Participant identity filters'),
    metadata: z.record(metadataValueSchema).optional().describe('Exact metadata key/value filters for local envelope projections'),
    evidenceTier: z.enum(['self-signed', 'committed', 'attested']).optional(),
    generatedAfter: z.number().int().optional().describe('Unix seconds — only manifests published after this time'),
    generatedBefore: z.number().int().optional().describe('Unix seconds — only manifests published before this time'),
    limit: z.number().int().optional().describe('Max results (default 50)'),
  },
  async (args) => {
    if (!store) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ error: 'no store configured', records: [] }) }],
      };
    }
    const out = await handleSearchRecords(corpus, store, args);
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(out) }],
    };
  },
);

server.tool(
  'inspect_record',
  'Inspect a local or network corpus record by record, envelope, projection, or artifact ref. Returns index-card metadata and acquisition costs without acquiring artifact bytes.',
  {
    ref: z.string().optional().describe('Any record/envelope/projection/artifact ref returned by search_records'),
    recordRef: z.string().optional(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
    envelopeCid: z.string().optional(),
    manifestCid: z.string().optional(),
    projectionRef: z.string().optional(),
    envelopeRef: z.object({
      manifestCid: z.string(),
      manifestHash: z.string(),
      operator: z.object({
        agentId: z.string(),
        safeAddress: z.string(),
      }),
      evidenceTier: z.enum(['self-signed', 'committed', 'attested', 'unknown']),
      publishedAt: z.number(),
    }).optional(),
  },
  async (args) => {
    if (!store) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ error: 'no store configured', record: null, projections: [], artifacts: [] }) }],
      };
    }
    const out = await handleInspectRecord(corpus, store, args as InspectRecordArgs);
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
    ownerSafe: z.string().optional(),
    sources: z.array(artifactSourceSchema).optional(),
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
          fetchedAt: out.fetchedAt,
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
