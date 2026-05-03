#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const DEFAULT_GAMMA_BASE_URL = 'https://gamma-api.polymarket.com';
const DEFAULT_CLOB_BASE_URL = 'https://clob.polymarket.com';

const MarketArgsShape = {
  marketId: z.string().min(1).optional().describe('Exact Polymarket market id from the current prediction task.'),
  slug: z.string().min(1).optional().describe('Exact Polymarket market slug from the current prediction task URL.'),
  conditionId: z.string().min(1).optional().describe('Expected condition id from the current prediction task, used only to verify the returned market.'),
};

const OrderbookArgsShape = {
  marketId: z.string().min(1).describe('Exact Polymarket market id from the current prediction task.'),
  conditionId: z.string().min(1).describe('Exact condition id from the current prediction task.'),
  yesTokenId: z.string().min(1).describe('YES outcome CLOB token id from the current prediction task.'),
};

const MarketArgsSchema = z.object(MarketArgsShape).strict().refine((args) => args.marketId || args.slug, {
  message: 'marketId or slug is required',
});

const OrderbookArgsSchema = z.object(OrderbookArgsShape).strict();

export function listToolDeclarations() {
  return [
    {
      name: 'polymarket_get_market',
      description:
        'Read one exact Polymarket binary market named by the current prediction task. Requires marketId or slug and never performs broad market search.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          marketId: { type: 'string', description: 'Exact Polymarket market id from the current prediction task.' },
          slug: { type: 'string', description: 'Exact Polymarket market slug from the current prediction task URL.' },
          conditionId: { type: 'string', description: 'Expected task condition id for verification.' },
        },
      },
    },
    {
      name: 'polymarket_get_orderbook',
      description:
        'Read the YES orderbook for the exact market/condition/token identifiers in the current prediction task. Read-only CLOB market data only.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['marketId', 'conditionId', 'yesTokenId'],
        properties: {
          marketId: { type: 'string', description: 'Exact Polymarket market id from the current prediction task.' },
          conditionId: { type: 'string', description: 'Exact condition id from the current prediction task.' },
          yesTokenId: { type: 'string', description: 'YES outcome CLOB token id from the current prediction task.' },
        },
      },
    },
  ];
}

function configWithDefaults(config = {}) {
  return {
    gammaBaseUrl: config.gammaBaseUrl ?? process.env.POLYMARKET_GAMMA_BASE_URL ?? DEFAULT_GAMMA_BASE_URL,
    clobBaseUrl: config.clobBaseUrl ?? process.env.POLYMARKET_CLOB_BASE_URL ?? DEFAULT_CLOB_BASE_URL,
    fetchImpl: config.fetchImpl ?? fetch,
  };
}

function apiUrl(baseUrl, path, params = {}) {
  const url = new URL(path, baseUrl);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  return url.toString();
}

async function readJson(url, fetchImpl) {
  const response = await fetchImpl(url, { method: 'GET' });
  if (!response.ok) {
    throw new Error(`Polymarket request failed ${response.status}: ${url}`);
  }
  return response.json();
}

function asRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function firstString(record, keys) {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return undefined;
}

function firstBoolean(record, keys, fallback = false) {
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

function parseStringArray(value) {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return value.split(',').map((part) => part.trim()).filter(Boolean);
  }
}

function normalizeOutcome(value) {
  return value.trim().toUpperCase();
}

function decimalString(value, fallback = '0') {
  if (typeof value === 'number' && Number.isFinite(value)) return value.toFixed(2);
  if (typeof value === 'string' && value.trim()) return value.trim();
  return fallback;
}

function buildMarketUrl(slug) {
  return slug ? `https://polymarket.com/event/${slug}` : 'https://polymarket.com';
}

function rulesTextOf(record) {
  return firstString(record, [
    'rules',
    'resolutionRules',
    'resolution_rules',
    'description',
    'question',
  ]) ?? '';
}

function endTimeOf(record) {
  return firstString(record, ['endDateIso', 'endDate', 'end_date', 'endTime', 'end_time']) ?? '';
}

function tokenIdsFor(record, outcomes) {
  const ids = parseStringArray(record.clobTokenIds ?? record.clob_token_ids ?? record.tokenIds);
  if (ids.length < 2) return null;
  const yesIndex = outcomes.findIndex((outcome) => normalizeOutcome(outcome) === 'YES');
  const noIndex = outcomes.findIndex((outcome) => normalizeOutcome(outcome) === 'NO');
  if (yesIndex < 0 || noIndex < 0) return null;
  const yes = ids[yesIndex];
  const no = ids[noIndex];
  return yes && no ? { yes, no } : null;
}

export function normalizeMarketCandidate(raw) {
  const record = asRecord(raw);
  const marketId = firstString(record, ['id', 'marketId', 'market_id']);
  const conditionId = firstString(record, ['conditionId', 'condition_id']);
  const slug = firstString(record, ['slug', 'marketSlug', 'eventSlug']) ?? '';
  const question = firstString(record, ['question', 'title']) ?? '';
  const outcomes = parseStringArray(record.outcomes).map(normalizeOutcome);
  const binary = outcomes.length === 2 && outcomes.includes('YES') && outcomes.includes('NO');
  const tokenIds = binary ? tokenIdsFor(record, outcomes) : null;
  const endTime = endTimeOf(record);

  if (!marketId || !conditionId || !question || !binary || !tokenIds || !endTime) {
    return null;
  }

  const description = firstString(record, ['description']);
  return {
    venue: 'polymarket',
    marketId,
    conditionId,
    slug,
    url: firstString(record, ['url']) ?? buildMarketUrl(slug),
    question,
    ...(description ? { description } : {}),
    rulesText: rulesTextOf(record),
    endTime,
    active: firstBoolean(record, ['active'], true),
    closed: firstBoolean(record, ['closed'], false),
    archived: firstBoolean(record, ['archived'], false),
    outcomes: ['YES', 'NO'],
    tokenIds,
    liquidityUsd: decimalString(record.liquidity ?? record.liquidityNum ?? record.liquidity_usd),
    volume24hUsd: decimalString(record.volume24hr ?? record.volume24h ?? record.volume24hUsd ?? record.volume_24h),
  };
}

export async function getMarket(args, config = {}) {
  const parsed = MarketArgsSchema.parse(args);
  const { gammaBaseUrl, fetchImpl } = configWithDefaults(config);
  const raw = parsed.marketId
    ? await readJson(apiUrl(gammaBaseUrl, `/markets/${encodeURIComponent(parsed.marketId)}`), fetchImpl)
    : await readJson(apiUrl(gammaBaseUrl, `/markets/slug/${encodeURIComponent(parsed.slug)}`), fetchImpl);

  const market = normalizeMarketCandidate(raw);
  if (!market) throw new Error('Polymarket market response is not an eligible binary market');
  if (parsed.conditionId && market.conditionId !== parsed.conditionId) {
    throw new Error(`Polymarket conditionId mismatch: expected ${parsed.conditionId}, got ${market.conditionId}`);
  }
  return market;
}

function timestampToIso(value) {
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

function bestBidAsk(book) {
  const bids = Array.isArray(book.bids) ? book.bids : [];
  const asks = Array.isArray(book.asks) ? book.asks : [];
  const bid = Math.max(...bids.map((row) => Number(asRecord(row).price)).filter(Number.isFinite));
  const ask = Math.min(...asks.map((row) => Number(asRecord(row).price)).filter(Number.isFinite));
  if (!Number.isFinite(bid) || !Number.isFinite(ask)) return null;
  return { bid, ask };
}

function probability(value) {
  return Math.max(0, Math.min(1, value)).toFixed(4);
}

export async function getOrderbook(args, config = {}) {
  const parsed = OrderbookArgsSchema.parse(args);
  const { clobBaseUrl, fetchImpl } = configWithDefaults(config);
  const raw = await readJson(apiUrl(clobBaseUrl, '/book', { token_id: parsed.yesTokenId }), fetchImpl);
  const book = asRecord(raw);
  const best = bestBidAsk(book);
  if (!best) {
    throw new Error(`Polymarket orderbook has no usable YES bid/ask for token ${parsed.yesTokenId}`);
  }
  const midpoint = (best.bid + best.ask) / 2;
  return {
    venue: 'polymarket',
    marketId: parsed.marketId,
    conditionId: parsed.conditionId,
    sampledAt: timestampToIso(book.timestamp),
    bestBidYes: probability(best.bid),
    bestAskYes: probability(best.ask),
    midpointYes: probability(midpoint),
    spread: probability(best.ask - best.bid),
    source: 'polymarket-clob',
  };
}

function ok(data) {
  return {
    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
  };
}

function toolErr(code, message) {
  return {
    content: [{ type: 'text', text: JSON.stringify({ error: true, code, message }) }],
    isError: true,
  };
}

export function createPolymarketServer(config = {}) {
  const server = new McpServer({ name: 'jinn-prediction-polymarket', version: '0.2.0' });
  const registerTool = server.tool.bind(server);

  registerTool(
    'polymarket_get_market',
    listToolDeclarations()[0].description,
    MarketArgsShape,
    async (args) => {
      try {
        return ok(await getMarket(args, config));
      } catch (err) {
        return toolErr('POLYMARKET_MARKET_READ_FAILED', err instanceof Error ? err.message : String(err));
      }
    },
  );

  registerTool(
    'polymarket_get_orderbook',
    listToolDeclarations()[1].description,
    OrderbookArgsShape,
    async (args) => {
      try {
        return ok(await getOrderbook(args, config));
      } catch (err) {
        return toolErr('POLYMARKET_ORDERBOOK_READ_FAILED', err instanceof Error ? err.message : String(err));
      }
    },
  );

  return server;
}

export async function startMcpServer(config = {}) {
  const server = createPolymarketServer(config);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  await new Promise((resolve) => {
    process.stdin.on('close', resolve);
    process.stdin.on('end', resolve);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startMcpServer().catch((err) => {
    console.error(err instanceof Error ? err.stack ?? err.message : String(err));
    process.exit(1);
  });
}
