/**
 * Auto-generator for prediction.v1 Polymarket forecast rounds.
 */

import { randomUUID } from 'node:crypto';
import type { Task } from '../types/task.js';
import type { TaskV1, SignedTaskV1 } from '../types/task-document.js';
import { signTaskV1 } from '../tasks/signing.js';
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

export function makePredictionV1Generator(config: PredictionV1AutoConfig = {}) {
  const postedAtByCondition = new Map<string, number>();
  const postedCountByDay = new Map<string, number>();
  const allowlist = conditionIdSet(config.allowlistConditionIds);
  const blocklist = conditionIdSet(config.blocklistConditionIds);
  let lastPollStartedAt = 0;

  return async (): Promise<Task[] | null> => {
    const now = Date.now();
    const cadenceMs = config.cadenceMs ?? DEFAULTS.cadenceMs;
    if (cadenceMs > 0 && lastPollStartedAt > 0 && now - lastPollStartedAt < cadenceMs) {
      return null;
    }
    lastPollStartedAt = now;

    pruneOpenRounds(postedAtByCondition, now);
    const dayKey = new Date(now).toISOString().slice(0, 10);
    const todayCount = postedCountByDay.get(dayKey) ?? 0;
    const dailyRemaining = Math.max(0, (config.maxNewRoundsPerDay ?? DEFAULTS.maxNewRoundsPerDay) - todayCount);
    const openRemaining = Math.max(0, (config.maxOpenRounds ?? DEFAULTS.maxOpenRounds) - postedAtByCondition.size);
    const pollLimit = Math.min(config.maxNewRoundsPerPoll ?? DEFAULTS.maxNewRoundsPerPoll, dailyRemaining, openRemaining);
    if (pollLimit <= 0) return null;

    let candidates: MarketCandidate[];
    try {
      candidates = await listMarketCandidates({ ...config, limit: 250 });
    } catch {
      return null;
    }

    const eligible: EligibleMarket[] = [];
    for (const market of prioritizeAllowlisted(candidates, allowlist)) {
      if (eligible.length >= pollLimit * 3) break;
      const conditionId = normalizeConditionId(market.conditionId);
      if (postedAtByCondition.has(conditionId) || blocklist.has(conditionId)) continue;
      const checked = await checkMarketEligibility(market, config, now);
      if (checked) eligible.push(checked);
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
    for (const entry of selected) {
      const task = await buildTask(entry, config, now);
      postedAtByCondition.set(normalizeConditionId(entry.market.conditionId), Date.parse(entry.market.endTime));
      tasks.push(task);
    }
    if (tasks.length > 0) {
      postedCountByDay.set(dayKey, todayCount + tasks.length);
    }
    return tasks.length > 0 ? tasks : null;
  };
}

async function checkMarketEligibility(
  market: MarketCandidate,
  config: PredictionV1AutoConfig,
  now: number,
): Promise<EligibleMarket | null> {
  if (!market.rulesText.trim()) return null;
  if (Number(market.liquidityUsd) < Number(config.minLiquidityUsd ?? DEFAULTS.minLiquidityUsd)) return null;
  if (Number(market.volume24hUsd) < Number(config.minVolume24hUsd ?? DEFAULTS.minVolume24hUsd)) return null;

  const resolutionMs = Date.parse(market.endTime);
  if (!Number.isFinite(resolutionMs)) return null;
  const timeToResolutionHours = (resolutionMs - now) / 3_600_000;
  if (timeToResolutionHours < (config.minTimeToResolutionHours ?? DEFAULTS.minTimeToResolutionHours)) return null;
  if (timeToResolutionHours > (config.maxTimeToResolutionHours ?? DEFAULTS.maxTimeToResolutionHours)) return null;

  let resolutionStatus: string;
  try {
    const resolution = await getResolution({
      ...config,
      marketId: market.marketId,
      sourceUrl: market.url,
    });
    resolutionStatus = resolution.status;
  } catch {
    return null;
  }
  if (resolutionStatus !== 'unresolved') return null;
  if (!market.active || market.closed || market.archived) return null;

  let orderbook: OrderbookSnapshot;
  try {
    orderbook = await getOrderbook({
      ...config,
      marketId: market.marketId,
      conditionId: market.conditionId,
      yesTokenId: market.tokenIds.yes,
    });
  } catch {
    return null;
  }
  const orderbookAgeSeconds = Math.max(0, (now - Date.parse(orderbook.sampledAt)) / 1000);
  if (orderbookAgeSeconds > (config.maxOrderbookAgeSeconds ?? DEFAULTS.maxOrderbookAgeSeconds)) return null;
  if (Number(orderbook.spread) > Number(config.maxYesSpread ?? DEFAULTS.maxYesSpread)) return null;

  return { market, orderbook, timeToResolutionHours, orderbookAgeSeconds };
}

async function buildTask(
  entry: EligibleMarket,
  config: PredictionV1AutoConfig,
  now: number,
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
    role: 'restoration',
    window: { startTs, endTs },
    claimPolicy,
    spec,
    eligibility,
  };

  if (config.agentEoa && config.safeAddress && config.agentPrivateKey) {
    const taskDoc: TaskV1 = {
      schemaVersion: 'task.v1',
      id,
      solverType: 'prediction.v1',
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
