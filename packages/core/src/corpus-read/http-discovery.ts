import type { CorpusDiscoveryPort, CorpusQuery, EnvelopeRef } from './types.js';
import { DiscoveryUnavailableError } from './types.js';

const QUERY_ENVELOPES = `
query QueryEnvelopes($where: envelopeFilter, $limit: Int!) {
  envelopes(
    where: $where,
    limit: $limit,
    orderBy: "publishedAtBlock",
    orderDirection: "desc"
  ) {
    items {
      agentId
      manifestCid
      manifestHash
      evidenceTier
      publishedAtBlock
    }
  }
}
`;

const DEFAULT_RETRY_DELAYS_MS = [200, 500] as const;
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_READY_TTL_MS = 20_000;

export interface HttpCorpusDiscoveryOptions {
  url: string;
  fetchImpl?: typeof fetch;
  retryDelaysMs?: readonly number[];
  fetchTimeoutMs?: number;
  readyProbeTtlMs?: number;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createHttpCorpusDiscovery(
  options: HttpCorpusDiscoveryOptions,
): CorpusDiscoveryPort {
  const gqlUrl = options.url.endsWith('/graphql')
    ? options.url
    : `${options.url.replace(/\/$/, '')}/graphql`;
  const readyUrl = `${options.url.replace(/\/graphql\/?$/, '').replace(/\/$/, '')}/ready`;
  const baseFetch = options.fetchImpl ?? globalThis.fetch;
  const retryDelays = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  const timeoutMs = options.fetchTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const readyTtlMs = options.readyProbeTtlMs ?? DEFAULT_READY_TTL_MS;
  let readyCache: { checkedAt: number; ok: boolean; status: number } | undefined;

  async function request(input: string, init: RequestInit): Promise<Response> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= retryDelays.length; attempt += 1) {
      try {
        const response = await baseFetch(input, {
          ...init,
          signal: init.signal ?? AbortSignal.timeout(timeoutMs),
        });
        if (
          (response.status === 502 || response.status === 503)
          && attempt < retryDelays.length
        ) {
          await wait(retryDelays[attempt]!);
          continue;
        }
        return response;
      } catch (error) {
        lastError = error;
        if (attempt >= retryDelays.length) break;
        await wait(retryDelays[attempt]!);
      }
    }
    throw new DiscoveryUnavailableError(
      `Ponder HTTP network error: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
      lastError,
    );
  }

  async function ensureReady(): Promise<void> {
    const now = Date.now();
    if (readyCache && now - readyCache.checkedAt < readyTtlMs) {
      if (!readyCache.ok) {
        throw new DiscoveryUnavailableError(`indexer not ready: ${readyCache.status}`);
      }
      return;
    }
    const response = await request(readyUrl, { method: 'GET' });
    readyCache = { checkedAt: now, ok: response.ok, status: response.status };
    if (!response.ok) {
      throw new DiscoveryUnavailableError(`indexer not ready: ${response.status}`);
    }
  }

  return {
    async queryEnvelopes(query: CorpusQuery): Promise<EnvelopeRef[]> {
      await ensureReady();
      const where: Record<string, unknown> = {};
      if (query.evidenceTier) where['evidenceTier'] = query.evidenceTier;
      if (query.manifestHash) where['manifestHash'] = query.manifestHash;
      const response = await request(gqlUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          query: QUERY_ENVELOPES,
          variables: {
            where,
            limit: Math.min(500, Math.max(1, query.limit ?? 50)),
          },
        }),
      });
      if (!response.ok) {
        throw new DiscoveryUnavailableError(
          `Ponder GraphQL HTTP ${response.status} ${response.statusText}`,
        );
      }
      const body = await response.json() as {
        data?: {
          envelopes?: {
            items?: Array<{
              agentId: string;
              manifestCid: string;
              manifestHash: string;
              evidenceTier: EnvelopeRef['evidenceTier'];
              publishedAtBlock: string | number;
            }>;
          };
        };
        errors?: Array<{ message?: string }>;
      };
      if (body.errors?.length) {
        throw new DiscoveryUnavailableError(
          `Ponder GraphQL error: ${body.errors.map((error) => error.message ?? 'unknown').join('; ')}`,
        );
      }
      if (!body.data) {
        throw new DiscoveryUnavailableError('Ponder GraphQL response missing data field');
      }
      return (body.data.envelopes?.items ?? []).map((row) => ({
        manifestCid: row.manifestCid,
        manifestHash: row.manifestHash,
        operator: { agentId: row.agentId, safeAddress: '' },
        evidenceTier: row.evidenceTier ?? 'unknown',
        publishedAt: Number(row.publishedAtBlock),
      }));
    },
  };
}
