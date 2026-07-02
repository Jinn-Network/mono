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
 * ebu7 dependency:
 *   Routes 3 (/plugins/:cid/scores) and 5 (/builders/:address/scores) require
 *   the `attemptEnvelopeMeta` and `verdict` indexer entities shipped by
 *   jinn-mono-ebu7. Until ebu7 merges, callers pass empty arrays for both and
 *   these functions return [] gracefully. The routes are additive — calling
 *   them from day one means the SPA picks up live data automatically when
 *   ebu7 lands, without changes to this file.
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
// These mirror client/src/discovery/types.ts PluginPublication /
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

interface EnvelopePluginEntry {
  name: string;
  version: string;
  cid?: string;
  sha256: string;
}

function normaliseSha(sha: string): string {
  return sha.replace(/^0x/i, '').toLowerCase();
}

function sha256Matches(pubSha: string, envSha: string): boolean {
  const a = normaliseSha(pubSha);
  const b = normaliseSha(envSha);
  return a.length === 64 && b.length === 64 && a === b;
}

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
  if (attemptEnvelopeMetas.length === 0 || verdicts.length === 0) return [];

  const pubByCid = new Map<string, PluginPublicationRow>();
  for (const p of publications) pubByCid.set(p.pluginCid, p);

  const verdictByReq = new Map<string, VerdictRow>();
  for (const v of verdicts) verdictByReq.set(v.requestId.toLowerCase(), v);

  const out: PluginScoreHistoryOutput[] = [];
  for (const meta of attemptEnvelopeMetas) {
    let plugins: EnvelopePluginEntry[] = [];
    try {
      plugins = JSON.parse(meta.pluginsJson) as EnvelopePluginEntry[];
    } catch {
      continue;
    }
    const verdict = verdictByReq.get(meta.requestId.toLowerCase());
    if (!verdict) continue;

    for (const entry of plugins) {
      if (!entry.cid) continue;
      const pub = pubByCid.get(entry.cid);
      if (!pub) continue;
      const forkSuspected = !sha256Matches(pub.pluginSha256, entry.sha256);
      const row: PluginScoreHistoryOutput = {
        pluginCid: pub.pluginCid,
        taskId: verdict.taskId,
        operatorAgentId: verdict.operatorAgentId,
        verdict: verdict.verdict,
        ts: verdict.ts,
        forkSuspected,
      };
      if (typeof verdict.score === 'number') row.score = verdict.score;
      out.push(row);
    }
  }
  return out;
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
  provenance: string;
  verifiabilityTier: string;
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
 * Mirrors client/packages/harness-layer/src/signal.ts computeSignal.
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
