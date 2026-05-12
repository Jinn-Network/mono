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
import { count, countDistinct, sum, eq, inArray, max, sql } from 'drizzle-orm';
import {
  verdictResolvedRate,
  bucketResolvedRate,
  rollingResolvedRate,
  rankLeaderboard,
  freshness,
  type LeaderboardRow,
} from './metrics.js';
import { withFreshness } from './freshness.js';

// ── Open-question constants (spec §9) ─────────────────────────────────────────

/**
 * Minimum number of resolved attempts (verdictsTotal) for a leaderboard row to
 * appear in the `ranked` partition rather than `lowVolume`.
 *
 * Spec §9 open question: pin value at impl. Chosen as 5 to match the minimum
 * statistically-meaningful sample size for a binary resolved-rate estimate.
 */
const DEFAULT_MIN_RESOLVED_ATTEMPTS = 5;

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
 */
async function getIndexedHead(): Promise<bigint> {
  const [taskMax, attemptMax, verdictMax] = await Promise.all([
    db
      .select({ v: max(schema.task.createdAtBlock) })
      .from(schema.task)
      .then((r) => r[0]?.v ?? null),
    db
      .select({ v: max(schema.attempt.createdAtBlock) })
      .from(schema.attempt)
      .then((r) => r[0]?.v ?? null),
    db
      .select({ v: max(schema.verdict.createdAtBlock) })
      .from(schema.verdict)
      .then((r) => r[0]?.v ?? null),
  ]);
  const candidates = [taskMax, attemptMax, verdictMax].filter(
    (v): v is bigint => v !== null,
  );
  if (candidates.length === 0) return 0n;
  return candidates.reduce((best, cur) => (cur > best ? cur : best), 0n);
}

/** Freshness middleware factory bound to the shared head query. */
function explorerFreshness() {
  return withFreshness(async () => ({
    lastIndexedBlock: await getIndexedHead(),
    lastIndexedAt: new Date().toISOString(),
  }));
}

// ── App ───────────────────────────────────────────────────────────────────────

const app = new Hono();

// ── GET /explorer/network ─────────────────────────────────────────────────────

app.use('/network', explorerFreshness());

app.get('/network', async (c) => {
  const [taskStats, attemptStats, verdictRows, rewardStats, snStats] =
    await Promise.all([
      // Task counts
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
        .from(schema.task),

      // Attempt counts
      db
        .select({
          total: count(),
          distinctOperators: countDistinct(schema.attempt.operator),
        })
        .from(schema.attempt),

      // Verdicts (all rows for rate calc) - just counts
      db
        .select({
          total: count(),
          pass: count(
            sql`CASE WHEN ${schema.verdict.verdictCode} = 1 THEN 1 END`,
          ),
        })
        .from(schema.verdict),

      // Reward distributions
      db
        .select({
          jinnOperator: sum(schema.rewardDistribution.operatorMinted),
          jinnDao: sum(schema.rewardDistribution.daoMinted),
        })
        .from(schema.rewardDistribution),

      // SolverNets running
      db
        .select({ running: count() })
        .from(schema.solverNetManifest)
        .where(eq(schema.solverNetManifest.status, 'launched')),
    ]);

  const tRow = taskStats[0];
  const aRow = attemptStats[0];
  const vRow = verdictRows[0];
  const rRow = rewardStats[0];
  const snRow = snStats[0];

  const verdictsTotal = Number(vRow?.total ?? 0);
  const verdictsPass = Number(vRow?.pass ?? 0);
  const resolvedRate =
    verdictsTotal > 0 ? verdictsPass / verdictsTotal : null;

  const head = await getIndexedHead();
  const freshnessFields = freshness(head, new Date().toISOString());

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
  const manifests = await db.select().from(schema.solverNetManifest);

  const rows = await Promise.all(
    manifests.map(async (m) => {
      const stats = await getSolverNetStats(m.cidKeccak);
      return {
        cid: m.id,
        status: m.status,
        launcherAgentId: m.launcherAgentId,
        statusUpdatedAt: m.statusUpdatedAt,
        ...stats,
      };
    }),
  );

  const head = await getIndexedHead();
  const freshnessFields = freshness(head, new Date().toISOString());

  return c.json({ solvernets: rows, ...freshnessFields });
});

// ── GET /explorer/solvernet/:cid ──────────────────────────────────────────────

app.use('/solvernet/:cid', explorerFreshness());

app.get('/solvernet/:cid', async (c) => {
  const cid = c.req.param('cid');

  const manifests = await db
    .select()
    .from(schema.solverNetManifest)
    .where(eq(schema.solverNetManifest.id, cid));

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

  const stats = await getSolverNetStats(m.cidKeccak);

  // Fetch verdicts for this SolverNet's tasks (ordered by block for curves)
  const taskIds = await db
    .select({ id: schema.task.id })
    .from(schema.task)
    .where(eq(schema.task.manifestDigest, m.cidKeccak));

  const ids = taskIds.map((t) => t.id);

  const verdictRows =
    ids.length > 0
      ? await db
          .select({
            verdictCode: schema.verdict.verdictCode,
            createdAtBlock: schema.verdict.createdAtBlock,
          })
          .from(schema.verdict)
          .where(inArray(schema.verdict.taskId, ids))
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

  const head = await getIndexedHead();
  const freshnessFields = freshness(head, new Date().toISOString());

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

app.get('/operators', async (c) => {
  const minAttempts = parseIntParam(
    c.req.query('minAttempts'),
    DEFAULT_MIN_RESOLVED_ATTEMPTS,
    1000,
  );

  const rows = await buildLeaderboardRows();

  const { ranked, lowVolume } = rankLeaderboard(rows, minAttempts);

  const head = await getIndexedHead();
  const freshnessFields = freshness(head, new Date().toISOString());

  return c.json({
    ranked: ranked.map((r) => ({ ...r, jinnEarned: r.jinnEarned.toString() })),
    lowVolume: lowVolume.map((r) => ({
      ...r,
      jinnEarned: r.jinnEarned.toString(),
    })),
    minAttempts,
    ...freshnessFields,
  });
});

// ── GET /explorer/operator/:addr ──────────────────────────────────────────────

app.use('/operator/:addr', explorerFreshness());

app.get('/operator/:addr', async (c) => {
  const addr = c.req.param('addr').toLowerCase() as `0x${string}`;

  // All attempts by this operator
  const operatorAttempts = await db
    .select()
    .from(schema.attempt)
    .where(eq(schema.attempt.operator, addr));

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
      ...freshness(await getIndexedHead(), new Date().toISOString()),
    });
  }

  // Get all tasks for finalization status
  const taskIds = [...new Set(operatorAttempts.map((a) => a.taskId))];
  const tasks =
    taskIds.length > 0
      ? await db
          .select({ id: schema.task.id, manifestDigest: schema.task.manifestDigest, finalized: schema.task.finalized })
          .from(schema.task)
          .where(inArray(schema.task.id, taskIds))
      : [];
  const taskMap = new Map(tasks.map((t) => [t.id, t]));

  // Get all verdicts for this operator's attempts
  const attemptPairs = operatorAttempts.map((a) => ({
    taskId: a.taskId,
    attemptIndex: a.attemptIndex,
  }));
  const verdictRows = await getVerdictsForAttempts(attemptPairs);

  // Build per-SolverNet breakdown
  const manifests = await db.select().from(schema.solverNetManifest);
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
    resolvedRate:
      row.verdictsTotal > 0 ? row.verdictsPass / row.verdictsTotal : null,
  }));

  // Totals
  const totalAttempts = operatorAttempts.length;
  const totalSettled = operatorAttempts.filter(
    (a) => taskMap.get(a.taskId)?.finalized,
  ).length;
  const totalVerdictsTotal = verdictRows.length;
  const totalVerdictsPass = verdictRows.filter((v) => v.verdictCode === 1).length;
  const totalResolvedRate =
    totalVerdictsTotal > 0 ? totalVerdictsPass / totalVerdictsTotal : null;

  // JINN earned
  const rewards = await db
    .select({ minted: sum(schema.rewardDistribution.operatorMinted) })
    .from(schema.rewardDistribution)
    .where(eq(schema.rewardDistribution.multisig, addr));
  const jinnEarned = rewards[0]?.minted ?? '0';

  const head = await getIndexedHead();
  const freshnessFields = freshness(head, new Date().toISOString());

  return c.json({
    operator: addr,
    perSolverNet,
    totals: {
      attempts: totalAttempts,
      settledContribution: totalSettled,
      verdictsTotal: totalVerdictsTotal,
      verdictsPass: totalVerdictsPass,
      resolvedRate: totalResolvedRate,
      jinnEarned: jinnEarned ?? '0',
    },
    ...freshnessFields,
  });
});

// ── Internal query helpers ────────────────────────────────────────────────────

/**
 * Computes the rollup stats for a single SolverNet identified by its
 * `cidKeccak` (= task.manifestDigest).
 */
async function getSolverNetStats(cidKeccak: `0x${string}`) {
  // Tasks for this SolverNet
  const tasks = await db
    .select({
      id: schema.task.id,
      finalized: schema.task.finalized,
    })
    .from(schema.task)
    .where(eq(schema.task.manifestDigest, cidKeccak));

  const taskIds = tasks.map((t) => t.id);
  const tasksPosted = tasks.length;
  const tasksSettled = tasks.filter((t) => t.finalized).length;

  if (taskIds.length === 0) {
    return {
      tasksPosted: 0,
      tasksSettled: 0,
      attempts: 0,
      verdicts: 0,
      verdictsPass: 0,
      resolvedRate: null as number | null,
    };
  }

  // Attempts and verdicts
  const [attemptStats, verdictStats] = await Promise.all([
    db
      .select({ total: count() })
      .from(schema.attempt)
      .where(inArray(schema.attempt.taskId, taskIds)),
    db
      .select({
        total: count(),
        pass: count(
          sql`CASE WHEN ${schema.verdict.verdictCode} = 1 THEN 1 END`,
        ),
      })
      .from(schema.verdict)
      .where(inArray(schema.verdict.taskId, taskIds)),
  ]);

  const verdicts = Number(verdictStats[0]?.total ?? 0);
  const verdictsPass = Number(verdictStats[0]?.pass ?? 0);

  return {
    tasksPosted,
    tasksSettled,
    attempts: Number(attemptStats[0]?.total ?? 0),
    verdicts,
    verdictsPass,
    resolvedRate: verdicts > 0 ? verdictsPass / verdicts : null,
  };
}

/**
 * Fetches all verdicts for a set of (taskId, attemptIndex) pairs.
 * Returns the subset of verdict rows matching any of the pairs.
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
    .where(inArray(schema.verdict.taskId, taskIds));

  // Filter to only the exact (taskId, attemptIndex) pairs
  const pairSet = new Set(pairs.map((p) => `${p.taskId}:${p.attemptIndex}`));
  return rows.filter((r) => pairSet.has(`${r.taskId}:${r.attemptIndex}`));
}

/**
 * Builds a {@link LeaderboardRow} for every distinct operator that has at least
 * one attempt. Used by `GET /explorer/operators`.
 */
async function buildLeaderboardRows(): Promise<LeaderboardRow[]> {
  // All attempts grouped by operator
  const allAttempts = await db
    .select({
      taskId: schema.attempt.taskId,
      attemptIndex: schema.attempt.attemptIndex,
      operator: schema.attempt.operator,
    })
    .from(schema.attempt);

  if (allAttempts.length === 0) return [];

  // Collect distinct operators
  const operators = [...new Set(allAttempts.map((a) => a.operator))];

  // All tasks (for finalization)
  const allTaskIds = [...new Set(allAttempts.map((a) => a.taskId))];
  const tasks =
    allTaskIds.length > 0
      ? await db
          .select({ id: schema.task.id, finalized: schema.task.finalized })
          .from(schema.task)
          .where(inArray(schema.task.id, allTaskIds))
      : [];
  const taskMap = new Map(tasks.map((t) => [t.id, t]));

  // All verdicts for these tasks
  const allVerdicts =
    allTaskIds.length > 0
      ? await db
          .select({
            taskId: schema.verdict.taskId,
            attemptIndex: schema.verdict.attemptIndex,
            verdictCode: schema.verdict.verdictCode,
          })
          .from(schema.verdict)
          .where(inArray(schema.verdict.taskId, allTaskIds))
      : [];

  // All reward distributions keyed by multisig
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
      resolvedRate: verdictsTotal > 0 ? verdictsPass / verdictsTotal : null,
      jinnEarned: rewardByOperator.get(op) ?? 0n,
    });
  }

  return rows;
}

export default app;
