/**
 * /explorer/* aggregation routes for the Jinn network explorer.
 *
 * Five routes:
 *   GET /explorer/network          — fleet-wide totals
 *   GET /explorer/solvernets       — one row per SolverNetManifest
 *   GET /explorer/solvernet/:cid   — per-SolverNet KPIs + learning curves
 *   GET /explorer/operators        — quality-first operator leaderboard
 *   GET /explorer/operator/:addr   — one operator across SolverNets
 *
 * Design references:
 *   spec/2026-05-12-network-explorer-design.md §3, §5, §6
 *   docs/superpowers/plans/2026-05-12-network-explorer-indexer-side.md Task B3
 *
 * Query strategy: thin route handlers — Drizzle queries → pure helpers from
 * metrics.ts → c.json(). No metric math lives here.
 *
 * bigint serialisation: all bigint values are converted to decimal strings
 * before being handed to c.json() because Hono/JSON.stringify cannot handle
 * native bigints.
 */
import { db } from 'ponder:api';
import schema from 'ponder:schema';
import { Hono } from 'hono';
// Drizzle query helpers — re-exported by Ponder so we don't take a direct
// dep on drizzle-orm (avoids the prod-install resolution miss we hit before).
import { and, count, countDistinct, sum, eq, inArray, max, sql } from 'ponder';
import {
  resolvedRateFromCounts,
  bucketResolvedRate,
  rollingResolvedRate,
  rankLeaderboard,
  freshness,
  composition,
  detectFreezeViolations,
  type LeaderboardRow,
} from './metrics.js';
import { withFreshness, type FreshnessMeta } from './freshness.js';
import { getChainHead } from './chain-head.js';

// ── Chain scope ───────────────────────────────────────────────────────────────

/**
 * The chain whose activity the explorer surfaces.
 * Revisit when 8453 (Base mainnet) is indexed — jinn-mono-280n.4.
 * Adding mainnet will require per-chain filtering throughout so testnet and
 * mainnet rows don't merge silently in the aggregations below.
 */
const EXPLORER_CHAIN_ID = 84532;

// ── Open-question constants (spec §9) ─────────────────────────────────────────

/**
 * Minimum number of verdicts (verdictsTotal) for a leaderboard row to appear
 * in the `ranked` partition rather than `lowVolume`.
 *
 * Spec §9 open question: pin value at impl. Chosen as 5 to match the minimum
 * statistically-meaningful sample size for a binary resolved-rate estimate.
 */
const DEFAULT_MIN_VERDICTS = 5;

/**
 * Default bucket width in blocks for the learning-curve time series.
 * ≈1 day on Base at ~12 s / block: 86400 / 12 = 7200.
 *
 * Spec §9 open question: callers may override via `?bucket=<n>`.
 */
const DEFAULT_BUCKET_BLOCKS = 7200n;

/**
 * Default window size for the rolling resolved-rate series.
 *
 * Spec §9 open question: pin value at impl.
 */
const DEFAULT_ROLLING_K = 50;

/**
 * Bucket width used for the per-SolverNet trend sparkline series on the
 * `/explorer/solvernets` index page (ebu7.7).
 *
 * Coarser than `DEFAULT_BUCKET_BLOCKS` (1 day) to keep the sparkline readable
 * at small sizes: ≈7 days on Base at ~12 s/block: 7 × 86400 / 12 = 50400.
 * Rounded to 50000 for cleanliness.
 */
const SPARKLINE_BUCKET_BLOCKS = 50000n;

/**
 * Number of trailing non-empty buckets to include in each net's sparkline.
 * 12 buckets ≈ 12 weeks — enough trajectory at a glance without overloading
 * the index response with data.
 */
const SPARKLINE_TRAILING_BUCKETS = 12;

// ── Hono context variable types ───────────────────────────────────────────────

type ExplorerVariables = {
  /** Indexer head stashed by the explorer-freshness middleware. */
  indexedHead: FreshnessMeta;
  /** Chain head block number, or null if the RPC is unavailable. */
  chainHead: bigint | null;
};

// ── Query-param parsers ───────────────────────────────────────────────────────

/**
 * Parse a positive-integer query param; fall back to `def` if missing or
 * non-parseable, clamp to [1, max].
 */
function parseIntParam(raw: string | undefined, def: number, max: number): number {
  if (raw === undefined) return def;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return def;
  return Math.min(n, max);
}

/**
 * Parse a positive-bigint query param; fall back to `def` if missing or
 * non-parseable, clamp to [1n, max].
 */
function parseBigIntParam(raw: string | undefined, def: bigint, max: bigint): bigint {
  if (raw === undefined) return def;
  let n: bigint;
  try { n = BigInt(raw); } catch { return def; }
  if (n < 1n) return def;
  return n > max ? max : n;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Returns the greatest of the maximum `createdAtBlock` values across the three
 * main event tables (task, attempt, verdict). Used as the indexer head proxy
 * for freshness middleware.
 *
 * Scoped to EXPLORER_CHAIN_ID so it reflects only the activity the explorer
 * surfaces.
 */
async function getIndexedHead(): Promise<bigint> {
  const [taskMax, attemptMax, verdictMax] = await Promise.all([
    db
      .select({ v: max(schema.task.createdAtBlock) })
      .from(schema.task)
      .where(eq(schema.task.chainId, EXPLORER_CHAIN_ID))
      .then((r) => r[0]?.v ?? null),
    db
      .select({ v: max(schema.attempt.createdAtBlock) })
      .from(schema.attempt)
      .where(eq(schema.attempt.chainId, EXPLORER_CHAIN_ID))
      .then((r) => r[0]?.v ?? null),
    db
      .select({ v: max(schema.verdict.createdAtBlock) })
      .from(schema.verdict)
      .where(eq(schema.verdict.chainId, EXPLORER_CHAIN_ID))
      .then((r) => r[0]?.v ?? null),
  ]);
  const candidates = [taskMax, attemptMax, verdictMax].filter(
    (v): v is bigint => v !== null,
  );
  if (candidates.length === 0) return 0n;
  return candidates.reduce((best, cur) => (cur > best ? cur : best), 0n);
}

/**
 * Explorer-specific freshness middleware.
 *
 * Computes the indexer head ONCE and stashes it on the Hono context as
 * `indexedHead` so route bodies can read it back with `c.get('indexedHead')`
 * instead of running a second getIndexedHead() query.
 *
 * Also fetches the chain-head block number (cached for 60 s via getChainHead)
 * and stashes it as `chainHead` so every route can pass it to freshness() and
 * get a real `behindHead` value. The chain-head fetch is done in parallel with
 * the DB query and does not block the route on a slow RPC — getChainHead()
 * resolves to null within ~1.5 s on timeout/error (and caches that null for
 * 60 s so subsequent callers aren't blocked).
 *
 * This is a thin wrapper around `withFreshness` that also sets the context
 * variables before calling next(). We handle the stash here rather than inside
 * the generic withFreshness so that module stays DB-free and testable.
 */
function explorerFreshness() {
  return withFreshness(async (c) => {
    // Parallel: DB head + chain-head RPC (cached; fast path is memory-only).
    const [lastIndexedBlock, chainHead] = await Promise.all([
      getIndexedHead(),
      getChainHead(),
    ]);
    const meta: FreshnessMeta = {
      lastIndexedBlock,
      lastIndexedAt: new Date().toISOString(),
    };
    // Stash for route body to read — avoids second DB / RPC round trips.
    c.set('indexedHead', meta);
    c.set('chainHead', chainHead);
    return meta;
  });
}

// ── App ───────────────────────────────────────────────────────────────────────

const app = new Hono<{ Variables: ExplorerVariables }>();

// ── GET /explorer/network ─────────────────────────────────────────────────────

app.use('/network', explorerFreshness());

/**
 * GET /explorer/network
 *
 * Fleet-wide totals plus envelope-enrichment facets.
 *
 * New fields (ebu7.6):
 *   `composition.byMode`    — distribution of attempts by executor mode ('train'|'frozen'|'unknown')
 *   `composition.byHarness` — distribution of attempts by implName; empty implName is included as
 *                              '(unknown)' so callers always get a complete picture.
 *   `enrichmentCoverage`    — how many attempts have an AttemptEnvelopeMeta row (IPFS-enriched)
 *                             vs total attempts; lets the SPA warn when coverage is low.
 */
app.get('/network', async (c) => {
  const [taskStats, attemptStats, verdictRows, rewardStats, snStats, enrichmentRows, totalAttemptCount] =
    await Promise.all([
      // Task counts — scoped to EXPLORER_CHAIN_ID
      db
        .select({
          total: count(),
          settled: count(
            sql`CASE WHEN ${schema.task.finalized} = true THEN 1 END`,
          ),
          refunded: count(
            sql`CASE WHEN ${schema.task.refunded} = true THEN 1 END`,
          ),
          mostRecentSettlementBlock: max(
            sql`CASE WHEN ${schema.task.finalized} = true THEN ${schema.task.createdAtBlock} END`,
          ),
        })
        .from(schema.task)
        .where(eq(schema.task.chainId, EXPLORER_CHAIN_ID)),

      // Attempt counts — scoped to EXPLORER_CHAIN_ID
      db
        .select({
          total: count(),
          distinctOperators: countDistinct(schema.attempt.operator),
        })
        .from(schema.attempt)
        .where(eq(schema.attempt.chainId, EXPLORER_CHAIN_ID)),

      // Verdicts (all rows for rate calc) — scoped to EXPLORER_CHAIN_ID
      db
        .select({
          total: count(),
          pass: count(
            sql`CASE WHEN ${schema.verdict.verdictCode} = 1 THEN 1 END`,
          ),
        })
        .from(schema.verdict)
        .where(eq(schema.verdict.chainId, EXPLORER_CHAIN_ID)),

      // Reward distributions — intentionally unfiltered by chainId:
      // JinnDistributor lives on Sepolia L1 (11155111) and JINN distributed
      // is reported network-wide across all execution chains.
      db
        .select({
          jinnOperator: sum(schema.rewardDistribution.operatorMinted),
          jinnDao: sum(schema.rewardDistribution.daoMinted),
        })
        .from(schema.rewardDistribution),

      // SolverNets running — scoped to EXPLORER_CHAIN_ID
      db
        .select({ running: count() })
        .from(schema.solverNetManifest)
        .where(
          and(
            eq(schema.solverNetManifest.status, 'launched'),
            eq(schema.solverNetManifest.chainId, EXPLORER_CHAIN_ID),
          ),
        ),

      // Envelope enrichment: mode + implName per enriched attempt, scoped to EXPLORER_CHAIN_ID.
      // No join to `attempt` needed — every attemptEnvelopeMeta row corresponds to an attempt
      // (the requestId FK) and is already chain-scoped.
      db
        .select({
          mode: schema.attemptEnvelopeMeta.mode,
          implName: schema.attemptEnvelopeMeta.implName,
        })
        .from(schema.attemptEnvelopeMeta)
        .where(eq(schema.attemptEnvelopeMeta.chainId, EXPLORER_CHAIN_ID)),

      // Total attempt count for enrichmentCoverage.share denominator — scoped to EXPLORER_CHAIN_ID.
      db
        .select({ total: count() })
        .from(schema.attempt)
        .where(eq(schema.attempt.chainId, EXPLORER_CHAIN_ID)),
    ]);

  const tRow = taskStats[0];
  const aRow = attemptStats[0];
  const vRow = verdictRows[0];
  const rRow = rewardStats[0];
  const snRow = snStats[0];

  const verdictsTotal = Number(vRow?.total ?? 0);
  const verdictsPass = Number(vRow?.pass ?? 0);
  const resolvedRate = resolvedRateFromCounts(verdictsPass, verdictsTotal);

  // Envelope-sourced composition facets
  // Empty implName is included as '(unknown)' so callers get a complete picture.
  const byMode = composition(enrichmentRows, (r) => r.mode || 'unknown');
  const byHarness = composition(enrichmentRows, (r) => r.implName || '(unknown)');

  // Enrichment coverage
  const enrichedAttempts = enrichmentRows.length;
  const totalAttempts = Number(totalAttemptCount[0]?.total ?? 0);
  const enrichmentCoverage = {
    enrichedAttempts,
    totalAttempts,
    share: totalAttempts === 0 ? 0 : enrichedAttempts / totalAttempts,
  };

  // Read the heads computed by the middleware — no second DB / RPC round trips.
  const meta = c.get('indexedHead');
  const chainHead = c.get('chainHead');
  const freshnessFields = freshness(meta.lastIndexedBlock, meta.lastIndexedAt, chainHead ?? undefined);

  return c.json({
    tasksPosted: Number(tRow?.total ?? 0),
    tasksSettled: Number(tRow?.settled ?? 0),
    tasksRefunded: Number(tRow?.refunded ?? 0),
    attempts: Number(aRow?.total ?? 0),
    distinctOperators: Number(aRow?.distinctOperators ?? 0),
    solverNetsRunning: Number(snRow?.running ?? 0),
    verdicts: verdictsTotal,
    verdictsPass,
    resolvedRate,
    jinnDistributedOperator: rRow?.jinnOperator ?? '0',
    jinnDistributedDao: rRow?.jinnDao ?? '0',
    mostRecentSettlementBlock:
      tRow?.mostRecentSettlementBlock !== null &&
      tRow?.mostRecentSettlementBlock !== undefined
        ? String(tRow.mostRecentSettlementBlock)
        : null,
    composition: { byMode, byHarness },
    enrichmentCoverage,
    ...freshnessFields,
  });
});

// ── GET /explorer/solvernets ──────────────────────────────────────────────────

app.use('/solvernets', explorerFreshness());

/**
 * GET /explorer/solvernets
 *
 * One row per indexed SolverNet, including:
 *   - Standard stats (tasksPosted, tasksSettled, attempts, verdicts, verdictsPass, resolvedRate)
 *   - `recentResolvedRateSeries` — a short trailing resolved-rate series for sparkline rendering.
 *
 * `recentResolvedRateSeries`:
 *   Computed via a single batch GROUP BY query over `verdict ⋈ task` grouped by
 *   `(task.manifestDigest, floor(verdict.createdAtBlock / SPARKLINE_BUCKET_BLOCKS))`.
 *   Bucket width = `SPARKLINE_BUCKET_BLOCKS` (≈7 days on Base at 12s/block).
 *   The last `SPARKLINE_TRAILING_BUCKETS` non-empty buckets' pass/total rates are
 *   returned per net, ascending (oldest first). Empty when a net has no verdicts.
 */
app.get('/solvernets', async (c) => {
  const manifests = await db
    .select()
    .from(schema.solverNetManifest)
    .where(eq(schema.solverNetManifest.chainId, EXPLORER_CHAIN_ID));

  // Batch-load all stats in O(1) round trips instead of O(N).
  const statsByDigest = await getSolverNetStatsBatch(
    manifests.map((m) => m.cidKeccak),
  );

  // Batch-load sparkline series in one extra query — all manifests at once.
  const sparklinesByDigest = await getSolverNetSparklinesBatch(
    manifests.map((m) => m.cidKeccak),
  );

  const rows = manifests.map((m) => ({
    cid: m.id,
    status: m.status,
    launcherAgentId: m.launcherAgentId,
    statusUpdatedAt: m.statusUpdatedAt,
    ...statsByDigest.get(m.cidKeccak),
    recentResolvedRateSeries: sparklinesByDigest.get(m.cidKeccak) ?? [],
  }));

  // Read the heads computed by the middleware — no second DB / RPC round trips.
  const meta = c.get('indexedHead');
  const chainHead = c.get('chainHead');
  const freshnessFields = freshness(meta.lastIndexedBlock, meta.lastIndexedAt, chainHead ?? undefined);

  return c.json({ solvernets: rows, ...freshnessFields });
});

// ── GET /explorer/solvernet/:cid ──────────────────────────────────────────────

app.use('/solvernet/:cid', explorerFreshness());

/**
 * GET /explorer/solvernet/:cid
 *
 * Per-SolverNet KPIs, learning curves, and (ebu7.6) mode-split leaderboards,
 * checkpoint timeline, and freeze-integrity diagnostics.
 *
 * New fields (ebu7.6):
 *   `trainBoard`        — operator leaderboard restricted to mode='train' attempts in this net.
 *   `frozenBoard`       — operator leaderboard restricted to mode='frozen' attempts in this net.
 *                         Operators can appear in both boards. jinnEarned is 0n in both boards
 *                         because reward attribution is fleet-wide and cannot be split by mode.
 *   `checkpointTimeline` — all harnessCheckpoint rows (on-chain anchors only) sorted by
 *                           publishedAtBlock asc. Per-checkpoint frozen-eval score is absent
 *                           (pending checkpoint-manifest enrichment — harnessCheckpoint.codeDigest
 *                           not yet populated).
 *   `freezeIntegrity`   — detectFreezeViolations result for this net's frozen attempts plus
 *                          verifiedFrozenShare (share of frozen attempts whose
 *                          attemptEnvelopeMeta.sourcePublished=true).
 *
 * Query params:
 *   `?bucket=<n>`  — bucket width in blocks for the learning curve (default 7200, max 1 000 000)
 *   `?k=<n>`       — rolling-window size for the rolling curve (default 50, max 1000)
 *   `?minVerdicts=<n>` — minimum verdicts for ranked partition in train/frozen boards (default 5)
 */
app.get('/solvernet/:cid', async (c) => {
  const cid = c.req.param('cid');

  const manifests = await db
    .select()
    .from(schema.solverNetManifest)
    .where(
      and(
        eq(schema.solverNetManifest.id, cid),
        eq(schema.solverNetManifest.chainId, EXPLORER_CHAIN_ID),
      ),
    );

  if (manifests.length === 0) {
    return c.json({ error: 'unknown solvernet' }, 404);
  }

  const m = manifests[0];

  // Parse query params — use defensive helpers so malformed values fall back to
  // defaults instead of throwing (BigInt) or silently producing NaN.
  const bucketBlocks = parseBigIntParam(
    c.req.query('bucket'),
    DEFAULT_BUCKET_BLOCKS,
    1_000_000n,
  );
  const rollingK = parseIntParam(c.req.query('k'), DEFAULT_ROLLING_K, 1000);
  const minVerdicts = parseIntParam(
    c.req.query('minVerdicts'),
    DEFAULT_MIN_VERDICTS,
    1000,
  );

  // Reuse the batch helper with a one-element array so the stats shape is
  // identical to what /solvernets uses.
  const statsByDigest = await getSolverNetStatsBatch([m.cidKeccak]);
  const stats = statsByDigest.get(m.cidKeccak);

  // Fetch verdicts for this SolverNet's tasks (ordered by block for curves)
  const taskIds = await db
    .select({ id: schema.task.id })
    .from(schema.task)
    .where(
      and(
        eq(schema.task.manifestDigest, m.cidKeccak),
        eq(schema.task.chainId, EXPLORER_CHAIN_ID),
      ),
    );

  const ids = taskIds.map((t) => t.id);

  const [verdictRows, trainBoardRows, frozenBoardRows, checkpointRows, frozenEnvelopeRows] =
    await Promise.all([
      // Verdicts for learning curves
      ids.length > 0
        ? db
            .select({
              verdictCode: schema.verdict.verdictCode,
              createdAtBlock: schema.verdict.createdAtBlock,
            })
            .from(schema.verdict)
            .where(
              and(
                inArray(schema.verdict.taskId, ids),
                eq(schema.verdict.chainId, EXPLORER_CHAIN_ID),
              ),
            )
            .orderBy(schema.verdict.createdAtBlock)
        : Promise.resolve([]),

      // Train board — mode-filtered leaderboard for this SolverNet
      buildLeaderboardRows({ manifestDigest: m.cidKeccak, mode: 'train' }),

      // Frozen board — mode-filtered leaderboard for this SolverNet
      buildLeaderboardRows({ manifestDigest: m.cidKeccak, mode: 'frozen' }),

      // HarnessCheckpoint rows (all on-chain anchors — not scoped to a SolverNet
      // since the harnessCheckpoint schema has no SolverNet link; we return all
      // of them sorted by publishedAtBlock asc). ebu7.9: also select the
      // IPFS-enriched manifest body fields.
      db
        .select({
          cid: schema.harnessCheckpoint.cid,
          agentId: schema.harnessCheckpoint.agentId,
          publishedAtBlock: schema.harnessCheckpoint.publishedAtBlock,
          name: schema.harnessCheckpoint.name,
          version: schema.harnessCheckpoint.version,
          codeDigest: schema.harnessCheckpoint.codeDigest,
          parentCheckpointCid: schema.harnessCheckpoint.parentCheckpointCid,
          implStateDirCid: schema.harnessCheckpoint.implStateDirCid,
          implName: schema.harnessCheckpoint.implName,
          implVersion: schema.harnessCheckpoint.implVersion,
          sourceBundleCid: schema.harnessCheckpoint.sourceBundleCid,
          enrichmentStatus: schema.harnessCheckpoint.enrichmentStatus,
        })
        .from(schema.harnessCheckpoint)
        .where(eq(schema.harnessCheckpoint.chainId, EXPLORER_CHAIN_ID))
        .orderBy(schema.harnessCheckpoint.publishedAtBlock),

      // Frozen attemptEnvelopeMeta rows for this SolverNet — for freeze integrity.
      // Join attemptEnvelopeMeta → attempt → task by manifestDigest.
      ids.length > 0
        ? db
            .select({
              operator: schema.attempt.operator,
              codeDigest: schema.attemptEnvelopeMeta.codeDigest,
              sourcePublished: schema.attemptEnvelopeMeta.sourcePublished,
            })
            .from(schema.attemptEnvelopeMeta)
            .innerJoin(
              schema.attempt,
              and(
                eq(schema.attemptEnvelopeMeta.requestId, schema.attempt.requestId),
                eq(schema.attempt.chainId, EXPLORER_CHAIN_ID),
              ),
            )
            .where(
              and(
                inArray(schema.attempt.taskId, ids),
                eq(schema.attemptEnvelopeMeta.chainId, EXPLORER_CHAIN_ID),
                eq(schema.attemptEnvelopeMeta.mode, 'frozen'),
              ),
            )
        : Promise.resolve([]),
    ]);

  const samples = verdictRows.map((v) => ({
    block: v.createdAtBlock,
    pass: v.verdictCode === 1,
  }));

  const learningCurveBuckets = bucketResolvedRate(samples, bucketBlocks);
  const learningCurveRolling = rollingResolvedRate(
    verdictRows.map((v) => v.verdictCode === 1),
    rollingK,
  );

  // Rank train and frozen boards
  const trainBoard = rankLeaderboard(trainBoardRows, minVerdicts);
  const frozenBoard = rankLeaderboard(frozenBoardRows, minVerdicts);

  // Checkpoint timeline — ebu7.9: include enriched manifest body fields and
  // per-checkpoint frozen-eval score (frozenResolvedRate).
  //
  // frozenResolvedRate: pass/total rate of mode='frozen' attempts in THIS
  // SolverNet whose attemptEnvelopeMeta.codeDigest matches the checkpoint's
  // codeDigest. We batch this: one pass over frozenEnvelopeRows (already loaded
  // for freeze integrity) + their corresponding verdicts.
  //
  // TODO: batch the verdict lookup per codeDigest in a single query for
  // production scale. At testnet scale (small row counts) the in-process join
  // is fine; a dedicated batch query is a perf optimisation with no functional
  // impact (deferred — file as its own bead).
  //
  // Build: codeDigest → { pass, total } from frozen attempts in this SolverNet.
  // frozenEnvelopeRows has { operator, codeDigest, sourcePublished } for mode='frozen'
  // attempts. We need verdicts for those attempts; they're already in `allVerdicts`
  // fetched for the leaderboard... but `allVerdicts` isn't available here — it's
  // inside buildLeaderboardRows. Re-query verdicts for frozen attempts directly.
  //
  // Simpler approach: we have frozenEnvelopeRows keyed by (operator, codeDigest,
  // sourcePublished). We need the requestIds for those attempts to join to verdicts.
  // Instead, use a separate per-codeDigest verdict query for each checkpoint that
  // has a non-empty codeDigest (with a // TODO: batch comment as instructed).

  // Build a map from codeDigest → frozenResolvedRate for all distinct codeDigests
  // present in the checkpoint rows that have enrichmentStatus='ok'.
  const enrichedCkptDigests = [
    ...new Set(
      checkpointRows
        .filter((r) => r.enrichmentStatus === 'ok' && r.codeDigest)
        .map((r) => r.codeDigest),
    ),
  ];

  // For each distinct codeDigest, compute pass/total from frozen attemptEnvelopeMeta
  // rows in this SolverNet (by joining attempt → task → manifestDigest). We iterate
  // in a loop here; TODO(perf): batch into a single GROUP BY query when row counts grow.
  const frozenRateByDigest = new Map<string, number | null>();
  if (enrichedCkptDigests.length > 0 && ids.length > 0) {
    for (const digest of enrichedCkptDigests) {
      // Count frozen attempts with this codeDigest in this SolverNet.
      // frozenEnvelopeRows is already filtered to mode='frozen' + this net's taskIds.
      const matchingFrozen = frozenEnvelopeRows.filter((r) => r.codeDigest === digest);
      if (matchingFrozen.length === 0) {
        frozenRateByDigest.set(digest, null);
        continue;
      }
      // We need verdict counts for those attempts. frozenEnvelopeRows doesn't carry
      // verdicts; they live in the verdict table. Get request IDs from the join.
      // Since we already have operator+codeDigest but not requestId, we need an
      // additional query. The frozen envelope rows were fetched via:
      //   attemptEnvelopeMeta JOIN attempt WHERE taskId IN ids AND mode='frozen'
      // We need requestIds for these rows to look up verdicts. Re-query with requestId.
      // TODO(perf): merge this into the main frozenEnvelopeRows query above.
      const frozenAttemptRows =
        ids.length > 0
          ? await db
              .select({
                requestId: schema.attempt.requestId,
                taskId: schema.attempt.taskId,
                attemptIndex: schema.attempt.attemptIndex,
              })
              .from(schema.attemptEnvelopeMeta)
              .innerJoin(
                schema.attempt,
                and(
                  eq(schema.attemptEnvelopeMeta.requestId, schema.attempt.requestId),
                  eq(schema.attempt.chainId, EXPLORER_CHAIN_ID),
                ),
              )
              .where(
                and(
                  inArray(schema.attempt.taskId, ids),
                  eq(schema.attemptEnvelopeMeta.chainId, EXPLORER_CHAIN_ID),
                  eq(schema.attemptEnvelopeMeta.mode, 'frozen'),
                  eq(schema.attemptEnvelopeMeta.codeDigest, digest),
                ),
              )
          : [];

      if (frozenAttemptRows.length === 0) {
        frozenRateByDigest.set(digest, null);
        continue;
      }

      // Get verdicts for these attempts.
      const pairs = frozenAttemptRows.map((a) => ({
        taskId: a.taskId,
        attemptIndex: a.attemptIndex,
      }));
      const frozenVerdicts = await getVerdictsForAttempts(pairs);
      const total = frozenVerdicts.length;
      const pass = frozenVerdicts.filter((v) => v.verdictCode === 1).length;
      frozenRateByDigest.set(digest, resolvedRateFromCounts(pass, total));
    }
  }

  // Determine whether any checkpoints still need enrichment for the note.
  const pendingCount = checkpointRows.filter(
    (r) => r.enrichmentStatus === 'pending' || r.enrichmentStatus === 'failed',
  ).length;
  const checkpointNote =
    pendingCount > 0
      ? `${pendingCount} checkpoint(s) pending IPFS enrichment — frozen-eval scores may be incomplete`
      : '';

  const checkpointTimeline = {
    checkpoints: checkpointRows.map((r) => {
      const codeDigest = r.codeDigest ?? '';
      const frozenResolvedRate =
        r.enrichmentStatus === 'ok' && codeDigest
          ? (frozenRateByDigest.get(codeDigest) ?? null)
          : null;
      const verifiedFrozen = r.sourceBundleCid != null && r.sourceBundleCid !== '';
      return {
        cid: r.cid,
        agentId: r.agentId,
        publishedAtBlock: String(r.publishedAtBlock),
        name: r.name ?? '',
        version: r.version ?? '',
        codeDigest,
        parentCheckpointCid: r.parentCheckpointCid ?? null,
        implName: r.implName ?? '',
        implVersion: r.implVersion ?? '',
        sourceBundleCid: r.sourceBundleCid ?? '',
        enrichmentStatus: r.enrichmentStatus ?? 'pending',
        frozenResolvedRate,
        verifiedFrozen,
      };
    }),
    note: checkpointNote,
  };

  // Freeze integrity
  const frozenCount = frozenEnvelopeRows.length;
  const verifiedFrozenCount = frozenEnvelopeRows.filter((r) => r.sourcePublished).length;
  const violations = detectFreezeViolations(
    frozenEnvelopeRows.map((r) => ({
      operator: r.operator,
      codeDigest: r.codeDigest,
    })),
  );
  const freezeIntegrity = {
    violations,
    verifiedFrozenShare: frozenCount === 0 ? 0 : verifiedFrozenCount / frozenCount,
    frozenAttempts: frozenCount,
  };

  // Read the heads computed by the middleware — no second DB / RPC round trips.
  const meta = c.get('indexedHead');
  const chainHead = c.get('chainHead');
  const freshnessFields = freshness(meta.lastIndexedBlock, meta.lastIndexedAt, chainHead ?? undefined);

  return c.json({
    cid: m.id,
    status: m.status,
    launcherAgentId: m.launcherAgentId,
    statusUpdatedAt: m.statusUpdatedAt,
    ...stats,
    learningCurveBuckets,
    learningCurveRolling,
    trainBoard: {
      ranked: trainBoard.ranked.map((r) => ({ ...r, jinnEarned: r.jinnEarned.toString() })),
      lowVolume: trainBoard.lowVolume.map((r) => ({ ...r, jinnEarned: r.jinnEarned.toString() })),
    },
    frozenBoard: {
      ranked: frozenBoard.ranked.map((r) => ({ ...r, jinnEarned: r.jinnEarned.toString() })),
      lowVolume: frozenBoard.lowVolume.map((r) => ({ ...r, jinnEarned: r.jinnEarned.toString() })),
    },
    checkpointTimeline,
    freezeIntegrity,
    ...freshnessFields,
  });
});

// ── GET /explorer/operators ───────────────────────────────────────────────────

app.use('/operators', explorerFreshness());

/**
 * GET /explorer/operators
 *
 * Returns ranked and low-volume operator leaderboard rows.
 *
 * Response shape:
 * ```json
 * {
 *   "ranked": [...],
 *   "lowVolume": [...],
 *   "minVerdicts": 5,
 *   "appliedFilters": {},          // present when ?mode or ?harness is set
 *   "meta": { "jinnAttribution": "pending" },
 *   "lastIndexedBlock": "...",
 *   "lastIndexedAt": "...",
 *   "behindHead": null
 * }
 * ```
 *
 * `meta.jinnAttribution`:
 *   - `"pending"` — every operator has jinnEarned = 0n (rewardDistribution.multisig
 *     ↔ attempt.operator mapping not yet resolved — see spec §6.4).
 *   - `"ok"` — at least one operator has non-zero jinnEarned; attribution is live.
 *
 * New fields per row (ebu7.6):
 *   `dominantMode`    — modal executor mode among this operator's enriched attempts
 *                       ('train'|'frozen'|'unknown'). 'unknown' when no enriched attempts.
 *   `dominantHarness` — modal implName among this operator's enriched attempts.
 *                       '(unknown)' when no enriched attempts.
 *
 * New query params (ebu7.6):
 *   `?mode=train|frozen`  — restrict leaderboard to attempts with this mode.
 *                           Attempts without an AttemptEnvelopeMeta row are excluded.
 *                           When active, jinnEarned is 0 (reward attribution is fleet-wide).
 *   `?harness=<implName>` — restrict to attempts whose AttemptEnvelopeMeta.implName matches.
 *                           Stacks with ?mode. When active, jinnEarned is 0.
 */
app.get('/operators', async (c) => {
  const minVerdicts = parseIntParam(
    c.req.query('minVerdicts'),
    DEFAULT_MIN_VERDICTS,
    1000,
  );

  const modeParam = c.req.query('mode');
  const harnessParam = c.req.query('harness');

  // Determine if any filter is active. Both mode and harness can stack.
  // If harness filter is set, we use a dedicated query rather than the leaderboard
  // builder (which only supports mode). If only mode is set, delegate to
  // buildLeaderboardRows. If both, handle here.
  const hasFilter = modeParam !== undefined || harnessParam !== undefined;

  let rows: LeaderboardRow[];
  if (harnessParam !== undefined) {
    // Harness filter (optionally + mode): load attempts via an inner join on
    // attemptEnvelopeMeta filtered by implName (and optionally mode), then build
    // leaderboard rows in-process.
    rows = await buildLeaderboardRowsWithHarnessFilter(modeParam, harnessParam);
  } else if (modeParam !== undefined) {
    rows = await buildLeaderboardRows({ mode: modeParam });
  } else {
    rows = await buildLeaderboardRows();
  }

  // Dominant mode/harness per operator — load enriched attempts for all operators
  // and compute the modal mode/implName. Only needed for operators in `rows`.
  const operatorAddrs = rows.map((r) => r.operator);
  const dominantMap = await getDominantModeAndHarness(operatorAddrs);

  const { ranked, lowVolume } = rankLeaderboard(rows, minVerdicts);

  const allJinnEarnedZero = rows.every((r) => r.jinnEarned === 0n);

  // Applied filters — only included when at least one filter is active.
  const appliedFilters: Record<string, string> = {};
  if (modeParam !== undefined) appliedFilters['mode'] = modeParam;
  if (harnessParam !== undefined) appliedFilters['harness'] = harnessParam;

  // Read the heads computed by the middleware — no second DB / RPC round trips.
  const meta = c.get('indexedHead');
  const chainHead = c.get('chainHead');
  const freshnessFields = freshness(meta.lastIndexedBlock, meta.lastIndexedAt, chainHead ?? undefined);

  const serializeRow = (r: LeaderboardRow & { rank?: number }) => ({
    ...r,
    jinnEarned: r.jinnEarned.toString(),
    dominantMode: dominantMap.get(r.operator)?.mode ?? 'unknown',
    dominantHarness: dominantMap.get(r.operator)?.harness ?? '(unknown)',
  });

  return c.json({
    ranked: ranked.map(serializeRow),
    lowVolume: lowVolume.map(serializeRow),
    minVerdicts,
    ...(hasFilter ? { appliedFilters } : {}),
    meta: { jinnAttribution: allJinnEarnedZero ? 'pending' : 'ok' },
    ...freshnessFields,
  });
});

// ── GET /explorer/operator/:addr ──────────────────────────────────────────────

app.use('/operator/:addr', explorerFreshness());

/**
 * GET /explorer/operator/:addr
 *
 * Returns per-SolverNet breakdown and totals for one operator address.
 *
 * Response shape:
 * ```json
 * {
 *   "operator": "0x...",
 *   "dominantMode": "train",
 *   "dominantHarness": "claude-code-learner",
 *   "dominantSolverType": "swe-rebench-v2.v1",
 *   "perSolverNet": [
 *     {
 *       "cid": "...",
 *       "status": "launched",
 *       "attempts": 0,
 *       "settledContribution": 0,
 *       "verdictsTotal": 0,
 *       "verdictsPass": 0,
 *       "resolvedRate": null,
 *       "modeBreakdown": [{ "value": "train", "count": 3, "share": 1 }]
 *     }
 *   ],
 *   "totals": {
 *     "attempts": 0,
 *     "settledContribution": 0,
 *     "verdictsTotal": 0,
 *     "verdictsPass": 0,
 *     "resolvedRate": null,
 *     "jinnEarned": "0"
 *   },
 *   "meta": { "jinnAttribution": "pending" },
 *   "lastIndexedBlock": "...",
 *   "lastIndexedAt": "...",
 *   "behindHead": null
 * }
 * ```
 *
 * `meta.jinnAttribution`:
 *   - `"pending"` — jinnEarned is "0", meaning the rewardDistribution.multisig
 *     ↔ attempt.operator join found no matching rows for this operator.
 *   - `"ok"` — jinnEarned > "0"; attribution is live.
 *
 * New fields (ebu7.6):
 *   `dominantMode`       — modal executor mode among this operator's enriched attempts.
 *                          'unknown' when no enriched attempts.
 *   `dominantHarness`    — modal implName. '(unknown)' when no enriched attempts.
 *   `dominantSolverType` — modal solverType. '(unknown)' when no enriched attempts.
 *   `modeBreakdown`      — composition(enriched attempts in this SolverNet, r => r.mode);
 *                          empty array when no enriched attempts for that SolverNet.
 */
app.get('/operator/:addr', async (c) => {
  const addr = c.req.param('addr').toLowerCase() as `0x${string}`;

  // All attempts by this operator — scoped to EXPLORER_CHAIN_ID
  const operatorAttempts = await db
    .select()
    .from(schema.attempt)
    .where(
      and(
        eq(schema.attempt.operator, addr),
        eq(schema.attempt.chainId, EXPLORER_CHAIN_ID),
      ),
    );

  // Read the heads computed by the middleware — no second DB / RPC round trips.
  const meta = c.get('indexedHead');
  const chainHead = c.get('chainHead');
  const freshnessFields = freshness(meta.lastIndexedBlock, meta.lastIndexedAt, chainHead ?? undefined);

  if (operatorAttempts.length === 0) {
    return c.json({
      operator: addr,
      dominantMode: 'unknown',
      dominantHarness: '(unknown)',
      dominantSolverType: '(unknown)',
      perSolverNet: [],
      totals: {
        attempts: 0,
        settledContribution: 0,
        verdictsTotal: 0,
        verdictsPass: 0,
        resolvedRate: null,
        jinnEarned: '0',
      },
      meta: { jinnAttribution: 'pending' },
      ...freshnessFields,
    });
  }

  // Get all tasks for finalization status — scoped to EXPLORER_CHAIN_ID
  const taskIds = [...new Set(operatorAttempts.map((a) => a.taskId))];
  const tasks =
    taskIds.length > 0
      ? await db
          .select({ id: schema.task.id, manifestDigest: schema.task.manifestDigest, finalized: schema.task.finalized })
          .from(schema.task)
          .where(
            and(
              inArray(schema.task.id, taskIds),
              eq(schema.task.chainId, EXPLORER_CHAIN_ID),
            ),
          )
      : [];
  const taskMap = new Map(tasks.map((t) => [t.id, t]));

  // Get all verdicts for this operator's attempts — scoped to EXPLORER_CHAIN_ID
  const attemptPairs = operatorAttempts.map((a) => ({
    taskId: a.taskId,
    attemptIndex: a.attemptIndex,
  }));
  const verdictRows = await getVerdictsForAttempts(attemptPairs);

  // Envelope enrichment for this operator's attempts — for dominant dims + modeBreakdown.
  // Join via requestId (attempt.requestId = attemptEnvelopeMeta.requestId).
  const requestIds = operatorAttempts.map((a) => a.requestId);
  const envelopeRows =
    requestIds.length > 0
      ? await db
          .select({
            requestId: schema.attemptEnvelopeMeta.requestId,
            mode: schema.attemptEnvelopeMeta.mode,
            implName: schema.attemptEnvelopeMeta.implName,
            solverType: schema.attemptEnvelopeMeta.solverType,
          })
          .from(schema.attemptEnvelopeMeta)
          .where(
            and(
              inArray(schema.attemptEnvelopeMeta.requestId, requestIds),
              eq(schema.attemptEnvelopeMeta.chainId, EXPLORER_CHAIN_ID),
            ),
          )
      : [];

  // Build a map from requestId → envelope for per-SolverNet modeBreakdown
  const envelopeByRequestId = new Map(envelopeRows.map((e) => [e.requestId, e]));

  // Build per-SolverNet breakdown
  const manifests = await db
    .select()
    .from(schema.solverNetManifest)
    .where(eq(schema.solverNetManifest.chainId, EXPLORER_CHAIN_ID));
  const manifestByCidKeccak = new Map(
    manifests.map((m) => [m.cidKeccak, m]),
  );

  // Group attempts by solvernet, collecting envelope info per SolverNet
  const snMap = new Map<
    string,
    {
      cid: string;
      status: string;
      attempts: number;
      settledContribution: number;
      verdictsTotal: number;
      verdictsPass: number;
      // envelope info for this net's attempts (for modeBreakdown)
      envelopeModes: string[];
    }
  >();

  for (const a of operatorAttempts) {
    const task = taskMap.get(a.taskId);
    const manifestDigest = task?.manifestDigest;
    const manifest = manifestDigest
      ? manifestByCidKeccak.get(manifestDigest)
      : undefined;
    const snCid = manifest?.id ?? '_unknown';
    const snStatus = manifest?.status ?? 'unknown';

    const existing = snMap.get(snCid);
    const settled = task?.finalized ? 1 : 0;
    const envelope = envelopeByRequestId.get(a.requestId);
    if (existing) {
      existing.attempts += 1;
      existing.settledContribution += settled;
      if (envelope) existing.envelopeModes.push(envelope.mode);
    } else {
      snMap.set(snCid, {
        cid: snCid,
        status: snStatus,
        attempts: 1,
        settledContribution: settled,
        verdictsTotal: 0,
        verdictsPass: 0,
        envelopeModes: envelope ? [envelope.mode] : [],
      });
    }
  }

  // Assign verdict counts to solvernet rows
  for (const v of verdictRows) {
    const task = taskMap.get(v.taskId);
    const manifestDigest = task?.manifestDigest;
    const manifest = manifestDigest
      ? manifestByCidKeccak.get(manifestDigest)
      : undefined;
    const snCid = manifest?.id ?? '_unknown';
    const row = snMap.get(snCid);
    if (row) {
      row.verdictsTotal += 1;
      if (v.verdictCode === 1) row.verdictsPass += 1;
    }
  }

  const perSolverNet = [...snMap.values()].map((row) => ({
    cid: row.cid,
    status: row.status,
    attempts: row.attempts,
    settledContribution: row.settledContribution,
    verdictsTotal: row.verdictsTotal,
    verdictsPass: row.verdictsPass,
    resolvedRate: resolvedRateFromCounts(row.verdictsPass, row.verdictsTotal),
    // modeBreakdown: composition of enriched attempts in this SolverNet by mode
    modeBreakdown: composition(
      row.envelopeModes.map((m) => ({ mode: m })),
      (x) => x.mode,
    ),
  }));

  // Totals
  const totalAttempts = operatorAttempts.length;
  const totalSettled = operatorAttempts.filter(
    (a) => taskMap.get(a.taskId)?.finalized,
  ).length;
  const totalVerdictsTotal = verdictRows.length;
  const totalVerdictsPass = verdictRows.filter((v) => v.verdictCode === 1).length;
  const totalResolvedRate = resolvedRateFromCounts(totalVerdictsPass, totalVerdictsTotal);

  // Dominant dims across all enriched attempts for this operator
  const dominantDims = computeDominantDims(envelopeRows);

  // JINN earned — intentionally unfiltered by chainId:
  // rewardDistribution is on Sepolia L1 (11155111) and JINN distributed
  // is reported network-wide across all execution chains.
  const rewards = await db
    .select({ minted: sum(schema.rewardDistribution.operatorMinted) })
    .from(schema.rewardDistribution)
    .where(eq(schema.rewardDistribution.multisig, addr));
  const jinnEarned = rewards[0]?.minted ?? '0';
  const jinnEarnedStr = jinnEarned ?? '0';

  return c.json({
    operator: addr,
    dominantMode: dominantDims.mode,
    dominantHarness: dominantDims.harness,
    dominantSolverType: dominantDims.solverType,
    perSolverNet,
    totals: {
      attempts: totalAttempts,
      settledContribution: totalSettled,
      verdictsTotal: totalVerdictsTotal,
      verdictsPass: totalVerdictsPass,
      resolvedRate: totalResolvedRate,
      jinnEarned: jinnEarnedStr,
    },
    meta: { jinnAttribution: jinnEarnedStr === '0' ? 'pending' : 'ok' },
    ...freshnessFields,
  });
});

// ── Internal query helpers ────────────────────────────────────────────────────

/**
 * Computes a trailing resolved-rate sparkline series for a batch of SolverNets
 * in O(1) DB round trips (one GROUP BY query over `verdict ⋈ task`).
 *
 * The bucket width is `SPARKLINE_BUCKET_BLOCKS` (≈7 days). For each net the
 * last `SPARKLINE_TRAILING_BUCKETS` non-empty buckets are returned as a
 * `number[]` of pass rates (0..1) in ascending block order (oldest first).
 *
 * Returns a Map from `cidKeccak` → `number[]`. Every key in the input is
 * guaranteed an entry; nets with no verdicts get `[]`.
 *
 * Reuses `bucketResolvedRate` from metrics.ts to group samples and compute
 * rates — we just do it in-process after fetching the per-bucket counts from
 * the DB rather than fetching all raw verdict rows (which could be large).
 */
async function getSolverNetSparklinesBatch(
  cidKeccaks: `0x${string}`[],
): Promise<Map<`0x${string}`, number[]>> {
  const result = new Map<`0x${string}`, number[]>(
    cidKeccaks.map((k) => [k, []]),
  );

  if (cidKeccaks.length === 0) return result;

  // One aggregate query: GROUP BY (manifestDigest, bucketIndex) where
  // bucketIndex = floor(verdict.createdAtBlock / SPARKLINE_BUCKET_BLOCKS).
  // We compute bucketIndex in SQL using integer division.
  const bucketRows = await db
    .select({
      manifestDigest: schema.task.manifestDigest,
      bucketIndex: sql<string>`(${schema.verdict.createdAtBlock} / ${SPARKLINE_BUCKET_BLOCKS})`,
      total: count(),
      pass: count(
        sql`CASE WHEN ${schema.verdict.verdictCode} = 1 THEN 1 END`,
      ),
    })
    .from(schema.verdict)
    .innerJoin(schema.task, eq(schema.verdict.taskId, schema.task.id))
    .where(
      and(
        inArray(schema.task.manifestDigest, cidKeccaks),
        eq(schema.task.chainId, EXPLORER_CHAIN_ID),
        eq(schema.verdict.chainId, EXPLORER_CHAIN_ID),
      ),
    )
    .groupBy(schema.task.manifestDigest, sql`(${schema.verdict.createdAtBlock} / ${SPARKLINE_BUCKET_BLOCKS})`);

  // Group rows by manifestDigest, accumulate buckets, sort and slice.
  const byDigest = new Map<`0x${string}`, { bucketIndex: bigint; total: number; pass: number }[]>();
  for (const row of bucketRows) {
    const digest = row.manifestDigest as `0x${string}`;
    const existing = byDigest.get(digest);
    const bucket = {
      bucketIndex: BigInt(row.bucketIndex),
      total: Number(row.total),
      pass: Number(row.pass),
    };
    if (existing) {
      existing.push(bucket);
    } else {
      byDigest.set(digest, [bucket]);
    }
  }

  for (const [digest, buckets] of byDigest.entries()) {
    // Sort ascending by bucketIndex, take last SPARKLINE_TRAILING_BUCKETS.
    const sorted = buckets
      .sort((a, b) => (a.bucketIndex < b.bucketIndex ? -1 : a.bucketIndex > b.bucketIndex ? 1 : 0))
      .slice(-SPARKLINE_TRAILING_BUCKETS);
    const series = sorted.map((b) => (b.total === 0 ? 0 : b.pass / b.total));
    result.set(digest, series);
  }

  return result;
}

/**
 * Computes rollup stats for a batch of SolverNets in O(1) DB round trips
 * (three aggregate queries, grouped by manifestDigest) instead of O(N).
 *
 * Returns a Map from `cidKeccak` → stats object. Every `cidKeccak` in the
 * input is guaranteed to have an entry (with zeros if no matching rows exist).
 *
 * Use this for `/explorer/solvernets` (all SolverNets) or any bulk listing.
 * For a single SolverNet, pass a one-element array — the implementation is
 * still O(1) queries so there's no overhead cost.
 */
async function getSolverNetStatsBatch(
  cidKeccaks: `0x${string}`[],
): Promise<
  Map<
    `0x${string}`,
    {
      tasksPosted: number;
      tasksSettled: number;
      attempts: number;
      verdicts: number;
      verdictsPass: number;
      resolvedRate: number | null;
    }
  >
> {
  // Seed the result map with zero-rows so every input key has an entry.
  const result = new Map(
    cidKeccaks.map((k) => [
      k,
      {
        tasksPosted: 0,
        tasksSettled: 0,
        attempts: 0,
        verdicts: 0,
        verdictsPass: 0,
        resolvedRate: null as number | null,
      },
    ]),
  );

  if (cidKeccaks.length === 0) return result;

  // Query 1: task counts grouped by manifestDigest, scoped to EXPLORER_CHAIN_ID.
  const taskAgg = await db
    .select({
      manifestDigest: schema.task.manifestDigest,
      tasksPosted: count(),
      tasksSettled: count(
        sql`CASE WHEN ${schema.task.finalized} = true THEN 1 END`,
      ),
    })
    .from(schema.task)
    .where(
      and(
        inArray(schema.task.manifestDigest, cidKeccaks),
        eq(schema.task.chainId, EXPLORER_CHAIN_ID),
      ),
    )
    .groupBy(schema.task.manifestDigest);

  // Query 2: attempt counts grouped by task.manifestDigest, scoped to EXPLORER_CHAIN_ID.
  // Join attempt → task to get the manifestDigest.
  const attemptAgg = await db
    .select({
      manifestDigest: schema.task.manifestDigest,
      attempts: count(),
    })
    .from(schema.attempt)
    .innerJoin(schema.task, eq(schema.attempt.taskId, schema.task.id))
    .where(
      and(
        inArray(schema.task.manifestDigest, cidKeccaks),
        eq(schema.task.chainId, EXPLORER_CHAIN_ID),
        eq(schema.attempt.chainId, EXPLORER_CHAIN_ID),
      ),
    )
    .groupBy(schema.task.manifestDigest);

  // Query 3: verdict counts grouped by task.manifestDigest, scoped to EXPLORER_CHAIN_ID.
  const verdictAgg = await db
    .select({
      manifestDigest: schema.task.manifestDigest,
      verdicts: count(),
      verdictsPass: count(
        sql`CASE WHEN ${schema.verdict.verdictCode} = 1 THEN 1 END`,
      ),
    })
    .from(schema.verdict)
    .innerJoin(schema.task, eq(schema.verdict.taskId, schema.task.id))
    .where(
      and(
        inArray(schema.task.manifestDigest, cidKeccaks),
        eq(schema.task.chainId, EXPLORER_CHAIN_ID),
        eq(schema.verdict.chainId, EXPLORER_CHAIN_ID),
      ),
    )
    .groupBy(schema.task.manifestDigest);

  // Stitch aggregates onto the result map.
  for (const row of taskAgg) {
    const entry = result.get(row.manifestDigest as `0x${string}`);
    if (entry) {
      entry.tasksPosted = Number(row.tasksPosted);
      entry.tasksSettled = Number(row.tasksSettled);
    }
  }
  for (const row of attemptAgg) {
    const entry = result.get(row.manifestDigest as `0x${string}`);
    if (entry) {
      entry.attempts = Number(row.attempts);
    }
  }
  for (const row of verdictAgg) {
    const entry = result.get(row.manifestDigest as `0x${string}`);
    if (entry) {
      const verdicts = Number(row.verdicts);
      const verdictsPass = Number(row.verdictsPass);
      entry.verdicts = verdicts;
      entry.verdictsPass = verdictsPass;
      entry.resolvedRate = resolvedRateFromCounts(verdictsPass, verdicts);
    }
  }

  return result;
}

/**
 * Fetches all verdicts for a set of (taskId, attemptIndex) pairs.
 * Returns the subset of verdict rows matching any of the pairs.
 * Scoped to EXPLORER_CHAIN_ID.
 */
async function getVerdictsForAttempts(
  pairs: { taskId: string; attemptIndex: number }[],
): Promise<{ taskId: string; attemptIndex: number; verdictCode: number }[]> {
  if (pairs.length === 0) return [];

  const taskIds = [...new Set(pairs.map((p) => p.taskId))];
  const rows = await db
    .select({
      taskId: schema.verdict.taskId,
      attemptIndex: schema.verdict.attemptIndex,
      verdictCode: schema.verdict.verdictCode,
    })
    .from(schema.verdict)
    .where(
      and(
        inArray(schema.verdict.taskId, taskIds),
        eq(schema.verdict.chainId, EXPLORER_CHAIN_ID),
      ),
    );

  // Filter to only the exact (taskId, attemptIndex) pairs
  const pairSet = new Set(pairs.map((p) => `${p.taskId}:${p.attemptIndex}`));
  return rows.filter((r) => pairSet.has(`${r.taskId}:${r.attemptIndex}`));
}

/**
 * Options for {@link buildLeaderboardRows}.
 *
 * Both filters are applied as AND conditions. When omitted, no filtering is
 * applied on that dimension.
 */
interface BuildLeaderboardOptions {
  /**
   * Restrict to attempts whose task has this `manifestDigest` (cidKeccak).
   * When set, the leaderboard covers only the named SolverNet.
   */
  manifestDigest?: `0x${string}`;
  /**
   * Restrict to attempts that have an `AttemptEnvelopeMeta` row with this mode
   * ('train' | 'frozen'). Attempts without an `AttemptEnvelopeMeta` row are
   * excluded when this filter is set.
   */
  mode?: string;
}

/**
 * Builds a {@link LeaderboardRow} for every distinct operator that has at least
 * one attempt matching the optional filters.
 *
 * Used by:
 *   - `GET /explorer/operators` (no filters, or mode/harness query params)
 *   - `GET /explorer/solvernet/:cid` (manifestDigest + mode for train/frozen boards)
 *
 * Scoped to EXPLORER_CHAIN_ID.
 *
 * ebu7.6: accepts optional `manifestDigest` (SolverNet filter) and `mode`
 * (train/frozen board split). When `mode` is set, only attempts that have a
 * matching `AttemptEnvelopeMeta.mode` row count. jinnEarned is set to 0n for
 * the mode-filtered boards (reward attribution is fleet-wide, not per-mode).
 */
async function buildLeaderboardRows(
  opts: BuildLeaderboardOptions = {},
): Promise<LeaderboardRow[]> {
  const { manifestDigest, mode } = opts;

  // All attempts — scoped to EXPLORER_CHAIN_ID, with optional manifestDigest filter.
  // If mode filter is active we join attemptEnvelopeMeta to restrict.
  let allAttempts: { taskId: string; attemptIndex: number; operator: `0x${string}`; requestId: `0x${string}` }[];

  if (mode !== undefined) {
    // Mode-filtered board: inner join attempt → attemptEnvelopeMeta, filter by mode.
    // We need requestId from attempt to join attemptEnvelopeMeta.
    const joinedRows = await db
      .select({
        taskId: schema.attempt.taskId,
        attemptIndex: schema.attempt.attemptIndex,
        operator: schema.attempt.operator,
        requestId: schema.attempt.requestId,
      })
      .from(schema.attempt)
      .innerJoin(
        schema.attemptEnvelopeMeta,
        and(
          eq(schema.attempt.requestId, schema.attemptEnvelopeMeta.requestId),
          eq(schema.attemptEnvelopeMeta.chainId, EXPLORER_CHAIN_ID),
          eq(schema.attemptEnvelopeMeta.mode, mode),
        ),
      )
      .where(eq(schema.attempt.chainId, EXPLORER_CHAIN_ID));

    allAttempts = joinedRows as typeof allAttempts;
  } else {
    const rows = await db
      .select({
        taskId: schema.attempt.taskId,
        attemptIndex: schema.attempt.attemptIndex,
        operator: schema.attempt.operator,
        requestId: schema.attempt.requestId,
      })
      .from(schema.attempt)
      .where(eq(schema.attempt.chainId, EXPLORER_CHAIN_ID));
    allAttempts = rows as typeof allAttempts;
  }

  if (allAttempts.length === 0) return [];

  // If manifestDigest filter is set, load the matching taskIds and restrict.
  if (manifestDigest !== undefined) {
    const matchingTaskIds = await db
      .select({ id: schema.task.id })
      .from(schema.task)
      .where(
        and(
          eq(schema.task.manifestDigest, manifestDigest),
          eq(schema.task.chainId, EXPLORER_CHAIN_ID),
        ),
      );
    const matchingSet = new Set(matchingTaskIds.map((t) => t.id));
    allAttempts = allAttempts.filter((a) => matchingSet.has(a.taskId));
    if (allAttempts.length === 0) return [];
  }

  // Collect distinct operators
  const operators = [...new Set(allAttempts.map((a) => a.operator))];

  // All tasks (for finalization) — scoped to EXPLORER_CHAIN_ID
  const allTaskIds = [...new Set(allAttempts.map((a) => a.taskId))];
  const tasks =
    allTaskIds.length > 0
      ? await db
          .select({ id: schema.task.id, finalized: schema.task.finalized })
          .from(schema.task)
          .where(
            and(
              inArray(schema.task.id, allTaskIds),
              eq(schema.task.chainId, EXPLORER_CHAIN_ID),
            ),
          )
      : [];
  const taskMap = new Map(tasks.map((t) => [t.id, t]));

  // All verdicts for these tasks — scoped to EXPLORER_CHAIN_ID
  const allVerdicts =
    allTaskIds.length > 0
      ? await db
          .select({
            taskId: schema.verdict.taskId,
            attemptIndex: schema.verdict.attemptIndex,
            verdictCode: schema.verdict.verdictCode,
          })
          .from(schema.verdict)
          .where(
            and(
              inArray(schema.verdict.taskId, allTaskIds),
              eq(schema.verdict.chainId, EXPLORER_CHAIN_ID),
            ),
          )
      : [];

  // Reward distributions — intentionally unfiltered by chainId.
  // For mode-filtered boards, jinnEarned is 0n because reward attribution is
  // fleet-wide and cannot be split by mode; callers should note this.
  const rewardByOperator = new Map<string, bigint>();
  if (mode === undefined) {
    const rewardRows = await db
      .select({
        multisig: schema.rewardDistribution.multisig,
        operatorMinted: schema.rewardDistribution.operatorMinted,
      })
      .from(schema.rewardDistribution);

    for (const r of rewardRows) {
      const prev = rewardByOperator.get(r.multisig) ?? 0n;
      rewardByOperator.set(r.multisig, prev + r.operatorMinted);
    }
  }

  // Build per-operator rows
  const rows: LeaderboardRow[] = [];
  for (const op of operators) {
    const opAttempts = allAttempts.filter((a) => a.operator === op);
    const attemptPairSet = new Set(
      opAttempts.map((a) => `${a.taskId}:${a.attemptIndex}`),
    );

    const settled = opAttempts.filter(
      (a) => taskMap.get(a.taskId)?.finalized,
    ).length;

    const opVerdicts = allVerdicts.filter((v) =>
      attemptPairSet.has(`${v.taskId}:${v.attemptIndex}`),
    );
    const verdictsTotal = opVerdicts.length;
    const verdictsPass = opVerdicts.filter((v) => v.verdictCode === 1).length;

    rows.push({
      operator: op as `0x${string}`,
      attempts: opAttempts.length,
      settledContribution: settled,
      verdictsTotal,
      verdictsPass,
      resolvedRate: resolvedRateFromCounts(verdictsPass, verdictsTotal),
      jinnEarned: rewardByOperator.get(op) ?? 0n,
    });
  }

  return rows;
}

/**
 * For a set of operator addresses, returns a Map from operator → { mode, harness }
 * where `mode` is the modal executor mode and `harness` is the modal implName among
 * that operator's enriched attempts (those with an AttemptEnvelopeMeta row).
 *
 * Operators with no enriched attempts map to `{ mode: 'unknown', harness: '(unknown)' }`.
 * Scoped to EXPLORER_CHAIN_ID.
 */
async function getDominantModeAndHarness(
  operators: `0x${string}`[],
): Promise<Map<`0x${string}`, { mode: string; harness: string }>> {
  const result = new Map<`0x${string}`, { mode: string; harness: string }>();
  for (const op of operators) {
    result.set(op, { mode: 'unknown', harness: '(unknown)' });
  }

  if (operators.length === 0) return result;

  // Join attempt → attemptEnvelopeMeta to get mode + implName per operator.
  const rows = await db
    .select({
      operator: schema.attempt.operator,
      mode: schema.attemptEnvelopeMeta.mode,
      implName: schema.attemptEnvelopeMeta.implName,
    })
    .from(schema.attempt)
    .innerJoin(
      schema.attemptEnvelopeMeta,
      and(
        eq(schema.attempt.requestId, schema.attemptEnvelopeMeta.requestId),
        eq(schema.attemptEnvelopeMeta.chainId, EXPLORER_CHAIN_ID),
      ),
    )
    .where(
      and(
        inArray(schema.attempt.operator, operators),
        eq(schema.attempt.chainId, EXPLORER_CHAIN_ID),
      ),
    );

  // Group by operator and compute modal mode/implName
  const byOp = new Map<string, { modes: string[]; harnesses: string[] }>();
  for (const { operator, mode, implName } of rows) {
    const entry = byOp.get(operator);
    if (entry) {
      entry.modes.push(mode);
      entry.harnesses.push(implName);
    } else {
      byOp.set(operator, { modes: [mode], harnesses: [implName] });
    }
  }

  for (const [op, { modes, harnesses }] of byOp.entries()) {
    result.set(op as `0x${string}`, {
      mode: modalString(modes) ?? 'unknown',
      harness: modalString(harnesses) ?? '(unknown)',
    });
  }

  return result;
}

/**
 * Returns the most-frequent string in `arr`; ties broken by lexicographically
 * smallest. Returns `null` for an empty array.
 */
function modalString(arr: string[]): string | null {
  if (arr.length === 0) return null;
  const freq = new Map<string, number>();
  for (const s of arr) freq.set(s, (freq.get(s) ?? 0) + 1);
  let best = '';
  let bestCount = 0;
  for (const [s, cnt] of freq.entries()) {
    if (cnt > bestCount || (cnt === bestCount && s < best)) {
      best = s;
      bestCount = cnt;
    }
  }
  return best;
}

/**
 * Like {@link buildLeaderboardRows} but with an optional `harnessFilter` that
 * restricts to attempts whose `AttemptEnvelopeMeta.implName` matches the given
 * value, optionally stacked with a `mode` filter.
 *
 * Used by `GET /explorer/operators?harness=<implName>`.
 * jinnEarned is 0n (reward attribution is fleet-wide, not per-harness).
 * Scoped to EXPLORER_CHAIN_ID.
 */
async function buildLeaderboardRowsWithHarnessFilter(
  modeFilter: string | undefined,
  harnessFilter: string,
): Promise<LeaderboardRow[]> {
  // Build the envelope filter conditions
  const envelopeConditions = [
    eq(schema.attempt.requestId, schema.attemptEnvelopeMeta.requestId),
    eq(schema.attemptEnvelopeMeta.chainId, EXPLORER_CHAIN_ID),
    eq(schema.attemptEnvelopeMeta.implName, harnessFilter),
    ...(modeFilter !== undefined ? [eq(schema.attemptEnvelopeMeta.mode, modeFilter)] : []),
  ];

  const joinedRows = await db
    .select({
      taskId: schema.attempt.taskId,
      attemptIndex: schema.attempt.attemptIndex,
      operator: schema.attempt.operator,
    })
    .from(schema.attempt)
    .innerJoin(schema.attemptEnvelopeMeta, and(...envelopeConditions))
    .where(eq(schema.attempt.chainId, EXPLORER_CHAIN_ID));

  if (joinedRows.length === 0) return [];

  const operators = [...new Set(joinedRows.map((a) => a.operator))];
  const allTaskIds = [...new Set(joinedRows.map((a) => a.taskId))];

  const tasks =
    allTaskIds.length > 0
      ? await db
          .select({ id: schema.task.id, finalized: schema.task.finalized })
          .from(schema.task)
          .where(
            and(
              inArray(schema.task.id, allTaskIds),
              eq(schema.task.chainId, EXPLORER_CHAIN_ID),
            ),
          )
      : [];
  const taskMap = new Map(tasks.map((t) => [t.id, t]));

  const allVerdicts =
    allTaskIds.length > 0
      ? await db
          .select({
            taskId: schema.verdict.taskId,
            attemptIndex: schema.verdict.attemptIndex,
            verdictCode: schema.verdict.verdictCode,
          })
          .from(schema.verdict)
          .where(
            and(
              inArray(schema.verdict.taskId, allTaskIds),
              eq(schema.verdict.chainId, EXPLORER_CHAIN_ID),
            ),
          )
      : [];

  const rows: LeaderboardRow[] = [];
  for (const op of operators) {
    const opAttempts = joinedRows.filter((a) => a.operator === op);
    const attemptPairSet = new Set(
      opAttempts.map((a) => `${a.taskId}:${a.attemptIndex}`),
    );
    const settled = opAttempts.filter((a) => taskMap.get(a.taskId)?.finalized).length;
    const opVerdicts = allVerdicts.filter((v) =>
      attemptPairSet.has(`${v.taskId}:${v.attemptIndex}`),
    );
    const verdictsTotal = opVerdicts.length;
    const verdictsPass = opVerdicts.filter((v) => v.verdictCode === 1).length;

    rows.push({
      operator: op as `0x${string}`,
      attempts: opAttempts.length,
      settledContribution: settled,
      verdictsTotal,
      verdictsPass,
      resolvedRate: resolvedRateFromCounts(verdictsPass, verdictsTotal),
      jinnEarned: 0n, // fleet-wide; cannot be split by harness
    });
  }

  return rows;
}

/**
 * Computes dominant mode, harness, and solverType from a set of
 * AttemptEnvelopeMeta rows for a single operator.
 *
 * Returns 'unknown' / '(unknown)' strings when `rows` is empty.
 */
function computeDominantDims(
  rows: { mode: string; implName: string; solverType: string }[],
): { mode: string; harness: string; solverType: string } {
  if (rows.length === 0) {
    return { mode: 'unknown', harness: '(unknown)', solverType: '(unknown)' };
  }
  return {
    mode: modalString(rows.map((r) => r.mode)) ?? 'unknown',
    harness: modalString(rows.map((r) => r.implName)) ?? '(unknown)',
    solverType: modalString(rows.map((r) => r.solverType)) ?? '(unknown)',
  };
}

export default app;
