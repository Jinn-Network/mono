import type { Context, Hono } from 'hono';
import { existsSync, readFileSync } from 'node:fs';
import { z } from 'zod/v3';
import {
  DEFAULT_CONFIG_PATH,
  persistTopLevelConfigValue,
} from '../config.js';
import type {
  ArtifactAccessStats,
  Erc8004AnchorRow,
  NetworkArtifactMetadataRow,
  ServedArtifactMetadataRow,
  Store,
} from '../store/store.js';
import type { EnvelopeProjection } from '../corpus/types.js';

export interface OperatorPricingConfig {
  publicEndpoint: string;
  defaultPriceUsdc: string;
  perArtifactTypePrice: Record<string, string>;
  donation: { enabled: boolean };
}

export interface OperatorArtifactsRoutesConfig {
  store: Store;
  configPath?: string;
  operatorConfig?: OperatorPricingConfig;
  persistConfigValue?: typeof persistTopLevelConfigValue;
  onOperatorConfigUpdated?: (operator: OperatorPricingConfig) => void;
}

type ArtifactSource = 'served' | 'network';

interface ArtifactTypeSummary {
  artifactType: string;
  count: number;
  totalBytes: number;
  gatedCount?: number;
}

interface StorageSummary {
  totalCount: number;
  totalBytes: number;
  artifactTypes: ArtifactTypeSummary[];
}

const EMPTY_ACCESS_STATS: ArtifactAccessStats = {
  accessCount: 0,
  paidServeCount: 0,
  freeServeCount: 0,
  failedPaymentCount: 0,
  paymentRequiredCount: 0,
  revenueUsdc: '0',
  lastAccessAt: null,
  lastPaidAt: null,
};

const DecimalString = z.string().regex(/^\d+(\.\d+)?$/);

const PricingPatchSchema = z.object({
  publicEndpoint: z.string().optional(),
  defaultPriceUsdc: DecimalString.optional(),
  perArtifactTypePrice: z.record(z.string(), DecimalString).optional(),
  donation: z.object({ enabled: z.boolean() }).optional(),
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readConfigFile(configPath: string): Record<string, unknown> {
  if (!existsSync(configPath)) return {};
  return JSON.parse(readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
}

function decimalRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw === 'string' && DecimalString.safeParse(raw).success) {
      out[key] = raw;
    }
  }
  return out;
}

function resolvePricingConfig(
  configPath: string,
  fallback?: OperatorPricingConfig,
): OperatorPricingConfig {
  const current = readConfigFile(configPath);
  const rawOperator = isRecord(current.operator) ? current.operator : {};
  return {
    publicEndpoint:
      typeof rawOperator.publicEndpoint === 'string'
        ? rawOperator.publicEndpoint
        : fallback?.publicEndpoint ?? '',
    defaultPriceUsdc:
      typeof rawOperator.defaultPriceUsdc === 'string' && DecimalString.safeParse(rawOperator.defaultPriceUsdc).success
        ? rawOperator.defaultPriceUsdc
        : fallback?.defaultPriceUsdc ?? '0',
    perArtifactTypePrice: {
      ...(fallback?.perArtifactTypePrice ?? {}),
      ...decimalRecord(rawOperator.perArtifactTypePrice),
    },
    donation: {
      enabled: isRecord(rawOperator.donation) && typeof rawOperator.donation.enabled === 'boolean'
        ? rawOperator.donation.enabled
        : fallback?.donation?.enabled ?? false,
    },
  };
}

function validatePublicEndpoint(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function normalizePricingPatch(
  current: OperatorPricingConfig,
  rawBody: unknown,
): { ok: true; value: OperatorPricingConfig } | { ok: false; detail: string } {
  const parsed = PricingPatchSchema.safeParse(rawBody);
  if (!parsed.success) {
    return { ok: false, detail: 'publicEndpoint, defaultPriceUsdc, perArtifactTypePrice, or donation is malformed' };
  }
  const patch = parsed.data;
  const publicEndpoint = patch.publicEndpoint !== undefined
    ? patch.publicEndpoint.trim()
    : current.publicEndpoint;
  if (publicEndpoint && !validatePublicEndpoint(publicEndpoint)) {
    return { ok: false, detail: '`publicEndpoint`, when set, must be an http(s) URL' };
  }

  const perArtifactTypePrice =
    patch.perArtifactTypePrice === undefined
      ? current.perArtifactTypePrice
      : Object.fromEntries(
          Object.entries(patch.perArtifactTypePrice).map(([key, price]) => [key.trim(), price.trim()]),
        );

  if (Object.keys(perArtifactTypePrice).some((key) => key.length === 0)) {
    return { ok: false, detail: '`perArtifactTypePrice` keys must be non-empty artifact types' };
  }

  return {
    ok: true,
    value: {
      publicEndpoint,
      defaultPriceUsdc: patch.defaultPriceUsdc?.trim() ?? current.defaultPriceUsdc,
      perArtifactTypePrice,
      donation: patch.donation ?? current.donation,
    },
  };
}

function endpointFor(pricing: OperatorPricingConfig, sha256: string): string | null {
  if (!pricing.publicEndpoint) return null;
  return `${pricing.publicEndpoint.replace(/\/$/, '')}/v1/artifacts/${sha256}/content`;
}

function projectionToResponse(projection: EnvelopeProjection): Record<string, unknown> {
  return {
    envelopeId: projection.envelopeId,
    signatureHash: projection.signatureHash,
    solverType: projection.solverType,
    role: projection.role,
    taskCid: projection.taskCid,
    taskId: projection.taskId,
    requestId: projection.requestId,
    generatedAt: projection.generatedAt,
    evidenceTier: projection.evidenceTier,
    participantSafeAddress: projection.participantSafeAddress,
    participantAgentEoa: projection.participantAgentEoa,
    executor: {
      implName: projection.executorImplName,
      implVersion: projection.executorImplVersion,
      runtimeBundleDigest: projection.executorRuntimeBundleDigest,
      plugins: projection.executorPlugins.length > 0 ? projection.executorPlugins : null,
    },
    solutionRef: projection.solutionEnvelopeCid
      ? {
          envelopeCid: projection.solutionEnvelopeCid,
          envelopeSha256: projection.solutionEnvelopeSha256,
          ref: projection.solutionEnvelopeRef,
        }
      : undefined,
    metadata: Object.keys(projection.metadata).length > 0 ? projection.metadata : null,
  };
}

function anchorToResponse(anchor: Erc8004AnchorRow): Record<string, unknown> {
  return {
    contentKind: anchor.contentKind,
    metadataKey: anchor.metadataKey,
    agentId: anchor.agentId,
    chainId: anchor.chainId,
    identityRegistryAddress: anchor.identityRegistryAddress,
    txHash: anchor.txHash,
    blockNumber: anchor.blockNumber,
    payloadHex: anchor.payloadHex,
    anchoredAt: anchor.anchoredAt,
  };
}

function servedArtifact(
  row: ServedArtifactMetadataRow,
  pricing: OperatorPricingConfig,
  access: ArtifactAccessStats,
  projection: EnvelopeProjection | undefined,
  anchors: Erc8004AnchorRow[],
): Record<string, unknown> {
  return {
    source: 'served',
    sha256: row.sha256,
    artifactType: row.artifactType,
    requestId: row.requestId,
    envelopeCid: row.envelopeCid,
    contentSize: row.contentSize,
    priceUsdc: row.priceUsdc,
    createdAt: row.createdAt,
    endpoint: endpointFor(pricing, row.sha256),
    access,
    projection: projection ? projectionToResponse(projection) : undefined,
    anchors: anchors.map(anchorToResponse),
  };
}

function networkArtifact(
  row: NetworkArtifactMetadataRow,
  projection: EnvelopeProjection | undefined,
  anchors: Erc8004AnchorRow[],
): Record<string, unknown> {
  return {
    source: 'network',
    sha256: row.sha256,
    artifactType: row.artifactType,
    envelopeCid: row.envelopeCid,
    contentSize: row.contentSize,
    origin: row.source,
    sourceOperator: row.sourceOperator,
    sourceEndpoint: row.sourceEndpoint,
    paidAmountUsdc: row.paidAmountUsdc,
    fetchedAt: row.fetchedAt,
    lastUsedAt: row.lastUsedAt,
    peerCatalogId: row.peerCatalogId,
    projection: projection ? projectionToResponse(projection) : undefined,
    anchors: anchors.map(anchorToResponse),
  };
}

function servedSummary(store: Store): StorageSummary & { freeCount: number; gatedCount: number; latestCreatedAt: string | null } {
  const row = store.db.prepare(
    `SELECT
       COUNT(*) AS total_count,
       COALESCE(SUM(content_size), 0) AS total_bytes,
       COALESCE(SUM(CASE WHEN CAST(price_usdc AS REAL) > 0 THEN 1 ELSE 0 END), 0) AS gated_count,
       COALESCE(SUM(CASE WHEN CAST(price_usdc AS REAL) > 0 THEN 0 ELSE 1 END), 0) AS free_count,
       MAX(created_at) AS latest_created_at
     FROM served_artifacts`,
  ).get() as {
    total_count: number;
    total_bytes: number;
    gated_count: number;
    free_count: number;
    latest_created_at: string | null;
  };
  const artifactTypes = store.db.prepare(
    `SELECT
       artifact_type,
       COUNT(*) AS count,
       COALESCE(SUM(content_size), 0) AS total_bytes,
       COALESCE(SUM(CASE WHEN CAST(price_usdc AS REAL) > 0 THEN 1 ELSE 0 END), 0) AS gated_count
     FROM served_artifacts
     GROUP BY artifact_type
     ORDER BY count DESC, artifact_type ASC`,
  ).all() as Array<{
    artifact_type: string;
    count: number;
    total_bytes: number;
    gated_count: number;
  }>;
  return {
    totalCount: row.total_count,
    totalBytes: row.total_bytes,
    freeCount: row.free_count,
    gatedCount: row.gated_count,
    latestCreatedAt: row.latest_created_at,
    artifactTypes: artifactTypes.map((typeRow) => ({
      artifactType: typeRow.artifact_type,
      count: typeRow.count,
      totalBytes: typeRow.total_bytes,
      gatedCount: typeRow.gated_count,
    })),
  };
}

function networkSummary(store: Store): StorageSummary & { latestFetchedAt: string | null } {
  const row = store.db.prepare(
    `SELECT
       COUNT(*) AS total_count,
       COALESCE(SUM(content_size), 0) AS total_bytes,
       MAX(fetched_at) AS latest_fetched_at
     FROM network_artifacts`,
  ).get() as {
    total_count: number;
    total_bytes: number;
    latest_fetched_at: string | null;
  };
  const artifactTypes = store.db.prepare(
    `SELECT artifact_type, COUNT(*) AS count, COALESCE(SUM(content_size), 0) AS total_bytes
     FROM network_artifacts
     GROUP BY artifact_type
     ORDER BY count DESC, artifact_type ASC`,
  ).all() as Array<{
    artifact_type: string;
    count: number;
    total_bytes: number;
  }>;
  return {
    totalCount: row.total_count,
    totalBytes: row.total_bytes,
    latestFetchedAt: row.latest_fetched_at,
    artifactTypes: artifactTypes.map((typeRow) => ({
      artifactType: typeRow.artifact_type,
      count: typeRow.count,
      totalBytes: typeRow.total_bytes,
    })),
  };
}

export function addOperatorArtifactsRoutes(app: Hono, config: OperatorArtifactsRoutesConfig): void {
  const configPath = config.configPath ?? DEFAULT_CONFIG_PATH;
  const persistConfigValue = config.persistConfigValue ?? persistTopLevelConfigValue;

  const listExecutionData = (c: Context) => {
    const sourceRaw = c.req.query('source') ?? 'served';
    if (sourceRaw !== 'served' && sourceRaw !== 'network') {
      return c.json({ error: 'invalid_query', detail: '`source` must be `served` or `network`' }, 400);
    }
    const source = sourceRaw as ArtifactSource;
    const artifactType = c.req.query('artifactType') ?? undefined;
    const limitRaw = c.req.query('limit');
    const limit = limitRaw ? Number.parseInt(limitRaw, 10) : 50;
    if (!Number.isFinite(limit) || limit < 1) {
      return c.json({ error: 'invalid_query', detail: '`limit` must be a positive integer' }, 400);
    }

    let pricing: OperatorPricingConfig;
    try {
      pricing = resolvePricingConfig(configPath, config.operatorConfig);
    } catch (err) {
      return c.json({
        error: 'config_unreadable',
        detail: err instanceof Error ? err.message : String(err),
      }, 500);
    }

    const baseRows: Array<{ sha256: string; envelopeCid: string | null }> =
      source === 'served'
        ? config.store.listServedArtifactMetadata({ artifactType, limit })
        : config.store.listNetworkArtifactMetadata({ artifactType, limit });

    const envelopeCids = Array.from(
      new Set(
        baseRows
          .map((r) => r.envelopeCid)
          .filter((cid): cid is string => typeof cid === 'string' && cid.length > 0),
      ),
    );
    const projections = envelopeCids.length > 0
      ? config.store.queryEnvelopeProjections({ envelopeRefs: envelopeCids, limit: envelopeCids.length })
      : [];
    const projectionByCid = new Map<string, EnvelopeProjection>();
    for (const p of projections) {
      if (p.envelopeCid) projectionByCid.set(p.envelopeCid, p);
    }
    const anchorRows = config.store.listErc8004AnchorsByEnvelopeCids(envelopeCids);
    const anchorsByCid = new Map<string, Erc8004AnchorRow[]>();
    for (const a of anchorRows) {
      const list = anchorsByCid.get(a.envelopeCid) ?? [];
      list.push(a);
      anchorsByCid.set(a.envelopeCid, list);
    }

    const rows = source === 'served'
      ? (() => {
          const servedRows = baseRows as ServedArtifactMetadataRow[];
          const accessBySha = config.store.getArtifactAccessStatsBySha(servedRows.map((row) => row.sha256));
          return servedRows.map((row) =>
            servedArtifact(
              row,
              pricing,
              accessBySha[row.sha256] ?? EMPTY_ACCESS_STATS,
              row.envelopeCid ? projectionByCid.get(row.envelopeCid) : undefined,
              row.envelopeCid ? anchorsByCid.get(row.envelopeCid) ?? [] : [],
            ),
          );
        })()
      : (baseRows as NetworkArtifactMetadataRow[]).map((row) =>
          networkArtifact(
            row,
            row.envelopeCid ? projectionByCid.get(row.envelopeCid) : undefined,
            row.envelopeCid ? anchorsByCid.get(row.envelopeCid) ?? [] : [],
          ),
        );

    return c.json({
      schemaVersion: 2,
      generatedAt: new Date().toISOString(),
      source,
      pricing,
      summary: {
        served: servedSummary(config.store),
        network: networkSummary(config.store),
        access: config.store.getArtifactAccessSummary(),
      },
      recentAccesses: config.store.listArtifactAccessEvents({ limit: 20 }),
      artifacts: rows,
    });
  };

  app.get('/v1/operator/artifacts', listExecutionData);
  app.get('/v1/operator/execution-data', listExecutionData);

  app.post('/v1/operator/pricing', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid_body', detail: 'expected JSON body' }, 400);
    }

    let current: OperatorPricingConfig;
    try {
      current = resolvePricingConfig(configPath, config.operatorConfig);
    } catch (err) {
      return c.json({
        error: 'config_unreadable',
        detail: err instanceof Error ? err.message : String(err),
      }, 500);
    }

    const normalized = normalizePricingPatch(current, body);
    if (!normalized.ok) {
      return c.json({ error: 'invalid_body', detail: normalized.detail }, 400);
    }

    try {
      persistConfigValue('operator', normalized.value, configPath);
      config.onOperatorConfigUpdated?.(normalized.value);
    } catch (err) {
      return c.json({
        error: 'config_write_failed',
        detail: err instanceof Error ? err.message : String(err),
      }, 500);
    }

    return c.json({
      ok: true,
      restartRequired: true,
      pricing: normalized.value,
    });
  });
}
