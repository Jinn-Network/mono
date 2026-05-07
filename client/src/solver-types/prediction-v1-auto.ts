/**
 * Auto-generator for prediction.v1 Polymarket forecast rounds.
 */

import { randomUUID } from 'node:crypto';
import type { Task } from '../types/task.js';
import type { TaskV1, SignedTaskV1 } from '../types/task-document.js';
import { signTaskV1 } from '../tasks/signing.js';
import type { LaunchedSolverNetRecord } from '../solvernets/store.js';
import {
  getResolution,
  getOrderbook,
  listMarketCandidates,
  type MarketCandidate,
  type OrderbookSnapshot,
  type PolymarketClientConfig,
} from '../venues/polymarket/client.js';

export interface PredictionV1AutoConfig extends PolymarketClientConfig {
  minTimeToResolutionHours?: number;
  maxTimeToResolutionHours?: number;
  minLiquidityUsd?: string;
  minVolume24hUsd?: string;
  maxYesSpread?: string;
  maxOrderbookAgeSeconds?: number;
  cadenceMs?: number;
  maxNewRoundsPerPoll?: number;
  maxNewRoundsPerDay?: number;
  maxOpenRounds?: number;
  submissionWindowMs?: number;
  agentEoa?: `0x${string}`;
  safeAddress?: `0x${string}`;
  agentPrivateKey?: `0x${string}`;
  allowlistConditionIds?: string[];
  blocklistConditionIds?: string[];
}

interface EligibleMarket {
  market: MarketCandidate;
  orderbook: OrderbookSnapshot;
  timeToResolutionHours: number;
  orderbookAgeSeconds: number;
}

/**
 * Persistent state observable via `getState()` (Task 5 of
 * spec/2026-05-05-launcher-role-and-mode.md §5.3). The launcher status
 * endpoint surfaces these fields verbatim. Stale-poll detection
 * (lastPollAt + 2*cadence) is computed by the endpoint, not here.
 */
export type PredictionV1SkipReason =
  | 'already_posted'
  | 'blocklisted'
  | 'no_rules_text'
  | 'low_liquidity'
  | 'low_volume'
  | 'invalid_resolution_time'
  | 'too_soon'
  | 'too_late'
  | 'resolution_fetch_failed'
  | 'already_resolved'
  | 'inactive_or_closed'
  | 'orderbook_fetch_failed'
  | 'orderbook_stale'
  | 'spread_too_wide';

export interface PredictionV1GeneratorState {
  lastPollAt?: string;
  lastPollSummary?: {
    evaluated: number;
    posted: number;
    skipped: number;
    skipReasons?: Partial<Record<PredictionV1SkipReason, number>>;
  };
  lastError?: { message: string; at: string };
}

export interface PredictionV1GeneratorStateSnapshot extends PredictionV1GeneratorState {
  cadenceMs: number;
}

export type PredictionV1GeneratorTick = (() => Promise<Task[] | null>) & {
  getState(): PredictionV1GeneratorStateSnapshot;
};

const DEFAULTS = {
  minTimeToResolutionHours: 24,
  maxTimeToResolutionHours: 168,
  minLiquidityUsd: '10000',
  minVolume24hUsd: '2500',
  maxYesSpread: '0.10',
  maxOrderbookAgeSeconds: 60,
  cadenceMs: 6 * 60 * 60 * 1000,
  maxNewRoundsPerPoll: 25,
  maxNewRoundsPerDay: 100,
  maxOpenRounds: 250,
  submissionWindowMs: 6 * 60 * 60 * 1000,
} as const;

type EligibilityResult =
  | { ok: true; market: EligibleMarket }
  | { ok: false; reason: PredictionV1SkipReason };

async function checkMarketEligibility(
  market: MarketCandidate,
  config: PredictionV1AutoConfig,
  now: number,
): Promise<EligibilityResult> {
  if (!market.rulesText.trim()) return { ok: false, reason: 'no_rules_text' };
  if (Number(market.liquidityUsd) < Number(config.minLiquidityUsd ?? DEFAULTS.minLiquidityUsd))
    return { ok: false, reason: 'low_liquidity' };
  if (Number(market.volume24hUsd) < Number(config.minVolume24hUsd ?? DEFAULTS.minVolume24hUsd))
    return { ok: false, reason: 'low_volume' };

  const resolutionMs = Date.parse(market.endTime);
  if (!Number.isFinite(resolutionMs)) return { ok: false, reason: 'invalid_resolution_time' };
  const timeToResolutionHours = (resolutionMs - now) / 3_600_000;
  if (timeToResolutionHours < (config.minTimeToResolutionHours ?? DEFAULTS.minTimeToResolutionHours))
    return { ok: false, reason: 'too_soon' };
  if (timeToResolutionHours > (config.maxTimeToResolutionHours ?? DEFAULTS.maxTimeToResolutionHours))
    return { ok: false, reason: 'too_late' };

  let resolutionStatus: string;
  try {
    const resolution = await getResolution({
      ...config,
      marketId: market.marketId,
      sourceUrl: market.url,
    });
    resolutionStatus = resolution.status;
  } catch {
    return { ok: false, reason: 'resolution_fetch_failed' };
  }
  if (resolutionStatus !== 'unresolved') return { ok: false, reason: 'already_resolved' };
  if (!market.active || market.closed || market.archived)
    return { ok: false, reason: 'inactive_or_closed' };

  let orderbook: OrderbookSnapshot;
  try {
    orderbook = await getOrderbook({
      ...config,
      marketId: market.marketId,
      conditionId: market.conditionId,
      yesTokenId: market.tokenIds.yes,
    });
  } catch {
    return { ok: false, reason: 'orderbook_fetch_failed' };
  }
  const orderbookAgeSeconds = Math.max(0, (now - Date.parse(orderbook.sampledAt)) / 1000);
  if (orderbookAgeSeconds > (config.maxOrderbookAgeSeconds ?? DEFAULTS.maxOrderbookAgeSeconds))
    return { ok: false, reason: 'orderbook_stale' };
  if (Number(orderbook.spread) > Number(config.maxYesSpread ?? DEFAULTS.maxYesSpread))
    return { ok: false, reason: 'spread_too_wide' };

  return { ok: true, market: { market, orderbook, timeToResolutionHours, orderbookAgeSeconds } };
}

interface BuildTaskExtras {
  /**
   * Spec §14 (Task 24): IPFS CID of the launched SolverNet manifest the task
   * is being posted under. Becomes `manifestDigest = keccak256(manifestCid)`
   * on chain. Required by the production adapter; tests that don't reach
   * postTask may omit it.
   */
  solverNetManifestCid?: string;
}

async function buildTask(
  entry: EligibleMarket,
  config: PredictionV1AutoConfig,
  now: number,
  extras: BuildTaskExtras = {},
): Promise<Task> {
  const { market, orderbook, timeToResolutionHours, orderbookAgeSeconds } = entry;
  const startTs = now;
  const endTs = now + (config.submissionWindowMs ?? DEFAULTS.submissionWindowMs);
  const shortCondition = market.conditionId.replace(/^0x/i, '').slice(0, 16);
  const sampledStamp = orderbook.sampledAt.replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const id = `prediction-v1-polymarket-${shortCondition}-${sampledStamp}`;
  const claimPolicy = {
    mode: 'parallel',
    maxClaims: 25,
    maxClaimsPerOperator: 1,
    claimLeaseTtlSeconds: 30 * 60,
  } as const;
  const spec = {
    question: {
      kind: 'binary',
      text: market.question,
      yesLabel: 'YES',
      noLabel: 'NO',
    },
    source: {
      type: 'prediction-market',
      venue: 'polymarket',
      url: market.url,
      identifiers: {
        marketId: market.marketId,
        conditionId: market.conditionId,
        yesTokenId: market.tokenIds.yes,
        noTokenId: market.tokenIds.no,
      },
    },
    resolution: {
      expectedResolutionTime: new Date(Date.parse(market.endTime)).toISOString(),
      rulesText: market.rulesText,
      rulesUrl: market.url,
      timezone: 'UTC',
    },
    consensusSnapshot: {
      sampledAt: orderbook.sampledAt,
      probabilityYes: orderbook.midpointYes,
      method: 'best-bid-ask-midpoint',
      bestBidYes: orderbook.bestBidYes,
      bestAskYes: orderbook.bestAskYes,
      spread: orderbook.spread,
      source: 'polymarket-clob',
    },
    eligibilitySnapshot: {
      sampledAt: new Date(now).toISOString(),
      timeToResolutionHours: Number(timeToResolutionHours.toFixed(2)),
      liquidityUsd: market.liquidityUsd,
      volume24hUsd: market.volume24hUsd,
      orderbookAgeSeconds: Number(orderbookAgeSeconds.toFixed(0)),
      selectionReason: 'weekly-binary-liquid-clear-rules',
    },
  };
  const eligibility = {
    dedupKey: `polymarket:${market.conditionId}`,
    minTimeToResolutionHours: config.minTimeToResolutionHours ?? DEFAULTS.minTimeToResolutionHours,
    maxTimeToResolutionHours: config.maxTimeToResolutionHours ?? DEFAULTS.maxTimeToResolutionHours,
    minLiquidityUsd: config.minLiquidityUsd ?? DEFAULTS.minLiquidityUsd,
    minVolume24hUsd: config.minVolume24hUsd ?? DEFAULTS.minVolume24hUsd,
    maxYesSpread: config.maxYesSpread ?? DEFAULTS.maxYesSpread,
    maxOrderbookAgeSeconds: config.maxOrderbookAgeSeconds ?? DEFAULTS.maxOrderbookAgeSeconds,
    generatorCadenceMs: config.cadenceMs ?? DEFAULTS.cadenceMs,
    maxNewRoundsPerPoll: config.maxNewRoundsPerPoll ?? DEFAULTS.maxNewRoundsPerPoll,
    maxNewRoundsPerDay: config.maxNewRoundsPerDay ?? DEFAULTS.maxNewRoundsPerDay,
    maxOpenRounds: config.maxOpenRounds ?? DEFAULTS.maxOpenRounds,
    manualAllowlistHit: conditionIdSet(config.allowlistConditionIds).has(normalizeConditionId(market.conditionId)),
  };
  const baseTask: Task = {
    id,
    description: 'Forecast a binary externally resolved prediction market.',
    solverType: 'prediction.v1',
    contractId: 'prediction',
    contractVersion: 'v1',
    ...(extras.solverNetManifestCid
      ? { solverNetManifestCid: extras.solverNetManifestCid }
      : {}),
    role: 'restoration',
    window: { startTs, endTs },
    claimPolicy,
    spec,
    eligibility,
  };

  if (config.agentEoa && config.safeAddress && config.agentPrivateKey && extras.solverNetManifestCid) {
    const taskDoc: TaskV1 = {
      schemaVersion: 'task.v1',
      id,
      solverType: 'prediction.v1',
      contractId: 'prediction',
      contractVersion: 'v1',
      solverNetManifestCid: extras.solverNetManifestCid,
      role: 'restoration',
      description: baseTask.description,
      window: baseTask.window!,
      claimPolicy,
      spec,
      eligibility,
      creator: {
        safeAddress: config.safeAddress,
        agentEoa: config.agentEoa,
      },
      createdAt: now,
    };
    const signedTask: SignedTaskV1 = await signTaskV1(taskDoc, config.agentPrivateKey);
    return { ...baseTask, signedTask };
  }

  return { ...baseTask, id: baseTask.id ?? randomUUID() };
}

function pruneOpenRounds(postedAtByCondition: Map<string, number>, now: number): void {
  for (const [conditionId, endTime] of postedAtByCondition.entries()) {
    if (Number.isFinite(endTime) && endTime < now) {
      postedAtByCondition.delete(conditionId);
    }
  }
}

function normalizeConditionId(conditionId: string): string {
  return conditionId.trim().toLowerCase();
}

function conditionIdSet(values?: string[]): Set<string> {
  return new Set(
    (values ?? [])
      .map((value) => normalizeConditionId(value))
      .filter(Boolean),
  );
}

function prioritizeAllowlisted(markets: MarketCandidate[], allowlist: Set<string>): MarketCandidate[] {
  if (allowlist.size === 0) return markets;
  return [...markets].sort((a, b) => {
    const allowDelta =
      Number(allowlist.has(normalizeConditionId(b.conditionId))) -
      Number(allowlist.has(normalizeConditionId(a.conditionId)));
    return allowDelta;
  });
}

// ────────────────────────────────────────────────────────────────────────────
//
// Launched-record generator (Task 12 of
// spec/2026-05-05-solvernet-creation-and-launch.md §11).
//
// `makePredictionV1GeneratorForLaunchedRecord` is the entry point used by
// the SolverNet subsystem (`daemon-init.ts`) to spawn a generator per local
// launched record the daemon owns. It uses two tick-time references the
// daemon (and the API) update at runtime:
//
//   - `recordRef.current` — the live `LaunchedSolverNetRecord` mirror. The
//     daemon updates this when it writes a status flip (`launched ↔ paused
//     ↔ retired/failed`) or toggles `generatorEnabled`. The per-tick gate
//     reads `record.status === 'launched' && record.generatorEnabled` and
//     early-returns otherwise. No daemon restart, no generator recreation.
//
//   - `configRef.current` — the hot-applyable subset of
//     `PredictionV1AutoConfig` (the fields the operator can edit at runtime
//     via the SolverNet config API endpoint in Task 14: cadence, allow/block
//     lists, max caps, submission window). The static deps (agentEoa, safe
//     address, agent private key, polymarket fetchImpl) stay captured at
//     construction time — those don't move once a SolverNet has launched.
//
// Task 22 of the SolverNet plan retired the legacy
// `makePredictionV1Generator` factory + `collectTestnetAutoTaskGenerators`
// path; this is the only public generator factory.
//
// ────────────────────────────────────────────────────────────────────────────

/**
 * Hot-applyable subset of `PredictionV1AutoConfig`. Anything in here can be
 * edited at runtime through the SolverNet config API endpoint (Task 14) and
 * picked up within one generator cadence — the daemon updates
 * `configRef.current` and persists to disk; the next tick reads the new
 * value through the closure.
 *
 * Kept narrow on purpose: agent identity (EOA / Safe / private key) and the
 * polymarket transport (`fetchImpl`, base URLs) are captured once at
 * construction time and live in `staticConfig` below.
 */
export interface PredictionV1GeneratorRuntimeConfig {
  cadenceMs?: number;
  maxNewRoundsPerPoll?: number;
  maxNewRoundsPerDay?: number;
  maxOpenRounds?: number;
  submissionWindowMs?: number;
  allowlistConditionIds?: string[];
  blocklistConditionIds?: string[];
  // Eligibility tuning — also runtime-editable per the launcher edit form
  // (spec §17, Task 14 surfaces).
  minTimeToResolutionHours?: number;
  maxTimeToResolutionHours?: number;
  minLiquidityUsd?: string;
  minVolume24hUsd?: string;
  maxYesSpread?: string;
  maxOrderbookAgeSeconds?: number;
}

/**
 * Static-at-construction-time portion of the generator config — set once when
 * the daemon spawns the generator from a launched record and never read from
 * the configRef after that. Polymarket transport plus the agent's signing
 * material.
 */
export interface PredictionV1GeneratorStaticConfig extends PolymarketClientConfig {
  agentEoa?: `0x${string}`;
  safeAddress?: `0x${string}`;
  agentPrivateKey?: `0x${string}`;
}

export interface MakePredictionV1GeneratorForLaunchedRecordOpts {
  /**
   * Live mirror of the launched record. The daemon flips status / toggles
   * generatorEnabled by mutating `current` after persisting to disk; the
   * generator's per-tick gate reads `current.status` and
   * `current.generatorEnabled` directly.
   */
  recordRef: { current: LaunchedSolverNetRecord };
  /**
   * Live mirror of the hot-applyable config. The SolverNet config API
   * endpoint (Task 14) mutates `current` after persisting to disk; the next
   * tick reads cadence/allow-block-lists/max-caps from
   * `current.<field>`.
   */
  configRef: { current: PredictionV1GeneratorRuntimeConfig };
  /** Construction-time-fixed deps (transport + agent identity). */
  staticConfig?: PredictionV1GeneratorStaticConfig;
}

/**
 * Factory that builds a `prediction.v1` Polymarket auto-generator gated on a
 * locally owned launched record + a hot-applyable runtime config. Used by
 * the SolverNet subsystem (`daemon-init.ts`) to spawn one generator per
 * `pendingGenerators` entry.
 *
 * The returned callable retains the existing `getState()` extension (the
 * launcher-status endpoint reads it). Cadence in the snapshot reflects the
 * LIVE configRef value, not the construction-time one — operators editing
 * cadence through the API see the change in `/v1/launcher/status` on the
 * next status read.
 */
export function makePredictionV1GeneratorForLaunchedRecord(
  opts: MakePredictionV1GeneratorForLaunchedRecordOpts,
): PredictionV1GeneratorTick {
  const { recordRef, configRef, staticConfig = {} } = opts;
  const postedAtByCondition = new Map<string, number>();
  const postedCountByDay = new Map<string, number>();
  let lastPollStartedAt = 0;
  const state: PredictionV1GeneratorState = {};

  const tick = async (): Promise<Task[] | null> => {
    // Launched-record gate (Task 12, spec §11). Two conditions:
    //   1. record.status === 'launched' (not paused / retired / failed /
    //      launching).
    //   2. record.generatorEnabled === true (operator's per-record toggle).
    // Either failing means the daemon has paused or shut off this generator
    // — do nothing this tick. Cadence bookkeeping is intentionally not
    // touched: when the gate re-opens we want the very first tick to poll.
    const record = recordRef.current;
    if (record.status !== 'launched') return null;
    if (!record.generatorEnabled) return null;

    const runtime = configRef.current;
    const now = Date.now();
    const cadenceMs = runtime.cadenceMs ?? DEFAULTS.cadenceMs;
    if (cadenceMs > 0 && lastPollStartedAt > 0 && now - lastPollStartedAt < cadenceMs) {
      return null;
    }
    lastPollStartedAt = now;
    state.lastPollAt = new Date(now).toISOString();

    pruneOpenRounds(postedAtByCondition, now);
    const allowlist = conditionIdSet(runtime.allowlistConditionIds);
    const blocklist = conditionIdSet(runtime.blocklistConditionIds);
    const dayKey = new Date(now).toISOString().slice(0, 10);
    const todayCount = postedCountByDay.get(dayKey) ?? 0;
    const dailyRemaining = Math.max(0, (runtime.maxNewRoundsPerDay ?? DEFAULTS.maxNewRoundsPerDay) - todayCount);
    const openRemaining = Math.max(0, (runtime.maxOpenRounds ?? DEFAULTS.maxOpenRounds) - postedAtByCondition.size);
    const pollLimit = Math.min(runtime.maxNewRoundsPerPoll ?? DEFAULTS.maxNewRoundsPerPoll, dailyRemaining, openRemaining);
    if (pollLimit <= 0) {
      state.lastPollSummary = { evaluated: 0, posted: 0, skipped: 0 };
      state.lastError = undefined;
      return null;
    }

    // Compose the per-call config the eligibility helpers expect — they
    // already accept `PredictionV1AutoConfig`, so we project the runtime
    // ref + static deps into that shape.
    const callConfig: PredictionV1AutoConfig = {
      ...staticConfig,
      cadenceMs: runtime.cadenceMs,
      maxNewRoundsPerPoll: runtime.maxNewRoundsPerPoll,
      maxNewRoundsPerDay: runtime.maxNewRoundsPerDay,
      maxOpenRounds: runtime.maxOpenRounds,
      submissionWindowMs: runtime.submissionWindowMs,
      allowlistConditionIds: runtime.allowlistConditionIds,
      blocklistConditionIds: runtime.blocklistConditionIds,
      minTimeToResolutionHours: runtime.minTimeToResolutionHours,
      maxTimeToResolutionHours: runtime.maxTimeToResolutionHours,
      minLiquidityUsd: runtime.minLiquidityUsd,
      minVolume24hUsd: runtime.minVolume24hUsd,
      maxYesSpread: runtime.maxYesSpread,
      maxOrderbookAgeSeconds: runtime.maxOrderbookAgeSeconds,
    };

    let candidates: MarketCandidate[];
    try {
      candidates = await listMarketCandidates({ ...callConfig, limit: 250 });
    } catch (err) {
      state.lastError = {
        message: err instanceof Error ? err.message : String(err),
        at: new Date().toISOString(),
      };
      state.lastPollSummary = { evaluated: 0, posted: 0, skipped: 0 };
      return null;
    }

    const eligible: EligibleMarket[] = [];
    let evaluatedCount = 0;
    const skipReasons: Partial<Record<PredictionV1SkipReason, number>> = {};
    const bumpSkip = (reason: PredictionV1SkipReason) => {
      skipReasons[reason] = (skipReasons[reason] ?? 0) + 1;
    };
    for (const market of prioritizeAllowlisted(candidates, allowlist)) {
      if (eligible.length >= pollLimit * 3) break;
      const conditionId = normalizeConditionId(market.conditionId);
      if (postedAtByCondition.has(conditionId)) {
        bumpSkip('already_posted');
        continue;
      }
      if (blocklist.has(conditionId)) {
        bumpSkip('blocklisted');
        continue;
      }
      evaluatedCount += 1;
      const checked = await checkMarketEligibility(market, callConfig, now);
      if (checked.ok) {
        eligible.push(checked.market);
      } else {
        bumpSkip(checked.reason);
      }
    }

    eligible.sort((a, b) => {
      const allowDelta =
        Number(allowlist.has(normalizeConditionId(b.market.conditionId))) -
        Number(allowlist.has(normalizeConditionId(a.market.conditionId)));
      if (allowDelta !== 0) return allowDelta;
      const liquidityDelta = Number(b.market.liquidityUsd) - Number(a.market.liquidityUsd);
      if (Number.isFinite(liquidityDelta) && liquidityDelta !== 0) return liquidityDelta;
      const spreadDelta = Number(a.orderbook.spread) - Number(b.orderbook.spread);
      if (Number.isFinite(spreadDelta) && spreadDelta !== 0) return spreadDelta;
      return a.timeToResolutionHours - b.timeToResolutionHours;
    });

    const selected = eligible.slice(0, pollLimit);
    const tasks: Task[] = [];
    // Task 24 (spec §14): bind every generated task to the launched
    // SolverNet manifest so the on-chain digest derives from
    // `keccak256(manifestCid)`.
    const solverNetManifestCid = record.manifestCid;
    for (const entry of selected) {
      const task = await buildTask(entry, callConfig, now, { solverNetManifestCid });
      postedAtByCondition.set(normalizeConditionId(entry.market.conditionId), Date.parse(entry.market.endTime));
      tasks.push(task);
    }
    if (tasks.length > 0) {
      postedCountByDay.set(dayKey, todayCount + tasks.length);
    }
    const evaluated = evaluatedCount;
    const posted = tasks.length;
    const skipped = Math.max(0, evaluated - posted);
    state.lastPollSummary = {
      evaluated,
      posted,
      skipped,
      skipReasons: Object.keys(skipReasons).length > 0 ? skipReasons : undefined,
    };
    state.lastError = undefined;
    return tasks.length > 0 ? tasks : null;
  };

  return Object.assign(tick, {
    getState(): PredictionV1GeneratorStateSnapshot {
      return {
        lastPollAt: state.lastPollAt,
        lastPollSummary: state.lastPollSummary ? { ...state.lastPollSummary } : undefined,
        lastError: state.lastError ? { ...state.lastError } : undefined,
        // Reflect the LIVE cadence from the runtime ref so launcher-status
        // shows what the generator will use on its next tick, not what was
        // captured at construction.
        cadenceMs: configRef.current.cadenceMs ?? DEFAULTS.cadenceMs,
      };
    },
  });
}
