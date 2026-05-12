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
import { and, count, countDistinct, sum, eq, inArray, max, sql } from 'drizzle-orm';
import {
  resolvedRateFromCounts,
  bucketResolvedRate,
  rollingResolvedRate,
  rankLeaderboard,
  freshness,
  type LeaderboardRow,
} from './metrics.js';
import { withFreshness, type FreshnessMeta } from './freshness.js';

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

// ── Hono context variable types ───────────────────────────────────────────────

type ExplorerVariables = {
  /** Indexer head stashed by the explorer-freshness middleware. */
  indexedHead: FreshnessMeta;
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
 * This is a thin wrapper around `withFreshness` that also sets the context
 * variable before calling next(). We handle the stash here rather than inside
 * the generic withFreshness so that module stays DB-free and testable.
 */
function explorerFreshness() {
  return withFreshness(async (c) => {
    const lastIndexedBlock = await getIndexedHead();
    const meta: FreshnessMeta = {
      lastIndexedBlock,
      lastIndexedAt: new Date().toISOString(),
    };
    // Stash for route body to read — avoids a second getIndexedHead() call.
    c.set('indexedHead', meta);
    return meta;
  });
}

// ── App ───────────────────────────────────────────────────────────────────────

const app = new Hono<{ Variables: ExplorerVariables }>();

// ── GET /explorer/network ─────────────────────────────────────────────────────

app.use('/network', explorerFreshness());

app.get('/network', async (c) => {
  const [taskStats, attemptStats, verdictRows, rewardStats, snStats] =
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
    ]);

  const tRow = taskStats[0];
  const aRow = attemptStats[0];
  const vRow = verdictRows[0];
  const rRow = rewardStats[0];
  const snRow = snStats[0];

  const verdictsTotal = Number(vRow?.total ?? 0);
  const verdictsPass = Number(vRow?.pass ?? 0);
  const resolvedRate = resolvedRateFromCounts(verdictsPass, verdictsTotal);

  // Read the head computed by the middleware — no second DB round trip.
  const meta = c.get('indexedHead');
  const freshnessFields = freshness(meta.lastIndexedBlock, meta.lastIndexedAt);

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
    ...freshnessFields,
  });
});

// ── GET /explorer/solvernets ──────────────────────────────────────────────────

app.use('/solvernets', explorerFreshness());

app.get('/solvernets', async (c) => {
  const manifests = await db
    .select()
    .from(schema.solverNetManifest)
    .where(eq(schema.solverNetManifest.chainId, EXPLORER_CHAIN_ID));

  // Batch-load all stats in O(1) round trips instead of O(N).
  const statsByDigest = await getSolverNetStatsBatch(
    manifests.map((m) => m.cidKeccak),
  );

  const rows = manifests.map((m) => ({
    cid: m.id,
    status: m.status,
    launcherAgentId: m.launcherAgentId,
    statusUpdatedAt: m.statusUpdatedAt,
    ...statsByDigest.get(m.cidKeccak),
  }));

  // Read the head computed by the middleware — no second DB round trip.
  const meta = c.get('indexedHead');
  const freshnessFields = freshness(meta.lastIndexedBlock, meta.lastIndexedAt);

  return c.json({ solvernets: rows, ...freshnessFields });
});

// ── GET /explorer/solvernet/:cid ──────────────────────────────────────────────

app.use('/solvernet/:cid', explorerFreshness());

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

  const verdictRows =
    ids.length > 0
      ? await db
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
      : [];

  const samples = verdictRows.map((v) => ({
    block: v.createdAtBlock,
    pass: v.verdictCode === 1,
  }));

  const learningCurveBuckets = bucketResolvedRate(samples, bucketBlocks);
  const learningCurveRolling = rollingResolvedRate(
    verdictRows.map((v) => v.verdictCode === 1),
    rollingK,
  );

  // Read the head computed by the middleware — no second DB round trip.
  const meta = c.get('indexedHead');
  const freshnessFields = freshness(meta.lastIndexedBlock, meta.lastIndexedAt);

  return c.json({
    cid: m.id,
    status: m.status,
    launcherAgentId: m.launcherAgentId,
    statusUpdatedAt: m.statusUpdatedAt,
    ...stats,
    learningCurveBuckets,
    learningCurveRolling,
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
 *   "meta": { "jinnAttribution": "pending" },  // present when ALL jinnEarned are 0
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
 */
app.get('/operators', async (c) => {
  const minVerdicts = parseIntParam(
    c.req.query('minVerdicts'),
    DEFAULT_MIN_VERDICTS,
    1000,
  );

  const rows = await buildLeaderboardRows();

  const { ranked, lowVolume } = rankLeaderboard(rows, minVerdicts);

  const allJinnEarnedZero = rows.every((r) => r.jinnEarned === 0n);

  // Read the head computed by the middleware — no second DB round trip.
  const meta = c.get('indexedHead');
  const freshnessFields = freshness(meta.lastIndexedBlock, meta.lastIndexedAt);

  return c.json({
    ranked: ranked.map((r) => ({ ...r, jinnEarned: r.jinnEarned.toString() })),
    lowVolume: lowVolume.map((r) => ({
      ...r,
      jinnEarned: r.jinnEarned.toString(),
    })),
    minVerdicts,
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
 *   "perSolverNet": [...],
 *   "totals": {
 *     "attempts": 0,
 *     "settledContribution": 0,
 *     "verdictsTotal": 0,
 *     "verdictsPass": 0,
 *     "resolvedRate": null,
 *     "jinnEarned": "0"
 *   },
 *   "meta": { "jinnAttribution": "pending" },  // present when jinnEarned is "0"
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

  // Read the head computed by the middleware — no second DB round trip.
  const meta = c.get('indexedHead');
  const freshnessFields = freshness(meta.lastIndexedBlock, meta.lastIndexedAt);

  if (operatorAttempts.length === 0) {
    return c.json({
      operator: addr,
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

  // Build per-SolverNet breakdown
  const manifests = await db
    .select()
    .from(schema.solverNetManifest)
    .where(eq(schema.solverNetManifest.chainId, EXPLORER_CHAIN_ID));
  const manifestByCidKeccak = new Map(
    manifests.map((m) => [m.cidKeccak, m]),
  );

  // Group by solvernet
  const snMap = new Map<
    string,
    {
      cid: string;
      status: string;
      attempts: number;
      settledContribution: number;
      verdictsTotal: number;
      verdictsPass: number;
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
    if (existing) {
      existing.attempts += 1;
      existing.settledContribution += settled;
    } else {
      snMap.set(snCid, {
        cid: snCid,
        status: snStatus,
        attempts: 1,
        settledContribution: settled,
        verdictsTotal: 0,
        verdictsPass: 0,
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
  }));

  // Totals
  const totalAttempts = operatorAttempts.length;
  const totalSettled = operatorAttempts.filter(
    (a) => taskMap.get(a.taskId)?.finalized,
  ).length;
  const totalVerdictsTotal = verdictRows.length;
  const totalVerdictsPass = verdictRows.filter((v) => v.verdictCode === 1).length;
  const totalResolvedRate = resolvedRateFromCounts(totalVerdictsPass, totalVerdictsTotal);

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
 * Builds a {@link LeaderboardRow} for every distinct operator that has at least
 * one attempt. Used by `GET /explorer/operators`.
 * Scoped to EXPLORER_CHAIN_ID.
 */
async function buildLeaderboardRows(): Promise<LeaderboardRow[]> {
  // All attempts grouped by operator — scoped to EXPLORER_CHAIN_ID
  const allAttempts = await db
    .select({
      taskId: schema.attempt.taskId,
      attemptIndex: schema.attempt.attemptIndex,
      operator: schema.attempt.operator,
    })
    .from(schema.attempt)
    .where(eq(schema.attempt.chainId, EXPLORER_CHAIN_ID));

  if (allAttempts.length === 0) return [];

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

  // All reward distributions keyed by multisig — intentionally unfiltered by
  // chainId: rewardDistribution is on Sepolia L1 and JINN distributed is
  // reported network-wide.
  const rewardRows = await db
    .select({
      multisig: schema.rewardDistribution.multisig,
      operatorMinted: schema.rewardDistribution.operatorMinted,
    })
    .from(schema.rewardDistribution);

  const rewardByOperator = new Map<string, bigint>();
  for (const r of rewardRows) {
    const prev = rewardByOperator.get(r.multisig) ?? 0n;
    rewardByOperator.set(r.multisig, prev + r.operatorMinted);
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

export default app;
