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
import { and, count, countDistinct, eq, inArray, max, sql, sum } from 'ponder';
import {
  resolvedRateFromCounts,
  bucketResolvedRate,
  rollingResolvedRate,
  rankLeaderboard,
  compareByJinnEarnedActive,
  freshness,
  composition,
  detectFreezeViolations,
  type LeaderboardRow,
} from './metrics.js';
import { withFreshness, type FreshnessMeta } from './freshness.js';
import { getChainHead } from './chain-head.js';
import {
  parseSliceParams,
  computeSlice,
  type SliceResponseLeaderboardRow,
} from './slice.js';
import {
  buildCorpusList,
  buildCorpusItem,
  type CaptureEnvelopeMetaRow,
} from './routes.js';
import {
  loadHeldOutSlate,
  type LoadedHeldOutSlate,
} from '@jinn-network/benchmarking-records/slates/swe-rebench-v2-held-out';
import {
  computeActiveOperators,
  computeActiveWindow,
  countOperatorsAtMilestone3,
  selectRewardActivityRows,
  type ActiveWindow as ActiveWindowDomain,
  type RewardActivitySource,
} from './active-operators.js';

function serialiseActiveWindow(w: ActiveWindowDomain): {
  startTs: number;
  endTs: number;
  blockSeconds: number;
  blockCount: number;
  requiredOlasPerBlock: string;
} {
  return {
    startTs: w.startTs,
    endTs: w.endTs,
    blockSeconds: w.blockSeconds,
    blockCount: w.blockCount,
    requiredOlasPerBlock: w.requiredOlasPerBlock.toString(),
  };
}

async function hasCheckpointRewardRows(): Promise<boolean> {
  const rows = await db
    .select({ total: count() })
    .from(schema.stakingRewardCheckpoint)
    .where(eq(schema.stakingRewardCheckpoint.chainId, EXPLORER_CHAIN_ID));
  return Number(rows[0]?.total ?? 0) > 0;
}

async function loadActiveOperators(nowSec: number) {
  const window = computeActiveWindow(nowSec);
  const checkpointRowsExist = await hasCheckpointRewardRows();
  if (checkpointRowsExist) {
    const rewardRows = await db
      .select({
        multisig: schema.stakingRewardCheckpoint.multisig,
        operatorRewarded: schema.stakingRewardCheckpoint.reward,
        claimedAtTimestamp: schema.stakingRewardCheckpoint.checkpointAtTimestamp,
      })
      .from(schema.stakingRewardCheckpoint)
      .where(
        and(
          eq(schema.stakingRewardCheckpoint.chainId, EXPLORER_CHAIN_ID),
          sql`${schema.stakingRewardCheckpoint.checkpointAtTimestamp} >= ${BigInt(window.startTs)}`,
          sql`${schema.stakingRewardCheckpoint.checkpointAtTimestamp} < ${BigInt(window.endTs)}`,
        ),
      );
    const selected = selectRewardActivityRows(rewardRows, [], true);
    return { result: computeActiveOperators(selected.rows, nowSec), source: selected.source };
  }

  const rewardRows = await db
    .select({
      multisig: schema.rewardDistribution.multisig,
      operatorRewarded: schema.rewardDistribution.operatorRewarded,
      claimedAtTimestamp: schema.rewardDistribution.claimedAtTimestamp,
    })
    .from(schema.rewardDistribution)
    .where(
      and(
        eq(schema.rewardDistribution.chainId, EXPLORER_CHAIN_ID),
        sql`${schema.rewardDistribution.claimedAtTimestamp} >= ${BigInt(window.startTs)}`,
        sql`${schema.rewardDistribution.claimedAtTimestamp} < ${BigInt(window.endTs)}`,
      ),
    );
  const selected = selectRewardActivityRows([], rewardRows, false);
  return { result: computeActiveOperators(selected.rows, nowSec), source: selected.source };
}

async function loadLifetimeRewards(
  source: RewardActivitySource,
): Promise<Array<{ multisig: `0x${string}`; operatorRewarded: bigint | string | number | null }>> {
  if (source === 'checkpoint') {
    return db
      .select({
        multisig: schema.stakingRewardCheckpoint.multisig,
        operatorRewarded: sum(schema.stakingRewardCheckpoint.reward),
      })
      .from(schema.stakingRewardCheckpoint)
      .where(eq(schema.stakingRewardCheckpoint.chainId, EXPLORER_CHAIN_ID))
      .groupBy(schema.stakingRewardCheckpoint.multisig);
  }

  return db
    .select({
      multisig: schema.rewardDistribution.multisig,
      operatorRewarded: sum(schema.rewardDistribution.operatorRewarded),
    })
    .from(schema.rewardDistribution)
    .where(eq(schema.rewardDistribution.chainId, EXPLORER_CHAIN_ID))
    .groupBy(schema.rewardDistribution.multisig);
}

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

/**
 * Parse a boolean query param. Recognises `true`/`1`/`yes` (case-insensitive)
 * as true and `false`/`0`/`no` as false; unparseable or missing values fall
 * back to `def`.
 *
 * Used by `?include=raw` and similar opt-in flags on the explorer routes.
 * Exported because tests cover it (parseBoolParam describe in metrics.test.ts)
 * and the helper is otherwise an internal utility.
 */
export function parseBoolParam(raw: string | undefined, def: boolean): boolean {
  if (raw === undefined) return def;
  const v = raw.toLowerCase();
  if (v === 'true' || v === '1' || v === 'yes') return true;
  if (v === 'false' || v === '0' || v === 'no') return false;
  return def;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Returns the greatest route-visible block across explorer tables. Used as the
 * indexer head proxy for freshness middleware and ETags.
 *
 * Scoped to EXPLORER_CHAIN_ID so it reflects only the activity the explorer
 * surfaces.
 */
async function getIndexedHead(): Promise<{ lastIndexedBlock: bigint; validator: string }> {
  const entries = await Promise.all([
    db
      .select({ v: max(schema.task.createdAtBlock) })
      .from(schema.task)
      .where(eq(schema.task.chainId, EXPLORER_CHAIN_ID))
      .then((r) => ['task', r[0]?.v ?? null] as const),
    db
      .select({ v: max(schema.attempt.createdAtBlock) })
      .from(schema.attempt)
      .where(eq(schema.attempt.chainId, EXPLORER_CHAIN_ID))
      .then((r) => ['attempt', r[0]?.v ?? null] as const),
    db
      .select({ v: max(schema.verdict.createdAtBlock) })
      .from(schema.verdict)
      .where(eq(schema.verdict.chainId, EXPLORER_CHAIN_ID))
      .then((r) => ['verdict', r[0]?.v ?? null] as const),
    db
      .select({ v: max(schema.solverNetManifest.anchorBlock) })
      .from(schema.solverNetManifest)
      .where(eq(schema.solverNetManifest.chainId, EXPLORER_CHAIN_ID))
      .then((r) => ['manifest', r[0]?.v ?? null] as const),
    db
      .select({ v: max(schema.envelope.publishedAtBlock) })
      .from(schema.envelope)
      .where(eq(schema.envelope.chainId, EXPLORER_CHAIN_ID))
      .then((r) => ['envelope', r[0]?.v ?? null] as const),
    db
      .select({ v: max(schema.harnessCheckpoint.publishedAtBlock) })
      .from(schema.harnessCheckpoint)
      .where(eq(schema.harnessCheckpoint.chainId, EXPLORER_CHAIN_ID))
      .then((r) => ['checkpoint', r[0]?.v ?? null] as const),
    db
      .select({ v: max(schema.attemptEnvelopeMeta.enrichedAtBlock) })
      .from(schema.attemptEnvelopeMeta)
      .where(eq(schema.attemptEnvelopeMeta.chainId, EXPLORER_CHAIN_ID))
      .then((r) => ['attemptMeta', r[0]?.v ?? null] as const),
    db
      .select({ v: max(schema.verdictEnvelopeMeta.enrichedAtBlock) })
      .from(schema.verdictEnvelopeMeta)
      .where(eq(schema.verdictEnvelopeMeta.chainId, EXPLORER_CHAIN_ID))
      .then((r) => ['verdictMeta', r[0]?.v ?? null] as const),
    db
      .select({ v: max(schema.rewardDistribution.claimedAtBlock) })
      .from(schema.rewardDistribution)
      .where(eq(schema.rewardDistribution.chainId, EXPLORER_CHAIN_ID))
      .then((r) => ['reward', r[0]?.v ?? null] as const),
    db
      .select({ v: max(schema.stakingRewardCheckpoint.checkpointAtBlock) })
      .from(schema.stakingRewardCheckpoint)
      .where(eq(schema.stakingRewardCheckpoint.chainId, EXPLORER_CHAIN_ID))
      .then((r) => ['stakingRewardCheckpoint', r[0]?.v ?? null] as const),
  ]);
  const candidates = entries.map(([, v]) => v).filter((v): v is bigint => v !== null);
  const lastIndexedBlock = candidates.length === 0
    ? 0n
    : candidates.reduce((best, cur) => (cur > best ? cur : best), 0n);
  const validator = entries
    .map(([name, v]) => `${name}:${(v ?? 0n).toString()}`)
    .join('|');
  return { lastIndexedBlock, validator };
}

type VerdictTruthRow = {
  verdictCode: number;
  actualPassed: boolean | null;
  enrichmentStatus: string | null;
};

function verdictEnvelopeJoinCondition() {
  // verdictEnvelopeMeta is permissionless and shape-parsed. Even a sole row
  // can copy every public authoritative tuple field, so an exact-one join is
  // not authentication. Keep explorer truth on-chain-only until a canonical
  // projection binds historical publisher Safe, signature/hash, and task facts.
  return sql`false`;
}

/**
 * Canonical attempt-envelope join.
 *
 * Unlike verdict metadata, AttemptEnvelopeMeta currently has no projected Safe
 * address that can be compared with attempt.operator. Until an authenticated
 * canonical projection exists, the only non-order-dependent policy is
 * fail-closed: one request+chain candidate may enrich an authoritative attempt;
 * two or more candidates leave it unenriched.
 */
function attemptEnvelopeJoinCondition() {
  // As above, request/chain uniqueness cannot prove that the on-chain operator
  // published or signed this projection.
  return sql`false`;
}

/**
 * Computes the "truth" of a verdict row.
 *
 * Default mode (`strict=false` / omitted):
 *   - Enriched (`enrichmentStatus === 'ok'` AND `actualPassed != null`):
 *     returns `actualPassed`.
 *   - Otherwise: falls back to `verdictCode === 1` (the legacy on-chain truth).
 *
 * Strict mode (`strict=true`) — used by `?include=raw` absent (spec §4):
 *   - Enriched: returns `actualPassed` (or `null` if `actualPassed == null`,
 *     so the row drops out of pass/total counts).
 *   - Unenriched (`enrichmentStatus !== 'ok'`): returns `null` regardless of
 *     `verdictCode`. Callers should treat `null` as "exclude this row from
 *     both numerator AND denominator" — see Task 2 + Task 4 in #610.
 *
 * Exported so the metrics-test suite can lock both modes by example.
 */
export function verdictTruth(
  v: VerdictTruthRow,
  strict = false,
): boolean | null {
  if (v.enrichmentStatus === 'ok' && v.actualPassed !== null) {
    return v.actualPassed;
  }
  if (strict) return null;
  return v.verdictCode === 1;
}

// ── Held-out slate scoping (#820) ──────────────────────────────────────────────

/**
 * Default held-out slate version surfaced on the SolverNet response. Scores are
 * only comparable within a named version (#817); a slate change is a distinct
 * version, never an in-place edit.
 */
export const HELD_OUT_SLATE_VERSION = 'v1' as const;

/**
 * True for any swe-rebench-v2 solverType (e.g. 'swe-rebench-v2.v1'). Only this
 * solverType family has an `instance_id` / held-out-slate concept.
 */
function isSweRebenchV2(solverType: string): boolean {
  return solverType.startsWith('swe-rebench-v2');
}

/**
 * #820 AC#1 — scope frozen verdicts to a NAMED slate before counting.
 *
 * Today `frozenResolvedRate` scores a checkpoint on whatever frozen attempts
 * matched its codeDigest, so two checkpoints can be compared on different task
 * subsets (task-selection confounded). For swe-rebench-v2, restrict to verdicts
 * whose `instanceId` is in the held-out slate, so every checkpoint is scored on
 * the same fixed set. For other solverTypes (no instance_id / slate concept)
 * this is a pass-through: the input array is returned unchanged.
 *
 * Pure + exported so the api.explorer test suite can lock it against synthetic
 * fixtures without booting Ponder.
 */
export function filterFrozenVerdictsToSlate<T extends { instanceId: string }>(
  verdicts: T[],
  slate: Pick<LoadedHeldOutSlate, 'instanceIds'>,
  solverType: string,
): T[] {
  if (!isSweRebenchV2(solverType)) return verdicts;
  return verdicts.filter((v) => v.instanceId !== '' && slate.instanceIds.has(v.instanceId));
}

/**
 * #820 AC#2 — held-out resolved-rate delta between a checkpoint and its parent.
 * Returns `self − parent` when both frozen rates are present, else null (no
 * parent, or either rate unmeasured). Pure + exported for unit testing.
 */
export function computeHeldOutDelta(
  self: { frozenResolvedRate: number | null },
  parent: { frozenResolvedRate: number | null } | undefined,
): number | null {
  if (self.frozenResolvedRate == null) return null;
  if (parent == null || parent.frozenResolvedRate == null) return null;
  return self.frozenResolvedRate - parent.frozenResolvedRate;
}

function verdictTruthPassCountSql() {
  return sql`CASE
    WHEN ${schema.verdictEnvelopeMeta.enrichmentStatus} = 'ok'
      THEN CASE WHEN ${schema.verdictEnvelopeMeta.actualPassed} = true THEN 1 END
    WHEN ${schema.verdict.verdictCode} = 1 THEN 1
  END`;
}

function verdictTruthDisagreementCountSql() {
  return sql`CASE
    WHEN ${schema.verdictEnvelopeMeta.enrichmentStatus} = 'ok'
      AND ((${schema.verdict.verdictCode} = 1) <> ${schema.verdictEnvelopeMeta.actualPassed})
    THEN 1
  END`;
}

/**
 * SQL WHERE fragment that drops unenriched verdict rows when `includeUnenriched`
 * is false (the new default per spec §4: envelope-only). Returns `undefined`
 * when `includeUnenriched` is true so Drizzle's `and(...)` short-circuits it.
 *
 * Composes with the standard verdict-side WHERE clauses
 * (e.g. `and(eq(...chainId), enrichmentFilter(false))`).
 */
function enrichmentFilter(includeUnenriched: boolean) {
  return includeUnenriched
    ? undefined
    : eq(schema.verdictEnvelopeMeta.enrichmentStatus, 'ok');
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
    const [indexedHead, chainHead] = await Promise.all([
      getIndexedHead(),
      getChainHead(),
    ]);
    const meta: FreshnessMeta = {
      lastIndexedBlock: indexedHead.lastIndexedBlock,
      lastIndexedAt: new Date().toISOString(),
      validator: indexedHead.validator,
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
  const includeUnenriched = c.req.query('include') === 'raw';

  const [taskStats, attemptStats, verdictRows, snStats, enrichmentRows, totalAttemptCount] =
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

      // Verdicts (all rows for rate calc) — scoped to EXPLORER_CHAIN_ID.
      // LEFT JOIN verdictEnvelopeMeta so we can compute both on-chain count
      // (verdict.verdictCode == 1) and envelope-truth count (preferring
      // attemptEnvelopeMeta.actualPassed when an enriched row exists). The
      // on-chain verdictCode defaults to Pass(1) for failed evaluations in
      // the daemon (ebu7.13); the envelope is the source of truth.
      db
        .select({
          total: count(),
          onChainPass: count(
            sql`CASE WHEN ${schema.verdict.verdictCode} = 1 THEN 1 END`,
          ),
          // envelope-truth pass: prefer actualPassed when enriched; else fall back to verdictCode.
          envelopePass: count(verdictTruthPassCountSql()),
          // verdicts with an enriched envelope row
          enriched: count(
            sql`CASE WHEN ${schema.verdictEnvelopeMeta.enrichmentStatus} = 'ok' THEN 1 END`,
          ),
          // disagreement: enriched AND on-chain != envelope
          disagreed: count(verdictTruthDisagreementCountSql()),
        })
        .from(schema.verdict)
        .leftJoin(
          schema.verdictEnvelopeMeta,
          verdictEnvelopeJoinCondition(),
        )
        .where(
          and(
            eq(schema.verdict.chainId, EXPLORER_CHAIN_ID),
            enrichmentFilter(includeUnenriched),
          ),
        ),

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

      // Envelope enrichment: mode + implName + model + pluginsJson per enriched attempt,
      // scoped to EXPLORER_CHAIN_ID. No join to `attempt` needed — every
      // attemptEnvelopeMeta row corresponds to an attempt (the requestId FK)
      // and is already chain-scoped. Models + plugins fuel the new composition.byModel /
      // composition.byPlugin facets.
      db
        .select({
          mode: schema.attemptEnvelopeMeta.mode,
          implName: schema.attemptEnvelopeMeta.implName,
          model: schema.attemptEnvelopeMeta.model,
          pluginsJson: schema.attemptEnvelopeMeta.pluginsJson,
        })
        .from(schema.attemptEnvelopeMeta)
        .innerJoin(schema.attempt, attemptEnvelopeJoinCondition())
        .where(eq(schema.attempt.chainId, EXPLORER_CHAIN_ID)),

      // Total attempt count for enrichmentCoverage.share denominator — scoped to EXPLORER_CHAIN_ID.
      db
        .select({ total: count() })
        .from(schema.attempt)
        .where(eq(schema.attempt.chainId, EXPLORER_CHAIN_ID)),
    ]);

  const tRow = taskStats[0];
  const aRow = attemptStats[0];
  const vRow = verdictRows[0];
  const snRow = snStats[0];

  const verdictsTotal = Number(vRow?.total ?? 0);
  // Envelope-truth-preferring pass count (the headline number — what the SPA's
  // "RESOLVED RATE" gold KPI displays). The on-chain code defaults to Pass(1)
  // in the daemon for failed evaluations; we prefer the off-chain evaluator's
  // actualPassed where the verdictEnvelopeMeta enrichment has landed.
  const verdictsPass = Number(vRow?.envelopePass ?? 0);
  const onChainVerdictsPass = Number(vRow?.onChainPass ?? 0);
  const verdictsEnriched = Number(vRow?.enriched ?? 0);
  const verdictsDisagreed = Number(vRow?.disagreed ?? 0);
  const resolvedRate = resolvedRateFromCounts(verdictsPass, verdictsTotal);
  const onChainResolvedRate = resolvedRateFromCounts(onChainVerdictsPass, verdictsTotal);
  const verdictConsistency = verdictsEnriched === 0
    ? { matched: 0, disagreed: 0, total: 0, agreementShare: null as number | null }
    : {
        matched: verdictsEnriched - verdictsDisagreed,
        disagreed: verdictsDisagreed,
        total: verdictsEnriched,
        agreementShare: resolvedRateFromCounts(verdictsEnriched - verdictsDisagreed, verdictsEnriched),
      };
  const enrichmentCoverageVerdicts = verdictsTotal === 0
    ? { enriched: 0, total: 0, share: 0 }
    : { enriched: verdictsEnriched, total: verdictsTotal, share: verdictsEnriched / verdictsTotal };

  // Envelope-sourced composition facets
  // Empty implName/model is rendered as '(unknown)' so callers get a complete picture.
  // Plugins are exploded (an attempt is counted once per plugin in its pluginsJson).
  const pluginExpanded: { plugin: string }[] = [];
  for (const r of enrichmentRows) {
    if (!r.pluginsJson) continue;
    try {
      const arr = JSON.parse(r.pluginsJson) as Array<{ name?: unknown; version?: unknown }>;
      if (Array.isArray(arr)) {
        for (const p of arr) {
          const name = typeof p?.name === 'string' && p.name ? p.name : '';
          if (name) {
            const version = typeof p?.version === 'string' && p.version ? p.version : '';
            pluginExpanded.push({ plugin: version ? `${name}@${version}` : name });
          }
        }
      }
    } catch {
      // Malformed pluginsJson — skip this row's plugins.
    }
  }
  const byMode = composition(enrichmentRows, (r) => r.mode || 'unknown');
  const byHarness = composition(enrichmentRows, (r) => r.implName || '(unknown)');
  const byModel = composition(enrichmentRows, (r) => r.model || '(unknown)');
  const byPlugin = composition(pluginExpanded, (r) => r.plugin);

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
    // Distinct operator multisigs that have ever submitted an attempt on
    // EXPLORER_CHAIN_ID. This network-wide headline remains an ever-attempted
    // count; /operators owns the OLAS reward-window active/sustained surface.
    everAttemptedOperators: Number(aRow?.distinctOperators ?? 0),
    solverNetsRunning: Number(snRow?.running ?? 0),
    verdicts: verdictsTotal,
    verdictsPass,
    resolvedRate,
    // On-chain code's view (often defaulted to Pass(1) by the daemon for failed evaluations).
    onChainVerdictsPass,
    onChainResolvedRate,
    // Agreement between on-chain code and off-chain evaluation envelope.
    verdictConsistency,
    // How many verdicts have an evaluation-envelope enrichment row.
    enrichmentCoverageVerdicts,
    mostRecentSettlementBlock:
      tRow?.mostRecentSettlementBlock !== null &&
      tRow?.mostRecentSettlementBlock !== undefined
        ? String(tRow.mostRecentSettlementBlock)
        : null,
    composition: { byMode, byHarness, byModel, byPlugin },
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
  const includeUnenriched = c.req.query('include') === 'raw';

  const manifests = await db
    .select()
    .from(schema.solverNetManifest)
    .where(eq(schema.solverNetManifest.chainId, EXPLORER_CHAIN_ID));

  // Batch-load all stats in O(1) round trips instead of O(N).
  const statsByDigest = await getSolverNetStatsBatch(
    manifests.map((m) => m.cidKeccak),
    includeUnenriched,
  );

  // Batch-load sparkline series in one extra query — all manifests at once.
  const sparklinesByDigest = await getSolverNetSparklinesBatch(
    manifests.map((m) => m.cidKeccak),
    includeUnenriched,
  );

  const rows = manifests.map((m) => ({
    cid: m.id,
    // IPFS-enriched manifest fields (empty strings until the enrichment pass
    // catches up; the SPA falls back to `shortCid(cid)` for the link label
    // when `name` is empty).
    name: m.name,
    description: m.description,
    solverNetId: m.solverNetId,
    manifestEnrichmentStatus: m.manifestEnrichmentStatus,
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
 *                         Operators can appear in both boards.
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
  const includeUnenriched = c.req.query('include') === 'raw';
  // `strict` is the verdictTruth-side polarity of `includeUnenriched`: when
  // includeUnenriched is false (the default), unenriched rows must be dropped.
  const strict = !includeUnenriched;

  // Reuse the batch helper with a one-element array so the stats shape is
  // identical to what /solvernets uses.
  const statsByDigest = await getSolverNetStatsBatch([m.cidKeccak], includeUnenriched);
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
      // Verdicts for learning curves — LEFT JOIN verdictEnvelopeMeta so the
      // pass-signal can prefer the off-chain evaluator's actualPassed when
      // enriched (the on-chain verdictCode defaults to Pass for failed evals
      // in the current daemon — see ebu7.13 / uy6v.7 / gh#193). Falls back to
      // verdictCode == 1 when no envelope row.
      ids.length > 0
        ? db
            .select({
              verdictCode: schema.verdict.verdictCode,
              createdAtBlock: schema.verdict.createdAtBlock,
              actualPassed: schema.verdictEnvelopeMeta.actualPassed,
              enrichmentStatus: schema.verdictEnvelopeMeta.enrichmentStatus,
            })
            .from(schema.verdict)
            .leftJoin(
              schema.verdictEnvelopeMeta,
                verdictEnvelopeJoinCondition(),
            )
            .where(
              and(
                inArray(schema.verdict.taskId, ids),
                eq(schema.verdict.chainId, EXPLORER_CHAIN_ID),
                enrichmentFilter(includeUnenriched),
              ),
            )
            .orderBy(schema.verdict.createdAtBlock)
        : Promise.resolve([]),

      // Train board — mode-filtered leaderboard for this SolverNet
      buildLeaderboardRows({ manifestDigest: m.cidKeccak, mode: 'train', includeUnenriched }),

      // Frozen board — mode-filtered leaderboard for this SolverNet
      buildLeaderboardRows({ manifestDigest: m.cidKeccak, mode: 'frozen', includeUnenriched }),

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
              attemptEnvelopeJoinCondition(),
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
    pass: verdictTruth(v) === true,
  }));

  const learningCurveBuckets = bucketResolvedRate(samples, bucketBlocks);
  const learningCurveRolling = rollingResolvedRate(
    verdictRows.map((v) => verdictTruth(v) === true),
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

  // #820 AC#1 — load the named held-out slate once. Frozen verdicts for a
  // swe-rebench-v2 SolverNet are scoped to this slate before counting, so every
  // checkpoint's frozenResolvedRate is measured on the SAME fixed task set
  // (not "whatever frozen attempts matched its codeDigest"). The loader keeps
  // #817's fail-loud content-hash drift guard. Pass-through for other
  // solverTypes (no instance_id / slate concept) — see filterFrozenVerdictsToSlate.
  const heldOutSlate = loadHeldOutSlate(HELD_OUT_SLATE_VERSION);

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
                attemptEnvelopeJoinCondition(),
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
      const frozenVerdicts = await getVerdictsForAttempts(pairs, { includeUnenriched });
      // #820 AC#1 — scope to the named slate (per-verdict solverType gates the
      // swe-rebench-v2 family; pass-through otherwise). The slate-scoped subset
      // is what frozenResolvedRate counts, so checkpoints are comparable.
      const solverType = frozenVerdicts.find((v) => v.solverType !== '')?.solverType ?? '';
      const slateScoped = filterFrozenVerdictsToSlate(frozenVerdicts, heldOutSlate, solverType);
      const total = slateScoped.filter(
        (v) => verdictTruth(v, strict) !== null,
      ).length;
      const pass = slateScoped.filter(
        (v) => verdictTruth(v, strict) === true,
      ).length;
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

  // First pass: resolve each checkpoint's slate-scoped frozenResolvedRate, keyed
  // by cid so the held-out delta (#820 AC#2) can look up its parent's rate.
  const frozenRateByCid = new Map<string, number | null>();
  for (const r of checkpointRows) {
    const codeDigest = r.codeDigest ?? '';
    frozenRateByCid.set(
      r.cid,
      r.enrichmentStatus === 'ok' && codeDigest
        ? (frozenRateByDigest.get(codeDigest) ?? null)
        : null,
    );
  }

  const checkpointTimeline = {
    checkpoints: checkpointRows.map((r) => {
      const codeDigest = r.codeDigest ?? '';
      const frozenResolvedRate = frozenRateByCid.get(r.cid) ?? null;
      const verifiedFrozen = r.sourceBundleCid != null && r.sourceBundleCid !== '';
      // #820 AC#2 — held-out resolved-rate delta vs the parent checkpoint
      // (slate-scoped both sides). null when there's no parent or either rate
      // is unmeasured. A null parentRate (no parent, or parent unmeasured)
      // already yields a null delta, so no special-casing of "no parent".
      const parentCheckpointCid = r.parentCheckpointCid ?? null;
      const parentRate =
        parentCheckpointCid != null ? (frozenRateByCid.get(parentCheckpointCid) ?? null) : null;
      const heldOutDelta = computeHeldOutDelta(
        { frozenResolvedRate },
        { frozenResolvedRate: parentRate },
      );
      return {
        cid: r.cid,
        agentId: r.agentId,
        publishedAtBlock: String(r.publishedAtBlock),
        name: r.name ?? '',
        version: r.version ?? '',
        codeDigest,
        parentCheckpointCid,
        implName: r.implName ?? '',
        implVersion: r.implVersion ?? '',
        sourceBundleCid: r.sourceBundleCid ?? '',
        enrichmentStatus: r.enrichmentStatus ?? 'pending',
        frozenResolvedRate,
        heldOutDelta,
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

  // Override the cached batch-helper rates with route-filtered counts derived
  // from the SQL-filtered verdictRows, so the headline resolvedRate matches
  // the learning curve exactly. (Belt-and-braces: getSolverNetStatsBatch was
  // also called with includeUnenriched and already filters, but recomputing
  // from verdictRows guarantees consistency with learningCurveBuckets.)
  const filteredVerdictsTotal = verdictRows.length;
  const filteredVerdictsPass = verdictRows.filter(
    (v) => verdictTruth(v, strict) === true,
  ).length;
  const filteredResolvedRate =
    filteredVerdictsTotal === 0 ? null : filteredVerdictsPass / filteredVerdictsTotal;

  return c.json({
    cid: m.id,
    name: m.name,
    description: m.description,
    solverNetId: m.solverNetId,
    manifestEnrichmentStatus: m.manifestEnrichmentStatus,
    status: m.status,
    launcherAgentId: m.launcherAgentId,
    statusUpdatedAt: m.statusUpdatedAt,
    ...stats,
    verdicts: filteredVerdictsTotal,
    verdictsPass: filteredVerdictsPass,
    resolvedRate: filteredResolvedRate,
    learningCurveBuckets,
    learningCurveRolling,
    trainBoard: {
      ranked: trainBoard.ranked,
      lowVolume: trainBoard.lowVolume,
    },
    frozenBoard: {
      ranked: frozenBoard.ranked,
      lowVolume: frozenBoard.lowVolume,
    },
    checkpointTimeline,
    // #820 AC#1 — the named slate version frozenResolvedRate is scored against.
    heldOutSlateVersion: HELD_OUT_SLATE_VERSION,
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
 *   "activeOperators": 3,          // operators whose newest OLAS reward bucket qualifies
 *   "sustainedOperators": 1,       // operators qualified in all 8 completed 6h buckets
 *   "operatorsAtMilestone3": 2,    // operators with >=25 OLAS lifetime
 *   "appliedFilters": {},          // present when ?mode or ?harness is set
 *   "lastIndexedBlock": "...",
 *   "lastIndexedAt": "...",
 *   "behindHead": null
 * }
 * ```
 *
 * OLAS is represented by the token named JINN on Base Sepolia. Active and
 * sustained operators are computed from stOLAS Checkpoint earned-reward
 * allocations. ExternalStakingDistributor.RewardsDistributed claim rows are
 * kept only as a temporary fallback while no checkpoint rows have been indexed.
 *
 * Per row (ebu7.6):
 *   `dominantMode`    — modal executor mode among this operator's enriched attempts
 *                       ('train'|'frozen'|'unknown'). 'unknown' when no enriched attempts.
 *   `dominantHarness` — modal implName among this operator's enriched attempts.
 *                       '(unknown)' when no enriched attempts.
 *
 * Query params (ebu7.6):
 *   `?mode=train|frozen`  — restrict leaderboard to attempts with this mode.
 *                           Attempts without an AttemptEnvelopeMeta row are excluded.
 *   `?harness=<implName>` — restrict to attempts whose AttemptEnvelopeMeta.implName matches.
 *                           Stacks with ?mode.
 */
app.get('/operators', async (c) => {
  const minVerdicts = parseIntParam(
    c.req.query('minVerdicts'),
    DEFAULT_MIN_VERDICTS,
    1000,
  );

  const modeParam = c.req.query('mode');
  const harnessParam = c.req.query('harness');
  const includeUnenriched = c.req.query('include') === 'raw';

  // Determine if any filter is active. Both mode and harness can stack.
  // If harness filter is set, we use a dedicated query rather than the leaderboard
  // builder (which only supports mode). If only mode is set, delegate to
  // buildLeaderboardRows. If both, handle here.
  const hasFilter = modeParam !== undefined || harnessParam !== undefined;

  let rawRows: LeaderboardRow[];
  if (harnessParam !== undefined) {
    // Harness filter (optionally + mode): load attempts via an inner join on
    // attemptEnvelopeMeta filtered by implName (and optionally mode), then build
    // leaderboard rows in-process.
    rawRows = await buildLeaderboardRowsWithHarnessFilter(
      modeParam,
      harnessParam,
      includeUnenriched,
    );
  } else if (modeParam !== undefined) {
    rawRows = await buildLeaderboardRows({ mode: modeParam, includeUnenriched });
  } else {
    rawRows = await buildLeaderboardRows({ includeUnenriched });
  }

  // Dominant mode/harness per operator — load enriched attempts for all operators
  // and compute the modal mode/implName. Only needed for operators in `rawRows`.
  const operatorAddrs = rawRows.map((r) => r.operator);
  const dominantMap = await getDominantModeAndHarness(operatorAddrs);

  const activeBundle = await loadActiveOperators(Math.floor(Date.now() / 1000));
  const activeResult = activeBundle.result;

  const lifetimeRewardRows = await loadLifetimeRewards(activeBundle.source);

  const lifetimeRewards = new Map<`0x${string}`, bigint>();
  for (const r of lifetimeRewardRows) {
    lifetimeRewards.set(r.multisig, BigInt(r.operatorRewarded ?? 0));
  }

  const operatorsAtMilestone3 = countOperatorsAtMilestone3(
    lifetimeRewardRows.map((r) => ({
      multisig: r.multisig,
      operatorRewarded: BigInt(r.operatorRewarded ?? 0),
    })),
  );

  const isActive = (op: string) => activeResult.active.has(op);
  const recentBlocksFor = (op: string): boolean[] =>
    activeResult.perOperator.get(op)?.blocks ??
    new Array(activeResult.window.blockCount).fill(false);

  const rows: (LeaderboardRow & { recentBlocks: boolean[] })[] = rawRows.map((r) => ({
    ...r,
    active: isActive(r.operator),
    recentBlocks: recentBlocksFor(r.operator),
    jinnEarned: lifetimeRewards.get(r.operator) ?? 0n,
  }));

  const { ranked, lowVolume } = rankLeaderboard(rows, minVerdicts, compareByJinnEarnedActive);

  // Applied filters — only included when at least one filter is active.
  const appliedFilters: Record<string, string> = {};
  if (modeParam !== undefined) appliedFilters['mode'] = modeParam;
  if (harnessParam !== undefined) appliedFilters['harness'] = harnessParam;

  // Read the heads computed by the middleware — no second DB / RPC round trips.
  const meta = c.get('indexedHead');
  const chainHead = c.get('chainHead');
  const freshnessFields = freshness(meta.lastIndexedBlock, meta.lastIndexedAt, chainHead ?? undefined);

  const allJinnEarnedZero = rows.every((r) => r.jinnEarned === 0n);

  const serializeRow = (r: LeaderboardRow & { rank?: number; recentBlocks: boolean[] }) => ({
    ...r,
    jinnEarned: r.jinnEarned.toString(),
    dominantMode: dominantMap.get(r.operator)?.mode ?? 'unknown',
    dominantHarness: dominantMap.get(r.operator)?.harness ?? '(unknown)',
  });

  return c.json({
    ranked: ranked.map(serializeRow),
    lowVolume: lowVolume.map(serializeRow),
    minVerdicts,
    activeOperators: activeResult.active.size,
    sustainedOperators: activeResult.sustained.size,
    operatorsAtMilestone3,
    activeWindow: serialiseActiveWindow(activeResult.window),
    ...(hasFilter ? { appliedFilters } : {}),
    meta: {
      jinnAttribution: allJinnEarnedZero ? 'pending' : 'ok',
      rewardActivitySource: activeBundle.source,
    },
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
 *     "resolvedRate": null
 *   },
 *   "lastIndexedBlock": "...",
 *   "lastIndexedAt": "...",
 *   "behindHead": null
 * }
 * ```
 *
 * Post-pivot there is no per-operator `jinnEarned` / `jinnAttribution` (the
 * JINN token economy was removed); `totals` carries on-chain activity only.
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
  const includeUnenriched = c.req.query('include') === 'raw';

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
      },
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
  const verdictRows = await getVerdictsForAttempts(attemptPairs, { includeUnenriched });

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
          .innerJoin(schema.attempt, attemptEnvelopeJoinCondition())
          .where(
            and(
              inArray(schema.attemptEnvelopeMeta.requestId, requestIds),
              eq(schema.attempt.chainId, EXPLORER_CHAIN_ID),
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
      if (verdictTruth(v)) row.verdictsPass += 1;
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
  const totalVerdictsPass = verdictRows.filter((v) => verdictTruth(v) === true).length;
  const totalResolvedRate = resolvedRateFromCounts(totalVerdictsPass, totalVerdictsTotal);

  // Dominant dims across all enriched attempts for this operator
  const dominantDims = computeDominantDims(envelopeRows);

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
    },
    ...freshnessFields,
  });
});

// ── GET /explorer/slice ──────────────────────────────────────────────────────

app.use('/slice', explorerFreshness());

/**
 * GET /explorer/slice — parameterized engine per spec §6 / #611.
 *
 * Operates within ONE SolverNet (manifestDigest is required). Returns a curve
 * + leaderboard + KPIs for the slice defined by (group, filter,
 * includeUnenriched, bucket).
 *
 * Strangler-fig: existing /explorer/solvernet/:cid stays live for back-compat;
 * SolverNetView migrates to consume this endpoint with default params.
 */
app.get('/slice', async (c) => {
  let params;
  try {
    params = parseSliceParams(new URL(c.req.url).searchParams);
  } catch (e) {
    return c.json({ error: (e as Error).message }, 400);
  }

  // Resolve manifestDigest (the IPFS CID) → cidKeccak (the keccak we index by).
  const manifests = await db
    .select({ cidKeccak: schema.solverNetManifest.cidKeccak })
    .from(schema.solverNetManifest)
    .where(
      and(
        eq(schema.solverNetManifest.id, params.manifestDigest),
        eq(schema.solverNetManifest.chainId, EXPLORER_CHAIN_ID),
      ),
    );
  if (manifests.length === 0) {
    return c.json({ error: 'unknown solvernet' }, 404);
  }
  const cidKeccak = manifests[0].cidKeccak;

  // Get the task ids belonging to this SolverNet.
  const taskIds = await db
    .select({ id: schema.task.id })
    .from(schema.task)
    .where(
      and(
        eq(schema.task.manifestDigest, cidKeccak),
        eq(schema.task.chainId, EXPLORER_CHAIN_ID),
      ),
    );
  const ids = taskIds.map((t) => t.id);

  const meta = c.get('indexedHead');
  const chainHead = c.get('chainHead');

  if (ids.length === 0) {
    const empty = computeSlice([], params, { rawVerdictCount: 0 });
    return c.json({
      ...empty,
      ...freshness(meta.lastIndexedBlock, meta.lastIndexedAt, chainHead ?? undefined),
    });
  }

  // Raw count (pre-filter) — for enrichmentCoverage.
  const rawVerdictRows = await db
    .select({ total: count() })
    .from(schema.verdict)
    .where(
      and(
        inArray(schema.verdict.taskId, ids),
        eq(schema.verdict.chainId, EXPLORER_CHAIN_ID),
      ),
    );
  const rawVerdictCount = Number(rawVerdictRows[0]?.total ?? 0);

  // Filtered join — what the engine consumes.
  const joinedRows = await db
    .select({
      requestId: schema.verdict.requestId,
      operator: schema.attempt.operator,
      createdAtBlock: schema.verdict.createdAtBlock,
      verdictCode: schema.verdict.verdictCode,
      actualPassed: schema.verdictEnvelopeMeta.actualPassed,
      enrichmentStatus: schema.verdictEnvelopeMeta.enrichmentStatus,
      mode: schema.attemptEnvelopeMeta.mode,
      harness: schema.attemptEnvelopeMeta.implName,
      model: schema.attemptEnvelopeMeta.model,
      pluginsJson: schema.attemptEnvelopeMeta.pluginsJson,
    })
    .from(schema.verdict)
    .leftJoin(schema.verdictEnvelopeMeta, verdictEnvelopeJoinCondition())
    // Canonical verdict ⇒ attempt join: (taskId, attemptIndex, chainId).
    // The previous shape joined on requestId — but verdict.requestId is the
    // evaluation mech request, attempt.requestId is the restoration mech
    // request, so the two never matched and `operator` came back null for
    // every row (collapsing group=operator to a single 0x000…0 series). See
    // the canonical pattern in `getVerdictsForAttempts` below.
    .leftJoin(
      schema.attempt,
      and(
        eq(schema.attempt.taskId, schema.verdict.taskId),
        eq(schema.attempt.attemptIndex, schema.verdict.attemptIndex),
        eq(schema.attempt.chainId, schema.verdict.chainId),
      ),
    )
    .leftJoin(
      schema.attemptEnvelopeMeta,
      attemptEnvelopeJoinCondition(),
    )
    .where(
      and(
        inArray(schema.verdict.taskId, ids),
        eq(schema.verdict.chainId, EXPLORER_CHAIN_ID),
        enrichmentFilter(params.includeUnenriched),
      ),
    )
    // Chronological order is required: computeOneSeries hands these rows
    // straight to rollingResolvedRate, which is a time-series rolling window.
    // PostgreSQL does not guarantee a deterministic order without ORDER BY,
    // and the sibling /explorer/solvernet/:cid route applies the same sort
    // for the same reason (see line ~722 above).
    .orderBy(schema.verdict.createdAtBlock);

  // Resolve builder agentIds from the plugin tarball cids carried in each
  // attempt's pluginsJson, via the pluginPublication entity (the same store
  // /builders/:address/artifacts reads). One batched IN query, not N+1 (#1050).
  // Note: pluginCid → builderAgentId is one-to-many (the pluginCid index is
  // non-unique — the same tarball can be published by multiple builders), so a
  // cid maps to *all* matching builders and rows explode across them, matching
  // the exploded plugin semantics. Builders are deduped per row below.
  const rowCids = joinedRows.map((r) => parsePluginCids(r.pluginsJson));
  const cids = [...new Set(rowCids.flat())];
  const builderMap = new Map<string, string[]>();
  if (cids.length > 0) {
    const pubRows = await db
      .select({
        pluginCid: schema.pluginPublication.pluginCid,
        builderAgentId: schema.pluginPublication.builderAgentId,
      })
      .from(schema.pluginPublication)
      .where(
        and(
          inArray(schema.pluginPublication.pluginCid, cids),
          eq(schema.pluginPublication.chainId, EXPLORER_CHAIN_ID),
        ),
      );
    for (const p of pubRows) {
      const list = builderMap.get(p.pluginCid) ?? [];
      list.push(p.builderAgentId);
      builderMap.set(p.pluginCid, list);
    }
  }

  // Decode pluginsJson into a string[] of "name@version".
  const sliceRows = joinedRows.map((r, i) => ({
    requestId: r.requestId,
    operator: r.operator ?? '0x0000000000000000000000000000000000000000',
    createdAtBlock: r.createdAtBlock,
    verdictCode: r.verdictCode,
    actualPassed: r.actualPassed,
    enrichmentStatus: r.enrichmentStatus,
    mode: r.mode,
    harness: r.harness,
    model: r.model,
    plugins: parsePluginsJson(r.pluginsJson),
    builder: [
      ...new Set(rowCids[i].flatMap((cid) => builderMap.get(cid) ?? [])),
    ],
  }));

  const out = computeSlice(sliceRows, params, { rawVerdictCount });

  // Overlay leaderboards (re-use existing buildLeaderboardRows; ignores group/filter
  // for now — Phase 3 / follow-up can wire filter[operator] into the leaderboard).
  const trainRows = await buildLeaderboardRows({ manifestDigest: cidKeccak, mode: 'train' });
  const frozenRows = await buildLeaderboardRows({ manifestDigest: cidKeccak, mode: 'frozen' });
  out.leaderboard = {
    train: trainRows.map(toSliceLeaderboardRow),
    frozen: frozenRows.map(toSliceLeaderboardRow),
  };

  return c.json({
    ...out,
    ...freshness(meta.lastIndexedBlock, meta.lastIndexedAt, chainHead ?? undefined),
  });
});

/**
 * Adapter: maps a metrics-side {@link LeaderboardRow} (typed for the explorer's
 * existing /operators + /solvernet/:cid leaderboards) into the slice response's
 * {@link SliceResponseLeaderboardRow} shape.
 *
 * Differences the adapter resolves:
 *   - `operator`: widens `` `0x${string}` `` to plain `string` (slice response is
 *     consumer-facing and doesn't pin the hex-prefixed template-literal type).
 *   - `settledContribution`: dropped (not part of the slice response shape).
 *   - `dominantMode` / `dominantHarness`: passed through when present (optional
 *     on both sides; `buildLeaderboardRows` does not currently emit these).
 */
function toSliceLeaderboardRow(
  r: LeaderboardRow & { dominantMode?: string; dominantHarness?: string },
): SliceResponseLeaderboardRow {
  return {
    operator: r.operator,
    attempts: r.attempts,
    verdictsTotal: r.verdictsTotal,
    verdictsPass: r.verdictsPass,
    resolvedRate: r.resolvedRate,
    dominantMode: r.dominantMode,
    dominantHarness: r.dominantHarness,
  };
}

/**
 * Decode AttemptEnvelopeMeta.pluginsJson → the plugin tarball cids it carries,
 * deduped. Mirrors {@link parsePluginsJson}'s try/catch but keeps `entry.cid`
 * (which the name@version decode discards). The cid is the join key against the
 * pluginPublication entity for builder-agentId resolution (#1050).
 */
export function parsePluginCids(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw) as Array<{ cid?: unknown }>;
    if (!Array.isArray(arr)) return [];
    const cids = arr
      .map((p) => (typeof p?.cid === 'string' && p.cid ? p.cid : ''))
      .filter(Boolean);
    return [...new Set(cids)];
  } catch {
    return [];
  }
}

/** Decode AttemptEnvelopeMeta.pluginsJson → ["name@version", ...]. */
function parsePluginsJson(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw) as Array<{ name?: unknown; version?: unknown }>;
    if (!Array.isArray(arr)) return [];
    return arr
      .map((p) => {
        const name = typeof p?.name === 'string' && p.name ? p.name : '';
        if (!name) return '';
        const version = typeof p?.version === 'string' && p.version ? p.version : '';
        return version ? `${name}@${version}` : name;
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

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
  includeUnenriched = false,
): Promise<Map<`0x${string}`, number[]>> {
  const result = new Map<`0x${string}`, number[]>(
    cidKeccaks.map((k) => [k, []]),
  );

  if (cidKeccaks.length === 0) return result;

  // One aggregate query: GROUP BY (manifestDigest, bucketIndex) where
  // bucketIndex = floor(verdict.createdAtBlock / SPARKLINE_BUCKET_BLOCKS).
  // The bucket expression MUST be inlined as a literal (not a bound param) so
  // the SELECT and GROUP BY expressions are identical text — Postgres compares
  // them textually and rejects the query as a non-grouped column reference if
  // the param placeholders differ between SELECT and GROUP BY. We also wrap in
  // FLOOR(...)::bigint because Ponder's `t.bigint()` columns are stored as
  // PostgreSQL NUMERIC (so EVM uint256 fits), and NUMERIC / NUMERIC returns
  // NUMERIC with decimals — JS-side `BigInt(...)` then blows up on the
  // fraction (e.g. '828.4158400000000000'). FLOOR + ::bigint truncates.
  const sparklineBucketExpr = sql.raw(
    `floor(verdict.created_at_block / ${SPARKLINE_BUCKET_BLOCKS.toString()})::bigint`,
  );
  const bucketRows = await db
    .select({
      manifestDigest: schema.task.manifestDigest,
      bucketIndex: sql<string>`${sparklineBucketExpr}`,
      total: count(),
      pass: count(verdictTruthPassCountSql()),
    })
    .from(schema.verdict)
    .innerJoin(schema.task, eq(schema.verdict.taskId, schema.task.id))
    .leftJoin(schema.verdictEnvelopeMeta, verdictEnvelopeJoinCondition())
    .where(
      and(
        inArray(schema.task.manifestDigest, cidKeccaks),
        eq(schema.task.chainId, EXPLORER_CHAIN_ID),
        eq(schema.verdict.chainId, EXPLORER_CHAIN_ID),
        enrichmentFilter(includeUnenriched),
      ),
    )
    .groupBy(schema.task.manifestDigest, sql`${sparklineBucketExpr}`);

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
  includeUnenriched = false,
): Promise<
  Map<
    `0x${string}`,
    {
      tasksPosted: number;
      tasksSettled: number;
      attempts: number;
      verdicts: number;
      verdictsPass: number;          // envelope-truth-preferring (the headline)
      onChainVerdictsPass: number;   // raw on-chain (verdictCode == 1)
      enrichedVerdicts: number;
      disagreedVerdicts: number;
      resolvedRate: number | null;          // envelope-truth-preferring
      onChainResolvedRate: number | null;   // raw on-chain
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
        onChainVerdictsPass: 0,
        enrichedVerdicts: 0,
        disagreedVerdicts: 0,
        resolvedRate: null as number | null,
        onChainResolvedRate: null as number | null,
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
  // LEFT JOIN verdictEnvelopeMeta so we can compute envelope-truth pass count
  // (ebu7.13): on-chain verdictCode defaults to Pass(1) in the daemon for
  // failed evaluations; prefer the off-chain actualPassed where enriched.
  const verdictAgg = await db
    .select({
      manifestDigest: schema.task.manifestDigest,
      verdicts: count(),
      onChainPass: count(
        sql`CASE WHEN ${schema.verdict.verdictCode} = 1 THEN 1 END`,
      ),
      // Envelope-truth pass: prefer enriched actualPassed; fall back to on-chain code.
      envelopePass: count(verdictTruthPassCountSql()),
      enriched: count(
        sql`CASE WHEN ${schema.verdictEnvelopeMeta.enrichmentStatus} = 'ok' THEN 1 END`,
      ),
      disagreed: count(verdictTruthDisagreementCountSql()),
    })
    .from(schema.verdict)
    .innerJoin(schema.task, eq(schema.verdict.taskId, schema.task.id))
    .leftJoin(
      schema.verdictEnvelopeMeta,
      verdictEnvelopeJoinCondition(),
    )
    .where(
      and(
        inArray(schema.task.manifestDigest, cidKeccaks),
        eq(schema.task.chainId, EXPLORER_CHAIN_ID),
        eq(schema.verdict.chainId, EXPLORER_CHAIN_ID),
        enrichmentFilter(includeUnenriched),
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
      const envelopePass = Number(row.envelopePass);
      const onChainPass = Number(row.onChainPass);
      entry.verdicts = verdicts;
      entry.verdictsPass = envelopePass;
      entry.onChainVerdictsPass = onChainPass;
      entry.enrichedVerdicts = Number(row.enriched);
      entry.disagreedVerdicts = Number(row.disagreed);
      entry.resolvedRate = resolvedRateFromCounts(envelopePass, verdicts);
      entry.onChainResolvedRate = resolvedRateFromCounts(onChainPass, verdicts);
    }
  }

  return result;
}

/**
 * Fetches all verdicts for a set of (taskId, attemptIndex) pairs.
 * Returns the subset of verdict rows matching any of the pairs.
 * Scoped to EXPLORER_CHAIN_ID.
 *
 * `opts.includeUnenriched` (default `false` — strict per spec §4) restricts
 * the result to verdict rows whose verdictEnvelopeMeta.enrichmentStatus = 'ok'.
 */
async function getVerdictsForAttempts(
  pairs: { taskId: string; attemptIndex: number }[],
  opts?: { includeUnenriched?: boolean },
): Promise<
  (VerdictTruthRow & {
    taskId: string;
    attemptIndex: number;
    instanceId: string;
    solverType: string;
  })[]
> {
  if (pairs.length === 0) return [];

  const includeUnenriched = opts?.includeUnenriched ?? false;
  const taskIds = [...new Set(pairs.map((p) => p.taskId))];
  const rows = await db
    .select({
      taskId: schema.verdict.taskId,
      attemptIndex: schema.verdict.attemptIndex,
      verdictCode: schema.verdict.verdictCode,
      actualPassed: schema.verdictEnvelopeMeta.actualPassed,
      enrichmentStatus: schema.verdictEnvelopeMeta.enrichmentStatus,
      // #820 AC#1 — instanceId scopes frozen verdicts to the held-out slate;
      // solverType gates the scope to the swe-rebench-v2 family. Both come from
      // the LEFT-JOINed verdictEnvelopeMeta (null when no envelope row).
      instanceId: schema.verdictEnvelopeMeta.instanceId,
      solverType: schema.verdictEnvelopeMeta.solverType,
    })
    .from(schema.verdict)
    .leftJoin(schema.verdictEnvelopeMeta, verdictEnvelopeJoinCondition())
    .where(
      and(
        inArray(schema.verdict.taskId, taskIds),
        eq(schema.verdict.chainId, EXPLORER_CHAIN_ID),
        enrichmentFilter(includeUnenriched),
      ),
    );

  // Filter to only the exact (taskId, attemptIndex) pairs. Coerce the
  // LEFT-JOINed instanceId/solverType nulls to '' so downstream slate scoping
  // (filterFrozenVerdictsToSlate) sees a plain string.
  const pairSet = new Set(pairs.map((p) => `${p.taskId}:${p.attemptIndex}`));
  return rows
    .filter((r) => pairSet.has(`${r.taskId}:${r.attemptIndex}`))
    .map((r) => ({
      ...r,
      instanceId: r.instanceId ?? '',
      solverType: r.solverType ?? '',
    }));
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
  /**
   * Spec §4 — when `false` (the new default), verdict-side reads drop
   * unenriched rows from both numerator and denominator. When `true`, the
   * legacy permissive behaviour is restored (used by `?include=raw`).
   */
  includeUnenriched?: boolean;
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
 * matching `AttemptEnvelopeMeta.mode` row count.
 */
async function buildLeaderboardRows(
  opts: BuildLeaderboardOptions = {},
): Promise<LeaderboardRow[]> {
  const { manifestDigest, mode, includeUnenriched = false } = opts;

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
          attemptEnvelopeJoinCondition(),
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

  const allVerdicts = await getVerdictsForAttempts(
    allAttempts.map((a) => ({
      taskId: a.taskId,
      attemptIndex: a.attemptIndex,
    })),
    { includeUnenriched },
  );

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
    const verdictsPass = opVerdicts.filter((v) => verdictTruth(v) === true).length;

    rows.push({
      operator: op as `0x${string}`,
      attempts: opAttempts.length,
      settledContribution: settled,
      verdictsTotal,
      verdictsPass,
      resolvedRate: resolvedRateFromCounts(verdictsPass, verdictsTotal),
      jinnEarned: 0n,
      // Default to inactive; the /operators handler overlays the real value
      // from the OLAS reward window.
      active: false,
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
      attemptEnvelopeJoinCondition(),
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
 * Scoped to EXPLORER_CHAIN_ID.
 */
async function buildLeaderboardRowsWithHarnessFilter(
  modeFilter: string | undefined,
  harnessFilter: string,
  includeUnenriched = false,
): Promise<LeaderboardRow[]> {
  // Build the envelope filter conditions
  const envelopeConditions = [
    attemptEnvelopeJoinCondition(),
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

  const allVerdicts = await getVerdictsForAttempts(
    joinedRows.map((a) => ({
      taskId: a.taskId,
      attemptIndex: a.attemptIndex,
    })),
    { includeUnenriched },
  );

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
    const verdictsPass = opVerdicts.filter((v) => verdictTruth(v) === true).length;

    rows.push({
      operator: op as `0x${string}`,
      attempts: opAttempts.length,
      settledContribution: settled,
      verdictsTotal,
      verdictsPass,
      resolvedRate: resolvedRateFromCounts(verdictsPass, verdictsTotal),
      jinnEarned: 0n,
      // Mode/harness-filtered boards default `active` to false; the /operators
      // handler overlays the real value from the OLAS reward window.
      active: false,
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

// ── GET /explorer/corpus + /explorer/corpus/:cid (#1406) ─────────────────────
//
// The browsable corpus: an index of published capture envelopes and a
// per-item detail read. Reads captureEnvelopeMeta (the same enriched table the
// #1314 distribution signal rolls into clusters). Seeds excluded by default;
// ?include=seeded folds them in, mirroring /distribution-signal. Scoped to
// EXPLORER_CHAIN_ID like every other explorer route. captureEnvelopeMeta is
// optional (backward compat with schemas predating #1314).

/** Load all capture-envelope-meta rows for the explorer chain; [] when the table is absent. */
async function loadCaptureMetas(): Promise<CaptureEnvelopeMetaRow[]> {
  const s = schema as { captureEnvelopeMeta?: unknown };
  if (!s.captureEnvelopeMeta) return [];
  const rows = (await db
    .select()
    .from(schema.captureEnvelopeMeta)
    .where(eq(schema.captureEnvelopeMeta.chainId, EXPLORER_CHAIN_ID))) as unknown as CaptureEnvelopeMetaRow[];
  return rows;
}

app.use('/corpus', explorerFreshness());
app.use('/corpus/:cid', explorerFreshness());

/**
 * GET /explorer/corpus
 *
 * Sorted, paginated index of corpus items (published capture envelopes).
 * Sort is server-side over the full corpus (?sort=createdAt|cluster|tier|
 * stepCount, ?dir=asc|desc; default createdAt desc). Pagination via ?limit
 * (default 25, max 200) and ?offset. Seeds excluded by default;
 * ?include=seeded folds seeded/imported envelopes back in. ?cluster=<name>
 * filters to a single cluster (exact, case-sensitive; #1414).
 */
app.get('/corpus', async (c) => {
  const includeSeeds = c.req.query('include') === 'seeded';
  const limitRaw = Number.parseInt(c.req.query('limit') ?? '', 10);
  const offsetRaw = Number.parseInt(c.req.query('offset') ?? '', 10);
  const sort = c.req.query('sort');
  const dir = c.req.query('dir') === 'asc' ? 'asc' : 'desc';
  const cluster = c.req.query('cluster') || undefined;
  const metas = await loadCaptureMetas();
  const result = buildCorpusList(metas, {
    includeSeeds,
    cluster,
    limit: Number.isFinite(limitRaw) ? limitRaw : undefined,
    offset: Number.isFinite(offsetRaw) ? offsetRaw : undefined,
    sort,
    dir,
  });

  const meta = c.get('indexedHead');
  const chainHead = c.get('chainHead');
  return c.json({
    ...result,
    ...freshness(meta.lastIndexedBlock, meta.lastIndexedAt, chainHead ?? undefined),
  });
});

/**
 * GET /explorer/corpus/:cid
 *
 * One corpus item's detail — the deep-link target the CLI links to. Returns
 * 404 when the CID is not in the indexed corpus. Seeds are resolvable by
 * direct CID (the detail is a link target, not a signal reader).
 */
app.get('/corpus/:cid', async (c) => {
  const cid = c.req.param('cid');
  const metas = await loadCaptureMetas();
  const item = buildCorpusItem(metas, cid);

  const meta = c.get('indexedHead');
  const chainHead = c.get('chainHead');
  const fresh = freshness(meta.lastIndexedBlock, meta.lastIndexedAt, chainHead ?? undefined);

  if (!item) {
    return c.json({ error: 'unknown corpus item', ...fresh }, 404);
  }
  return c.json({ ...item, ...fresh });
});

export default app;
