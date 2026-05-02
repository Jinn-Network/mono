#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const GAMMA_BASE_URL = process.env.POLYMARKET_GAMMA_BASE_URL ?? 'https://gamma-api.polymarket.com';
const CLOB_BASE_URL = process.env.POLYMARKET_CLOB_BASE_URL ?? 'https://clob.polymarket.com';

function ok(data) {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

function fail(code, message) {
  return { content: [{ type: 'text', text: JSON.stringify({ error: true, code, message }) }] };
}

function asRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
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

function firstString(record, keys) {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return undefined;
}

async function readJson(url) {
  const response = await fetch(url, { method: 'GET' });
  if (!response.ok) throw new Error(`Polymarket request failed ${response.status}: ${url}`);
  return response.json();
}

function gammaUrl(path, params = {}) {
  const url = new URL(path, GAMMA_BASE_URL);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  return url.toString();
}

function clobUrl(path, params = {}) {
  const url = new URL(path, CLOB_BASE_URL);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  return url.toString();
}

function normalizeMarket(raw) {
  const record = asRecord(raw);
  const outcomes = parseStringArray(record.outcomes);
  const tokenIds = parseStringArray(record.clobTokenIds ?? record.clob_token_ids ?? record.tokenIds);
  const yesIndex = outcomes.findIndex((outcome) => outcome.toUpperCase() === 'YES');
  const noIndex = outcomes.findIndex((outcome) => outcome.toUpperCase() === 'NO');
  return {
    venue: 'polymarket',
    marketId: firstString(record, ['id', 'marketId', 'market_id']) ?? '',
    conditionId: firstString(record, ['conditionId', 'condition_id']) ?? '',
    slug: firstString(record, ['slug', 'marketSlug', 'eventSlug']) ?? '',
    url: firstString(record, ['url']) ?? `https://polymarket.com/event/${firstString(record, ['slug']) ?? ''}`,
    question: firstString(record, ['question', 'title']) ?? '',
    description: firstString(record, ['description']),
    rulesText: firstString(record, ['rules', 'resolutionRules', 'resolution_rules', 'description']) ?? '',
    endTime: firstString(record, ['endDateIso', 'endDate', 'end_time', 'endTime']) ?? '',
    active: record.active !== false,
    closed: record.closed === true,
    archived: record.archived === true,
    outcomes,
    tokenIds: {
      yes: yesIndex >= 0 ? tokenIds[yesIndex] : undefined,
      no: noIndex >= 0 ? tokenIds[noIndex] : undefined,
    },
    liquidityUsd: String(record.liquidity ?? record.liquidityNum ?? record.liquidity_usd ?? '0'),
    volume24hUsd: String(record.volume24hr ?? record.volume24h ?? record.volume24hUsd ?? record.volume_24h ?? '0'),
  };
}

async function getMarket({ marketId, slug }) {
  if (marketId) return normalizeMarket(await readJson(gammaUrl(`/markets/${encodeURIComponent(marketId)}`)));
  if (slug) return normalizeMarket(await readJson(gammaUrl(`/markets/slug/${encodeURIComponent(slug)}`)));
  throw new Error('marketId or slug is required');
}

function probability(value) {
  return Math.max(0, Math.min(1, value)).toFixed(4);
}

async function getOrderbook({ marketId, conditionId, yesTokenId }) {
  const raw = asRecord(await readJson(clobUrl('/book', { token_id: yesTokenId })));
  const bids = Array.isArray(raw.bids) ? raw.bids : [];
  const asks = Array.isArray(raw.asks) ? raw.asks : [];
  const bid = Math.max(...bids.map((row) => Number(asRecord(row).price)).filter(Number.isFinite));
  const ask = Math.min(...asks.map((row) => Number(asRecord(row).price)).filter(Number.isFinite));
  if (!Number.isFinite(bid) || !Number.isFinite(ask)) {
    throw new Error('orderbook has no usable YES bid/ask');
  }
  return {
    venue: 'polymarket',
    marketId,
    conditionId,
    sampledAt: new Date().toISOString(),
    bestBidYes: probability(bid),
    bestAskYes: probability(ask),
    midpointYes: probability((bid + ask) / 2),
    spread: probability(ask - bid),
    source: 'polymarket-clob',
    rawHash: raw.hash,
  };
}

const server = new McpServer({ name: 'jinn-polymarket', version: '0.2.0' });
const registerTool = server.tool.bind(server);

registerTool(
  'polymarket_get_market',
  'Read the Polymarket market already named by the Task. Requires marketId or slug. Read-only.',
  {
    marketId: z.string().optional(),
    slug: z.string().optional(),
  },
  async (args) => {
    try {
      return ok(await getMarket(args));
    } catch (err) {
      return fail('POLYMARKET_MARKET_READ_FAILED', err instanceof Error ? err.message : String(err));
    }
  },
);

registerTool(
  'polymarket_get_orderbook',
  'Read the YES-token Polymarket orderbook already named by the Task. Read-only.',
  {
    marketId: z.string(),
    conditionId: z.string(),
    yesTokenId: z.string(),
  },
  async (args) => {
    try {
      return ok(await getOrderbook(args));
    } catch (err) {
      return fail('POLYMARKET_ORDERBOOK_READ_FAILED', err instanceof Error ? err.message : String(err));
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
await new Promise((resolve) => {
  process.stdin.on('close', resolve);
  process.stdin.on('end', resolve);
});
