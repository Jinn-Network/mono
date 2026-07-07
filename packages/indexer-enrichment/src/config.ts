/**
 * Env → typed config for the verdict-envelope enrichment worker (#779).
 *
 * Shares DATABASE_URL / DATABASE_SCHEMA / JINN_IPFS_GATEWAY_URL with the indexer
 * (the worker writes into the indexer's Ponder schema), and adds JINN_ENRICHMENT_*
 * knobs for the worker-specific poll/batch/retry behaviour.
 */

export interface EnrichmentWorkerConfig {
  /** Shared with the indexer — the Postgres the Ponder schema lives in. */
  databaseUrl: string;
  /** Shared with the indexer — the per-deploy schema (e.g. jinn_indexer_v1). */
  databaseSchema: string;
  /** Shared with the indexer. '' → fetchIpfsJson falls back to DEFAULT_IPFS_GATEWAY. */
  ipfsGateway: string;
  /** HTTP status server port (NOT 8737 — that's claim-relayer's). */
  port: number;
  /** Poll interval between enrichment ticks, ms. */
  pollIntervalMs: number;
  /** Max anchors claimed + enriched per tick (the O4 backfill-drain knob). */
  batchSize: number;
  /** Per-IPFS-fetch timeout, ms. */
  ipfsTimeoutMs: number;
  /**
   * Verdict-body fetch/parse failures are retried with backoff in the
   * worker-owned enrichment_attempt table, then quarantined as failed.
   * Task-body fetch failures still graceful-degrade to match the handler.
   */
  maxRetries: number;
}

function requiredEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`missing required env ${name}`);
  return value;
}

function parseIdentifier(value: string, name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw new Error(`${name} must be a safe Postgres identifier`);
  }
  return value;
}

function parseNumber(
  value: string | undefined,
  fallback: number,
  name: string,
): number {
  if (value === undefined || value === '') return fallback;
  if (!/^\d+$/.test(value)) throw new Error(`${name} must be a non-negative integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${name} is too large`);
  return parsed;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): EnrichmentWorkerConfig {
  return {
    databaseUrl: requiredEnv(env, 'DATABASE_URL'),
    databaseSchema: parseIdentifier(requiredEnv(env, 'DATABASE_SCHEMA'), 'DATABASE_SCHEMA'),
    ipfsGateway: env.JINN_IPFS_GATEWAY_URL ?? '',
    port: parseNumber(env.JINN_ENRICHMENT_PORT, 8738, 'JINN_ENRICHMENT_PORT'),
    pollIntervalMs: parseNumber(
      env.JINN_ENRICHMENT_POLL_INTERVAL_MS,
      10_000,
      'JINN_ENRICHMENT_POLL_INTERVAL_MS',
    ),
    batchSize: parseNumber(env.JINN_ENRICHMENT_BATCH_SIZE, 25, 'JINN_ENRICHMENT_BATCH_SIZE'),
    ipfsTimeoutMs: parseNumber(
      env.JINN_ENRICHMENT_IPFS_TIMEOUT_MS,
      5000,
      'JINN_ENRICHMENT_IPFS_TIMEOUT_MS',
    ),
    maxRetries: parseNumber(env.JINN_ENRICHMENT_MAX_RETRIES, 5, 'JINN_ENRICHMENT_MAX_RETRIES'),
  };
}

/**
 * Mask the DATABASE_URL credentials for the /status payload while keeping the
 * host visible (operators want to verify which DB the worker connected to).
 * Mirrors claim-relayer's redactConfig intent.
 */
export function maskDatabaseUrl(url: string): string {
  try {
    const u = new URL(url);
    const host = u.host || '[unknown-host]';
    const db = u.pathname && u.pathname !== '/' ? u.pathname : '';
    return `postgres://[redacted]@${host}${db}`;
  } catch {
    return '[redacted-url]';
  }
}

export function redactConfig(config: EnrichmentWorkerConfig): Record<string, unknown> {
  return {
    databaseUrl: maskDatabaseUrl(config.databaseUrl),
    databaseSchema: config.databaseSchema,
    ipfsGateway: config.ipfsGateway || '(default)',
    port: config.port,
    pollIntervalMs: config.pollIntervalMs,
    batchSize: config.batchSize,
    ipfsTimeoutMs: config.ipfsTimeoutMs,
    maxRetries: config.maxRetries,
  };
}
