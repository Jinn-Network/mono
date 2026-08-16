/**
 * acquire_artifact MCP tool handler.
 *
 * Tries fast paths in order before proxying to the daemon:
 *   1. served_artifacts (own published bytes)
 *   2. network_artifacts (previously fetched + cached; touches last_used_at)
 *   3. POST {daemonApiUrl}/v1/artifacts/acquire (daemon-side corpus runs the
 *      free origin fetch and owns the shared byte cache)
 *
 * Mirrors the daemon-side proxy precedent already used by
 * `submit_restoration_result` in mcp/server.ts. The MCP subprocess never
 * receives the agent EOA private key.
 *
 * Spec: spec/2026-04-30-phase-a-umbrella.md §4.2.
 */

import type { ArtifactContent } from '../corpus/index.js';
import type { Store } from '../store/store.js';
import type { ArtifactSource } from '../types/envelope.js';

export interface AcquireArtifactArgs {
  sha256: string;
  access: { endpoint: string; priceUsdc: string };
  envelopeCid?: string;
  artifactType?: string;
  sources?: ArtifactSource[];
  ownerSafe?: string;
}

export type AcquireArtifactResult =
  | { ok: true; content: ArtifactContent }
  | {
      ok: false;
      error: 'acquire_failed';
      reason: string;
      sha256: string;
      retryable: boolean;
      message?: string;
      sourceOperator?: string;
    };

export async function handleAcquireArtifact(
  daemonApiUrl: string | undefined,
  store: Store,
  args: AcquireArtifactArgs,
  daemonApiToken?: string,
): Promise<AcquireArtifactResult> {
  const own = store.getServedArtifact(args.sha256);
  if (own) {
    return {
      ok: true,
      content: {
        sha256: args.sha256,
        bytes: own.content,
        artifactType: own.artifactType,
        source: 'self-store',
        paidAmountUsdc: '0',
        fetchedAt: own.createdAt,
      },
    };
  }
  const cached = store.getNetworkArtifact(args.sha256);
  if (cached) {
    store.touchNetworkArtifactUsage(args.sha256, new Date().toISOString());
    return {
      ok: true,
      content: {
        sha256: args.sha256,
        bytes: cached.content,
        artifactType: cached.artifactType,
        source: 'cache',
        paidAmountUsdc: '0',
        fetchedAt: cached.fetchedAt,
        sourceOperator: cached.sourceOperator ?? undefined,
      },
    };
  }

  if (!daemonApiUrl) {
    return {
      ok: false,
      error: 'acquire_failed',
      reason: 'daemon_unreachable',
      sha256: args.sha256,
      retryable: false,
      message: 'DAEMON_API_URL not configured; daemon-side corpus is required for network fetches.',
    };
  }

  // Proxy to daemon. Mirrors the fetch shape of the
  // `submit_restoration_result` proxy at mcp/server.ts. Bearer token is
  // attached when supplied; the daemon's `requireBearer` middleware would
  // reject without it.
  let response: Response;
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (daemonApiToken) headers['Authorization'] = `Bearer ${daemonApiToken}`;
    response = await fetch(`${daemonApiUrl}/v1/artifacts/acquire`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        sha256: args.sha256,
        access: args.access,
        envelopeCid: args.envelopeCid,
        artifactType: args.artifactType,
        sources: args.sources,
        ownerSafe: args.ownerSafe,
      }),
    });
  } catch (err) {
    return {
      ok: false,
      error: 'acquire_failed',
      reason: 'daemon_unreachable',
      sha256: args.sha256,
      retryable: true,
      message: err instanceof Error ? err.message : String(err),
    };
  }

  let body: Record<string, unknown> | null = null;
  try {
    body = (await response.json()) as Record<string, unknown>;
  } catch {
    // fall through with body=null
  }

  if (!response.ok || !body || body['ok'] !== true) {
    const reason = (body && typeof body['reason'] === 'string')
      ? (body['reason'] as string)
      : `http_${response.status}`;
    const message = (body && typeof body['error'] === 'string')
      ? (body['error'] as string)
      : `daemon returned HTTP ${response.status}`;
    const retryable = (body && typeof body['retryable'] === 'boolean')
      ? (body['retryable'] as boolean)
      : response.status >= 500;
    const sourceOperator = (body && typeof body['sourceOperator'] === 'string')
      ? (body['sourceOperator'] as string)
      : undefined;
    const result: AcquireArtifactResult = {
      ok: false,
      error: 'acquire_failed',
      reason,
      sha256: args.sha256,
      retryable,
      message,
    };
    if (sourceOperator) result.sourceOperator = sourceOperator;
    return result;
  }

  // Decode base64 → Buffer and mirror into network_artifacts so subsequent
  // calls in the same process hit the cache path without re-round-tripping
  // the daemon. Hash verification was already done daemon-side.
  const contentB64 = String(body['content'] ?? '');
  const bytes = Buffer.from(contentB64, 'base64');
  const artifactType = String(body['artifactType'] ?? args.artifactType ?? 'unknown');
  const source = (body['source'] ?? 'origin') as ArtifactContent['source'];
  const paidAmountUsdc = String(body['paidAmountUsdc'] ?? args.access.priceUsdc);
  const fetchedAt = String(body['fetchedAt'] ?? new Date().toISOString());
  const sourceOperator = typeof body['sourceOperator'] === 'string'
    ? (body['sourceOperator'] as string)
    : undefined;
  const ipfsSource = args.sources?.find((artifactSource) => artifactSource.kind === 'ipfs');
  const sourceEndpoint = source === 'ipfs' && ipfsSource
    ? `ipfs://${ipfsSource.cid}`
    : args.access.endpoint;

  // Best-effort cache mirror; errors here are non-fatal.
  try {
    if (!store.getNetworkArtifact(args.sha256)) {
      store.saveNetworkArtifact({
        sha256: args.sha256,
        artifactType,
        envelopeCid: args.envelopeCid ?? null,
        content: bytes,
        source: 'origin',
        sourceOperator: sourceOperator ?? null,
        sourceEndpoint,
        paidAmountUsdc,
        fetchedAt,
      });
    }
  } catch {
    /* ignore cache mirror failure */
  }

  return {
    ok: true,
    content: {
      sha256: args.sha256,
      bytes,
      artifactType,
      source,
      paidAmountUsdc,
      fetchedAt,
      ...(sourceOperator ? { sourceOperator } : {}),
    },
  };
}
