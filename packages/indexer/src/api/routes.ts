/**
 * Pure route-logic functions for the five Discovery API REST routes added by
 * ttz8 (spec §6.5).
 *
 * These are extracted from the Hono route handlers so they can be unit-tested
 * without the Ponder `db` / `ponder:api` virtual module, following the same
 * pattern used for the builder-attribution join in `src/builder-attribution.ts`.
 *
 * The Hono handlers in `src/api/index.ts` query the Ponder db, then delegate
 * to these functions for the JSON-shape logic.
 *
 * Trust boundary:
 *   Routes 3 (/plugins/:cid/scores) and 5 (/builders/:address/scores) return
 *   [] until the indexer exposes canonical attempt/verdict projections bound
 *   to the historical publisher Safe, envelope signature/hash, authoritative
 *   chain row, and original task. Permissionless shape projections are stored
 *   for authenticated consumers but never promoted to score history here.
 *
 * JSON serialisation note:
 *   `publishedAt` is stored as bigint in the schema (unix seconds from the
 *   on-chain payload). This module converts it to a plain JS number so
 *   responses are valid JSON without `BigInt.prototype.toJSON` patches.
 *   Values beyond Number.MAX_SAFE_INTEGER (year ~292471) are not a practical
 *   concern for a unix-seconds timestamp.
 */

// ── Row types ─────────────────────────────────────────────────────────────────
// Minimal structural types matching the Ponder schema columns the handlers
// read. Must stay in sync with ponder.schema.ts pluginPublication columns.

export interface PluginPublicationRow {
  id: string;
  builderAgentId: string;
  pluginCid: string;
  pluginName: string;
  pluginVersion: string;
  pluginSha256: string;
  supports: readonly string[];
  publishedAt: bigint;
  revoked: boolean;
  revokedReason: string | null;
  blockNumber: bigint;
  txIndex: number;
  logIndex: number;
  txHash: `0x${string}`;
  chainId: number;
}

/** Row type for ebu7's `attemptEnvelopeMeta` entity (not yet in schema). */
export interface AttemptEnvelopeMetaRow {
  requestId: `0x${string}`;
  manifestCid: string;
  /** JSON.stringify(executor.plugins) — array of {name,version,cid?,sha256}. */
  pluginsJson: string;
  enrichedAtBlock: bigint;
  chainId: number;
}

/** Row type for ebu7's `verdict` entity (not yet in schema). */
export interface VerdictRow {
  requestId: `0x${string}`;
  taskId: string;
  operatorAgentId: string;
  verdict: string;
  score?: number;
  ts: number;
}

// ── Shared output types ───────────────────────────────────────────────────────
// These mirror operator/src/discovery/types.ts PluginPublication /
// PublishedArtifact / PluginScoreHistoryRow exactly so the SPA and SDK get
// the same shape from both the indexer HTTP endpoints and the DiscoveryAPI.

export interface PluginPublicationOutput {
  artifactType: 'plugin';
  builderAgentId: string;
  cid: string;
  name: string;
  version: string;
  supports: readonly string[];
  publishedAt: number;
  revoked: boolean;
  revokedReason?: string;
  pluginSha256: string;
}

export interface PluginScoreHistoryOutput {
  pluginCid: string;
  taskId: string;
  operatorAgentId: string;
  verdict: string;
  score?: number;
  ts: number;
  forkSuspected: boolean;
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function rowToOutput(row: PluginPublicationRow): PluginPublicationOutput {
  const out: PluginPublicationOutput = {
    artifactType: 'plugin',
    builderAgentId: row.builderAgentId,
    cid: row.pluginCid,
    name: row.pluginName,
    version: row.pluginVersion,
    supports: row.supports,
    publishedAt: Number(row.publishedAt),
    revoked: row.revoked,
    pluginSha256: row.pluginSha256,
  };
  if (row.revokedReason != null) out.revokedReason = row.revokedReason;
  return out;
}

/**
 * Build per-plugin score rows by joining plug-in publications against
 * envelope meta + verdict rows (ebu7 data). Returns [] when either
 * of the ebu7 lists is empty.
 */
function buildScoreRows(
  publications: PluginPublicationRow[],
  attemptEnvelopeMetas: AttemptEnvelopeMetaRow[],
  verdicts: VerdictRow[],
): PluginScoreHistoryOutput[] {
  void publications;
  void attemptEnvelopeMetas;
  void verdicts;
  // These rows are permissionless shape projections. An exact request join or
  // an unambiguous singleton does not authenticate the historical publisher,
  // envelope signature/hash, or authoritative attempt. Publish no score rows
  // until the indexer exposes that canonical authenticated projection.
  return [];
}

// ── Route 1: GET /plugins?solverNet=<id>[&includeRevoked=false] ───────────────

/**
 * Returns published plug-ins whose `supports` array includes `solverNet`.
 * Revoked rows are excluded by default (includeRevoked=false).
 */
export function listPluginsByNetwork(args: {
  publications: PluginPublicationRow[];
  solverNet: string;
  includeRevoked?: boolean;
}): PluginPublicationOutput[] {
  const { publications, solverNet, includeRevoked = false } = args;
  return publications
    .filter((p) => {
      if (!includeRevoked && p.revoked) return false;
      return (p.supports as string[]).includes(solverNet);
    })
    .map(rowToOutput);
}

// ── Route 2: GET /plugins?builder=<address> ───────────────────────────────────

/**
 * Returns published plug-ins by a given builder agentId.
 * Revoked rows are excluded by default (includeRevoked=false).
 */
export function listPluginsByBuilder(args: {
  publications: PluginPublicationRow[];
  builderAgentId: string;
  includeRevoked?: boolean;
}): PluginPublicationOutput[] {
  const { publications, builderAgentId, includeRevoked = false } = args;
  return publications
    .filter((p) => {
      if (!includeRevoked && p.revoked) return false;
      return p.builderAgentId === builderAgentId;
    })
    .map(rowToOutput);
}

// ── Route 3: GET /plugins/:cid/scores ─────────────────────────────────────────

/**
 * Returns score history for a single plug-in CID.
 *
 * ebu7 dependency: pass `attemptEnvelopeMetas: []` and `verdicts: []` until
 * ebu7 merges — the function returns [] gracefully.
 */
export function getPluginScores(args: {
  publications: PluginPublicationRow[];
  pluginCid: string;
  attemptEnvelopeMetas: AttemptEnvelopeMetaRow[];
  verdicts: VerdictRow[];
}): PluginScoreHistoryOutput[] {
  const { publications, pluginCid, attemptEnvelopeMetas, verdicts } = args;
  const pub = publications.find((p) => p.pluginCid === pluginCid);
  if (!pub) return [];

  return buildScoreRows([pub], attemptEnvelopeMetas, verdicts);
}

// ── Route 4: GET /builders/:address/artifacts ─────────────────────────────────

/**
 * Returns all published artifacts for a given builder agentId.
 * Includes revoked rows so the SPA can render them with a "revoked" badge.
 * The `artifactType` discriminator is future-proofed for harness kind.
 */
export function listBuilderArtifacts(args: {
  publications: PluginPublicationRow[];
  builderAgentId: string;
}): PluginPublicationOutput[] {
  const { publications, builderAgentId } = args;
  return publications
    .filter((p) => p.builderAgentId === builderAgentId)
    .map(rowToOutput);
}

// ── Route 5: GET /builders/:address/scores ────────────────────────────────────

/**
 * Returns per-artifact score history for all plug-ins published by a builder.
 *
 * ebu7 dependency: pass `attemptEnvelopeMetas: []` and `verdicts: []` until
 * ebu7 merges — the function returns [] gracefully.
 */
export function listBuilderScores(args: {
  publications: PluginPublicationRow[];
  builderAgentId: string;
  attemptEnvelopeMetas: AttemptEnvelopeMetaRow[];
  verdicts: VerdictRow[];
}): PluginScoreHistoryOutput[] {
  const { publications, builderAgentId, attemptEnvelopeMetas, verdicts } = args;
  const builderPubs = publications.filter((p) => p.builderAgentId === builderAgentId);
  return buildScoreRows(builderPubs, attemptEnvelopeMetas, verdicts);
}

// ── Route 6: GET /distribution-signal (#1314) ────────────────────────────────

/** Row type matching ponder.schema.ts captureEnvelopeMeta columns the route reads. */
export interface CaptureEnvelopeMetaRow {
  manifestCid: string;
  chainId: number;
  contributor: string;
  taskSummary: string;
  /** JSON.stringify(task.distributionTags) — first tag is the primary (v0 cluster key). */
  tagsJson: string;
  /** task.repositorySlug — named capture metadata. Optional for legacy rows. */
  repositorySlug?: string;
  /** Authored outcome/seed synthesis. Optional for legacy rows. */
  synthesis?: string;
  /** Canonical W2 allowlist decision. Optional for legacy rows. */
  retrievalVisible?: boolean;
  provenance: string;
  verifiabilityTier: string;
  /** environment.harness "<name> <version>" — corpus detail (#1406). Optional for back-compat. */
  harness?: string;
  /** environment.model — corpus detail (#1406). Optional for back-compat. */
  model?: string;
  /** JSON.stringify(environment.tools) — corpus detail (#1406). Optional for back-compat. */
  toolsJson?: string;
  /** steps.length — corpus index + detail (#1406). Optional for back-compat. */
  stepCount?: number;
  /** MetadataSet anchor tx hash — corpus detail (#1406). Optional for back-compat. */
  anchorTx?: string;
  /** Unix-seconds block timestamp of the anchor — corpus createdAt (#1406). Optional for back-compat. */
  createdAtTimestamp?: bigint | string | number;
}

export interface DistributionSignalRow {
  cluster: string;
  envelopeCount: number;
  contributorCount: number;
  /** Co-occurring tags in the cluster, most frequent first (primary excluded). */
  topTags: string[];
}

export interface DistributionSignalOutput {
  rows: DistributionSignalRow[];
  /** Total envelopes counted (post-filter). */
  envelopeTotal: number;
  /** Distinct contributors across all counted envelopes (clusters overlap; rows don't sum). */
  contributorTotal: number;
  /** How many seeded (provenance=imported) envelopes the default filter excluded. */
  seedsExcluded: number;
  includeSeeds: boolean;
}

/**
 * v0 tag-rollup clustering over enriched capture envelopes: an envelope's
 * first distribution tag is its cluster; topTags are the co-occurring tags.
 * Seeds (provenance=imported) are excluded from every number unless
 * `includeSeeds` — the explorer's demonstrate-it-live toggle (spec §7).
 * Mirrors operator/packages/harness-layer/src/signal.ts computeSignal.
 */
export function buildDistributionSignal(
  metas: CaptureEnvelopeMetaRow[],
  opts: { includeSeeds?: boolean; topTagsLimit?: number } = {},
): DistributionSignalOutput {
  const includeSeeds = opts.includeSeeds ?? false;
  const topTagsLimit = opts.topTagsLimit ?? 5;
  const clusters = new Map<
    string,
    { envelopes: number; contributors: Set<string>; tagCounts: Map<string, number> }
  >();
  const allContributors = new Set<string>();
  let envelopeTotal = 0;
  let seedsExcluded = 0;

  for (const meta of metas) {
    if (meta.provenance === 'imported' && !includeSeeds) {
      seedsExcluded += 1;
      continue;
    }
    let tags: string[] = [];
    try {
      const parsed = JSON.parse(meta.tagsJson) as unknown;
      if (Array.isArray(parsed)) tags = parsed.filter((t): t is string => typeof t === 'string');
    } catch {
      // Malformed tagsJson: the envelope is counted nowhere (no primary tag).
    }
    const primary = tags[0];
    if (!primary) continue;
    envelopeTotal += 1;
    allContributors.add(meta.contributor);
    const cluster = clusters.get(primary) ?? {
      envelopes: 0,
      contributors: new Set<string>(),
      tagCounts: new Map<string, number>(),
    };
    cluster.envelopes += 1;
    cluster.contributors.add(meta.contributor);
    for (const tag of tags.slice(1)) {
      cluster.tagCounts.set(tag, (cluster.tagCounts.get(tag) ?? 0) + 1);
    }
    clusters.set(primary, cluster);
  }

  const rows = [...clusters.entries()]
    .map(([cluster, agg]) => ({
      cluster,
      envelopeCount: agg.envelopes,
      contributorCount: agg.contributors.size,
      topTags: [...agg.tagCounts.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, topTagsLimit)
        .map(([tag]) => tag),
    }))
    .sort((a, b) => b.envelopeCount - a.envelopeCount || a.cluster.localeCompare(b.cluster));

  return {
    rows,
    envelopeTotal,
    contributorTotal: allContributors.size,
    seedsExcluded,
    includeSeeds,
  };
}

// ── Route 7: GET /capture-meta (#1344) ───────────────────────────────────────

export interface CaptureMetaSearchHit {
  manifestCid: string;
  chainId: number;
  contributor: string;
  taskSummary: string;
  /** Parsed distribution tags ([] when tagsJson is malformed). */
  tags: string[];
  repositorySlug?: string;
  synthesis?: string;
  retrievalVisible?: boolean;
  provenance: string;
  verifiabilityTier: string;
}

const CAPTURE_META_SEARCH_DEFAULT_LIMIT = 50;

/**
 * Content-aware substring search over enriched capture metadata — the
 * consume path's fast path (`corpus search "tdd"` finds a seed tagged `tdd`
 * without any artifact fetch). Case-insensitive match on tags and task
 * summary; empty query returns everything up to `limit`. Seeds are
 * INCLUDED — search is the consume surface and seeds exist to be consumed;
 * the demand signal's seed exclusion is a different reader.
 */
export function searchCaptureMeta(
  metas: CaptureEnvelopeMetaRow[],
  q: string,
  opts: { limit?: number } = {},
): CaptureMetaSearchHit[] {
  const limit = opts.limit ?? CAPTURE_META_SEARCH_DEFAULT_LIMIT;
  const needle = q.trim().toLowerCase();
  const hits: CaptureMetaSearchHit[] = [];
  for (const meta of metas) {
    let tags: string[] = [];
    try {
      const parsed = JSON.parse(meta.tagsJson) as unknown;
      if (Array.isArray(parsed)) tags = parsed.filter((t): t is string => typeof t === 'string');
    } catch {
      // Malformed tagsJson: the row is only findable via its summary.
    }
    const haystack = [meta.taskSummary, ...tags].join('\n').toLowerCase();
    if (needle !== '' && !haystack.includes(needle)) continue;
    hits.push({
      manifestCid: meta.manifestCid,
      chainId: meta.chainId,
      contributor: meta.contributor,
      taskSummary: meta.taskSummary,
      tags,
      ...(meta.repositorySlug !== undefined
        ? { repositorySlug: meta.repositorySlug }
        : {}),
      ...(meta.synthesis !== undefined ? { synthesis: meta.synthesis } : {}),
      ...(meta.retrievalVisible !== undefined
        ? { retrievalVisible: meta.retrievalVisible }
        : {}),
      provenance: meta.provenance,
      verifiabilityTier: meta.verifiabilityTier,
    });
    if (hits.length >= limit) break;
  }
  return hits;
}

// ── Route 8: GET /corpus + /corpus/:cid (#1406) ──────────────────────────────
//
// The browsable corpus: an index of published capture envelopes and a
// per-item detail read. Mirrors buildDistributionSignal's seed-exclusion
// filter (seeds are excluded by default; ?include=seeded folds them in) but
// lists items rather than rolling them into clusters. The full trace content
// (per-step args/results) lives in the IPFS envelope — the detail carries the
// indexed fingerprint plus the outbound IPFS + on-chain anchor refs (spec §2.4).

/** Parse a row's tagsJson into a string[]; [] when malformed. */
function parseTags(tagsJson: string): string[] {
  try {
    const parsed = JSON.parse(tagsJson) as unknown;
    if (Array.isArray(parsed)) return parsed.filter((t): t is string => typeof t === 'string');
  } catch {
    // malformed — no tags
  }
  return [];
}

/** Coerce the createdAtTimestamp column (bigint | string | number) to a number of seconds, or null. */
function coerceTimestamp(v: bigint | string | number | undefined): number | null {
  if (v === undefined || v === null) return null;
  const n = typeof v === 'bigint' ? Number(v) : Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export interface CorpusItemRow {
  cid: string;
  chainId: number;
  summary: string;
  /** The primary distribution tag (v0 cluster key), '' when untagged. */
  cluster: string;
  tier: string;
  contributor: string;
  model: string;
  stepCount: number;
  /** Unix-seconds anchor timestamp, or null when un-enriched. */
  createdAt: number | null;
}

export interface CorpusListOutput {
  items: CorpusItemRow[];
  /** Total items counted (post-filter). */
  total: number;
  /** How many seeded (provenance=imported) envelopes the default filter excluded. */
  seedsExcluded: number;
  includeSeeds: boolean;
}

/** Sortable columns the corpus index exposes (mirrors the SPA header). */
export type CorpusSortKey = 'createdAt' | 'cluster' | 'tier' | 'stepCount';

const CORPUS_SORT_KEYS: readonly CorpusSortKey[] = [
  'createdAt',
  'cluster',
  'tier',
  'stepCount',
];

export interface CorpusListOpts {
  includeSeeds?: boolean;
  /** Exact, case-sensitive cluster (primary-tag) filter; omit for unfiltered (#1414). */
  cluster?: string;
  /** Page size (default 25, max 200). */
  limit?: number;
  /** Zero-based offset for pagination. */
  offset?: number;
  /** Sort column (default `createdAt`). Unknown values fall back to the default. */
  sort?: string;
  /** Sort direction (default `desc`). */
  dir?: 'asc' | 'desc';
}

/**
 * Ordered comparison of two corpus rows for the given key and direction.
 * `createdAt` sorts nulls last regardless of direction (the roster
 * convention — the direction factor is not applied to null placement); all
 * keys tie-break by cid for a deterministic total order.
 */
function compareCorpus(
  a: CorpusItemRow,
  b: CorpusItemRow,
  key: CorpusSortKey,
  factor: 1 | -1,
): number {
  if (key === 'createdAt') {
    // nulls always last, direction-independent.
    if (a.createdAt === null && b.createdAt === null) return a.cid.localeCompare(b.cid);
    if (a.createdAt === null) return 1;
    if (b.createdAt === null) return -1;
    if (a.createdAt !== b.createdAt) return (a.createdAt - b.createdAt) * factor;
    return a.cid.localeCompare(b.cid);
  }

  let primary = 0;
  switch (key) {
    case 'cluster':
      primary = a.cluster.localeCompare(b.cluster);
      break;
    case 'tier':
      primary = a.tier.localeCompare(b.tier);
      break;
    case 'stepCount':
      primary = a.stepCount - b.stepCount;
      break;
  }
  if (primary !== 0) return primary * factor;
  // Deterministic tie-break — cid order is stable under both directions.
  return a.cid.localeCompare(b.cid);
}

/**
 * Build the corpus index: a sorted, paginated list of published capture
 * envelopes. Seeds excluded by default. Ordering is server-side over the FULL
 * corpus before pagination (the URL is the state, spec §3.3) — default
 * `createdAt` desc, with un-enriched (null-timestamp) items sorting last and a
 * cid tie-break for determinism.
 */
export function buildCorpusList(
  metas: CaptureEnvelopeMetaRow[],
  opts: CorpusListOpts = {},
): CorpusListOutput {
  const includeSeeds = opts.includeSeeds ?? false;
  const limit = Math.min(Math.max(opts.limit ?? 25, 1), 200);
  const offset = Math.max(opts.offset ?? 0, 0);
  const sortKey: CorpusSortKey = CORPUS_SORT_KEYS.includes(opts.sort as CorpusSortKey)
    ? (opts.sort as CorpusSortKey)
    : 'createdAt';
  const dir = opts.dir === 'asc' ? 'asc' : 'desc';
  const factor: 1 | -1 = dir === 'desc' ? -1 : 1;

  let seedsExcluded = 0;
  const all: CorpusItemRow[] = [];
  for (const meta of metas) {
    if (meta.provenance === 'imported' && !includeSeeds) {
      seedsExcluded += 1;
      continue;
    }
    const tags = parseTags(meta.tagsJson);
    all.push({
      cid: meta.manifestCid,
      chainId: meta.chainId,
      summary: meta.taskSummary,
      cluster: tags[0] ?? '',
      tier: meta.verifiabilityTier,
      contributor: meta.contributor,
      model: meta.model ?? '',
      stepCount: meta.stepCount ?? 0,
      createdAt: coerceTimestamp(meta.createdAtTimestamp),
    });
  }

  // Cluster filter (#1414): exact, case-sensitive match on the primary tag,
  // applied AFTER the seed-exclusion loop (so seedsExcluded stays a pre-filter
  // provenance stat) and BEFORE sort/slice (so total reflects the filtered set).
  const filtered = opts.cluster
    ? all.filter((r) => r.cluster === opts.cluster)
    : all;

  filtered.sort((a, b) => compareCorpus(a, b, sortKey, factor));

  return {
    items: filtered.slice(offset, offset + limit),
    total: filtered.length,
    seedsExcluded,
    includeSeeds,
  };
}

export interface CorpusItemDetail {
  cid: string;
  chainId: number;
  summary: string;
  cluster: string;
  tags: string[];
  tier: string;
  contributor: string;
  harness: string;
  model: string;
  tools: string[];
  stepCount: number;
  provenance: string;
  /** MetadataSet anchor tx hash, '' when un-enriched. */
  anchorTx: string;
  /** Unix-seconds anchor timestamp, or null when un-enriched. */
  createdAt: number | null;
}

/**
 * Build one corpus item's detail from its indexed row, or null when the CID is
 * not in the corpus. Seeds are always resolvable by direct CID — the detail is
 * a deep-link target, not a signal reader. The per-step trace body lives in the
 * IPFS envelope (`cid`); the client follows the IPFS ref for it.
 */
export function buildCorpusItem(
  metas: CaptureEnvelopeMetaRow[],
  cid: string,
): CorpusItemDetail | null {
  const meta = metas.find((m) => m.manifestCid === cid);
  if (!meta) return null;
  const tags = parseTags(meta.tagsJson);
  let tools: string[] = [];
  if (meta.toolsJson) {
    try {
      const parsed = JSON.parse(meta.toolsJson) as unknown;
      if (Array.isArray(parsed)) tools = parsed.filter((t): t is string => typeof t === 'string');
    } catch {
      // malformed — no tools
    }
  }
  return {
    cid: meta.manifestCid,
    chainId: meta.chainId,
    summary: meta.taskSummary,
    cluster: tags[0] ?? '',
    tags,
    tier: meta.verifiabilityTier,
    contributor: meta.contributor,
    harness: meta.harness ?? '',
    model: meta.model ?? '',
    tools,
    stepCount: meta.stepCount ?? 0,
    provenance: meta.provenance,
    anchorTx: meta.anchorTx ?? '',
    createdAt: coerceTimestamp(meta.createdAtTimestamp),
  };
}
