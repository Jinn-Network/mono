/**
 * Public Polymarket data client for prediction.v1.
 *
 * Uses only unauthenticated Gamma / CLOB market-data endpoints. No trading,
 * signing, order placement, or wallet surface belongs in this module.
 */

export interface PolymarketClientConfig {
  gammaBaseUrl?: string;
  clobBaseUrl?: string;
  fetchImpl?: typeof fetch;
}

export interface ListMarketCandidatesArgs extends PolymarketClientConfig {
  limit?: number;
  offset?: number;
}

export interface GetMarketArgs extends PolymarketClientConfig {
  marketId?: string;
  slug?: string;
  conditionId?: string;
}

export interface GetOrderbookArgs extends PolymarketClientConfig {
  marketId: string;
  conditionId: string;
  yesTokenId: string;
}

export interface GetResolutionArgs extends PolymarketClientConfig {
  marketId?: string;
  slug?: string;
  conditionId?: string;
  sourceUrl?: string;
}

export interface MarketCandidate {
  venue: 'polymarket';
  marketId: string;
  conditionId: string;
  slug: string;
  url: string;
  question: string;
  description?: string;
  rulesText: string;
  endTime: string;
  active: boolean;
  closed: boolean;
  archived: boolean;
  outcomes: ['YES', 'NO'];
  tokenIds: { yes: string; no: string };
  liquidityUsd: string;
  volume24hUsd: string;
}

export interface OrderbookSnapshot {
  venue: 'polymarket';
  marketId: string;
  conditionId: string;
  sampledAt: string;
  bestBidYes: string;
  bestAskYes: string;
  midpointYes: string;
  spread: string;
  source: 'polymarket-clob';
}

export interface ResolutionSnapshot {
  venue: 'polymarket';
  marketId: string;
  conditionId: string;
  status: 'unresolved' | 'resolved' | 'invalid' | 'cancelled' | 'ambiguous';
  outcome?: 'YES' | 'NO';
  resolvedAt?: string;
  sourceUrl: string;
}

const DEFAULT_GAMMA_BASE_URL = 'https://gamma-api.polymarket.com';
const DEFAULT_CLOB_BASE_URL = 'https://clob.polymarket.com';

function clientFetch(config: PolymarketClientConfig): typeof fetch {
  return config.fetchImpl ?? fetch;
}

function gammaUrl(config: PolymarketClientConfig, path: string, params: Record<string, string | number | boolean | undefined> = {}): string {
  const url = new URL(path, config.gammaBaseUrl ?? DEFAULT_GAMMA_BASE_URL);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  return url.toString();
}

function clobUrl(config: PolymarketClientConfig, path: string, params: Record<string, string | number | boolean | undefined> = {}): string {
  const url = new URL(path, config.clobBaseUrl ?? DEFAULT_CLOB_BASE_URL);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  return url.toString();
}

async function readJson(url: string, fetchImpl: typeof fetch): Promise<unknown> {
  const response = await fetchImpl(url, { method: 'GET' });
  if (!response.ok) {
    throw new Error(`Polymarket request failed ${response.status}: ${url}`);
  }
  return response.json() as Promise<unknown>;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function firstString(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return undefined;
}

function firstBoolean(record: Record<string, unknown>, keys: string[], fallback = false): boolean {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') {
      if (value.toLowerCase() === 'true') return true;
      if (value.toLowerCase() === 'false') return false;
    }
  }
  return fallback;
}

function parseStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return value.split(',').map((part) => part.trim()).filter(Boolean);
  }
}

function decimalString(value: unknown, fallback = '0'): string {
  if (typeof value === 'number' && Number.isFinite(value)) return value.toFixed(2);
  if (typeof value === 'string' && value.trim()) return value.trim();
  return fallback;
}

function normalizeOutcome(value: string): string {
  return value.trim().toUpperCase();
}

function buildMarketUrl(slug: string): string {
  return slug ? `https://polymarket.com/event/${slug}` : 'https://polymarket.com';
}

function rulesTextOf(record: Record<string, unknown>): string {
  return firstString(record, [
    'rules',
    'resolutionRules',
    'resolution_rules',
    'description',
    'question',
  ]) ?? '';
}

function endTimeOf(record: Record<string, unknown>): string {
  return firstString(record, ['endDateIso', 'endDate', 'end_date', 'endTime', 'end_time']) ?? '';
}

function tokenIdsFor(record: Record<string, unknown>, outcomes: string[]): { yes: string; no: string } | null {
  const ids = parseStringArray(record['clobTokenIds'] ?? record['clob_token_ids'] ?? record['tokenIds']);
  if (ids.length < 2) return null;
  const yesIndex = outcomes.findIndex((outcome) => normalizeOutcome(outcome) === 'YES');
  const noIndex = outcomes.findIndex((outcome) => normalizeOutcome(outcome) === 'NO');
  if (yesIndex < 0 || noIndex < 0) return null;
  const yes = ids[yesIndex];
  const no = ids[noIndex];
  return yes && no ? { yes, no } : null;
}

export function normalizeMarketCandidate(raw: unknown): MarketCandidate | null {
  const record = asRecord(raw);
  const marketId = firstString(record, ['id', 'marketId', 'market_id']);
  const conditionId = firstString(record, ['conditionId', 'condition_id']);
  const slug = firstString(record, ['slug', 'marketSlug', 'eventSlug']) ?? '';
  const question = firstString(record, ['question', 'title']) ?? '';
  const outcomes = parseStringArray(record['outcomes']).map(normalizeOutcome);
  const binary = outcomes.length === 2 && outcomes.includes('YES') && outcomes.includes('NO');
  const tokenIds = binary ? tokenIdsFor(record, outcomes) : null;
  const endTime = endTimeOf(record);

  if (!marketId || !conditionId || !question || !binary || !tokenIds || !endTime) {
    return null;
  }

  const url = firstString(record, ['url']) ?? buildMarketUrl(slug);
  return {
    venue: 'polymarket',
    marketId,
    conditionId,
    slug,
    url,
    question,
    ...(firstString(record, ['description']) ? { description: firstString(record, ['description']) } : {}),
    rulesText: rulesTextOf(record),
    endTime,
    active: firstBoolean(record, ['active'], true),
    closed: firstBoolean(record, ['closed'], false),
    archived: firstBoolean(record, ['archived'], false),
    outcomes: ['YES', 'NO'],
    tokenIds,
    liquidityUsd: decimalString(record['liquidity'] ?? record['liquidityNum'] ?? record['liquidity_usd']),
    volume24hUsd: decimalString(record['volume24hr'] ?? record['volume24h'] ?? record['volume24hUsd'] ?? record['volume_24h']),
  };
}

export async function listMarketCandidates(args: ListMarketCandidatesArgs = {}): Promise<MarketCandidate[]> {
  const body = await readJson(
    gammaUrl(args, '/markets', {
      active: true,
      closed: false,
      archived: false,
      limit: args.limit ?? 100,
      offset: args.offset ?? 0,
    }),
    clientFetch(args),
  );
  const rows = Array.isArray(body)
    ? body
    : Array.isArray(asRecord(body)['data'])
      ? asRecord(body)['data'] as unknown[]
      : [];
  return rows
    .map(normalizeMarketCandidate)
    .filter((candidate): candidate is MarketCandidate => candidate !== null);
}

export async function getMarket(args: GetMarketArgs): Promise<MarketCandidate> {
  const fetchImpl = clientFetch(args);
  let raw: unknown;
  if (args.marketId) {
    raw = await readJson(gammaUrl(args, `/markets/${encodeURIComponent(args.marketId)}`), fetchImpl);
  } else if (args.slug) {
    raw = await readJson(gammaUrl(args, `/markets/slug/${encodeURIComponent(args.slug)}`), fetchImpl);
  } else if (args.conditionId) {
    const candidates = await listMarketCandidates({ ...args, limit: 500 });
    const found = candidates.find((candidate) => candidate.conditionId === args.conditionId);
    if (!found) throw new Error(`Polymarket market not found for conditionId=${args.conditionId}`);
    return found;
  } else {
    throw new Error('getMarket requires marketId, slug, or conditionId');
  }
  const candidate = normalizeMarketCandidate(raw);
  if (!candidate) throw new Error('Polymarket market response is not an eligible binary market');
  return candidate;
}

function timestampToIso(value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date(value > 10_000_000_000 ? value : value * 1000).toISOString();
  }
  if (typeof value === 'string' && value.trim()) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return timestampToIso(numeric);
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  }
  return new Date().toISOString();
}

function bestBidAsk(book: Record<string, unknown>): { bid: number; ask: number } | null {
  const bids = Array.isArray(book['bids']) ? book['bids'] as unknown[] : [];
  const asks = Array.isArray(book['asks']) ? book['asks'] as unknown[] : [];
  const bid = Math.max(...bids.map((row) => Number(asRecord(row)['price'])).filter(Number.isFinite));
  const ask = Math.min(...asks.map((row) => Number(asRecord(row)['price'])).filter(Number.isFinite));
  if (!Number.isFinite(bid) || !Number.isFinite(ask)) return null;
  return { bid, ask };
}

function probability(value: number): string {
  return Math.max(0, Math.min(1, value)).toFixed(4);
}

export async function getOrderbook(args: GetOrderbookArgs): Promise<OrderbookSnapshot> {
  const raw = await readJson(
    clobUrl(args, '/book', { token_id: args.yesTokenId }),
    clientFetch(args),
  );
  const book = asRecord(raw);
  const best = bestBidAsk(book);
  if (!best) {
    throw new Error(`Polymarket orderbook has no usable YES bid/ask for token ${args.yesTokenId}`);
  }
  const midpoint = (best.bid + best.ask) / 2;
  return {
    venue: 'polymarket',
    marketId: args.marketId,
    conditionId: args.conditionId,
    sampledAt: timestampToIso(book['timestamp']),
    bestBidYes: probability(best.bid),
    bestAskYes: probability(best.ask),
    midpointYes: probability(midpoint),
    spread: probability(best.ask - best.bid),
    source: 'polymarket-clob',
  };
}

function outcomeFromRecord(record: Record<string, unknown>): 'YES' | 'NO' | undefined {
  const explicit = firstString(record, [
    'winningOutcome',
    'winning_outcome',
    'winner',
    'resolvedOutcome',
    'resolved_outcome',
    'outcome',
  ]);
  if (explicit) {
    const normalized = normalizeOutcome(explicit);
    if (normalized === 'YES') return 'YES';
    if (normalized === 'NO') return 'NO';
  }

  const outcomes = parseStringArray(record['outcomes']).map(normalizeOutcome);
  const prices = parseStringArray(record['outcomePrices'] ?? record['outcome_prices']);
  if (outcomes.length === prices.length && outcomes.length > 0) {
    const winnerIndex = prices.findIndex((price) => Number(price) >= 0.999);
    const winner = winnerIndex >= 0 ? outcomes[winnerIndex] : undefined;
    if (winner === 'YES' || winner === 'NO') return winner;
  }
  return undefined;
}

export async function getResolution(args: GetResolutionArgs): Promise<ResolutionSnapshot> {
  let market: MarketCandidate | null = null;
  let record: Record<string, unknown> = {};
  const fetchImpl = clientFetch(args);
  let raw: unknown;
  if (args.marketId) {
    raw = await readJson(gammaUrl(args, `/markets/${encodeURIComponent(args.marketId)}`), fetchImpl);
  } else if (args.slug) {
    raw = await readJson(gammaUrl(args, `/markets/slug/${encodeURIComponent(args.slug)}`), fetchImpl);
  } else if (args.conditionId) {
    market = await getMarket(args);
    raw = await readJson(gammaUrl(args, `/markets/${encodeURIComponent(market.marketId)}`), fetchImpl);
  } else {
    throw new Error('getResolution requires marketId, slug, or conditionId');
  }
  record = asRecord(raw);
  market = normalizeMarketCandidate(record) ?? market;

  const conditionId = market?.conditionId ?? args.conditionId ?? firstString(record, ['conditionId', 'condition_id']) ?? '';
  const marketId = market?.marketId ?? args.marketId ?? firstString(record, ['id', 'marketId', 'market_id']) ?? '';
  const sourceUrl = market?.url ?? args.sourceUrl ?? buildMarketUrl(firstString(record, ['slug']) ?? '');
  const closed = firstBoolean(record, ['closed'], market?.closed ?? false);
  const archived = firstBoolean(record, ['archived'], market?.archived ?? false);
  const outcome = outcomeFromRecord(record);
  const resolutionStatus = firstString(record, ['resolutionStatus', 'umaResolutionStatus', 'status'])?.toLowerCase() ?? '';

  if (/cancel/.test(resolutionStatus)) {
    return { venue: 'polymarket', marketId, conditionId, status: 'cancelled', sourceUrl };
  }
  if (/invalid/.test(resolutionStatus)) {
    return { venue: 'polymarket', marketId, conditionId, status: 'invalid', sourceUrl };
  }
  if (closed && outcome) {
    return {
      venue: 'polymarket',
      marketId,
      conditionId,
      status: 'resolved',
      outcome,
      resolvedAt: timestampToIso(firstString(record, ['resolvedAt', 'resolutionTime', 'updatedAt', 'endDate'])),
      sourceUrl,
    };
  }
  if (closed || archived) {
    return { venue: 'polymarket', marketId, conditionId, status: 'ambiguous', sourceUrl };
  }
  return { venue: 'polymarket', marketId, conditionId, status: 'unresolved', sourceUrl };
}
