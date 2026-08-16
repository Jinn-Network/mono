import { describe, expect, it, vi } from 'vitest';
import {
  getMarket,
  getOrderbook,
  getResolution,
  listMarketCandidates,
  normalizeMarketCandidate,
} from '../../../src/venues/polymarket/client.js';

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function market(overrides: Record<string, unknown> = {}) {
  return {
    id: 'mkt-1',
    conditionId: '0xabc',
    slug: 'test-market',
    question: 'Will test pass?',
    description: 'Resolve according to test fixture rules.',
    outcomes: '["Yes","No"]',
    clobTokenIds: '["yes-token","no-token"]',
    endDateIso: '2026-05-04T00:00:00.000Z',
    active: true,
    closed: false,
    archived: false,
    liquidity: '12000',
    volume24hr: '2600',
    ...overrides,
  };
}

describe('Polymarket public data client', () => {
  it('normalizes eligible Gamma binary markets', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse([
      market(),
      market({ id: 'bad', conditionId: '0xbad', outcomes: '["A","B"]' }),
    ])) as unknown as typeof fetch;

    const candidates = await listMarketCandidates({ fetchImpl });

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      venue: 'polymarket',
      marketId: 'mkt-1',
      conditionId: '0xabc',
      tokenIds: { yes: 'yes-token', no: 'no-token' },
      liquidityUsd: '12000',
      volume24hUsd: '2600',
    });
    expect(String((fetchImpl as any).mock.calls[0][0])).toContain('/markets?active=true');
  });

  it('reads one market by id through Gamma', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(market())) as unknown as typeof fetch;

    const got = await getMarket({ marketId: 'mkt-1', fetchImpl });

    expect(got.marketId).toBe('mkt-1');
    expect(String((fetchImpl as any).mock.calls[0][0])).toContain('/markets/mkt-1');
  });

  it('computes YES midpoint from public CLOB /book', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      timestamp: Date.parse('2026-05-02T00:00:00.000Z'),
      bids: [{ price: '0.39', size: '10' }, { price: '0.41', size: '5' }],
      asks: [{ price: '0.46', size: '10' }, { price: '0.45', size: '5' }],
    })) as unknown as typeof fetch;

    const book = await getOrderbook({
      marketId: 'mkt-1',
      conditionId: '0xabc',
      yesTokenId: 'yes-token',
      fetchImpl,
    });

    expect(book).toMatchObject({
      sampledAt: '2026-05-02T00:00:00.000Z',
      bestBidYes: '0.4100',
      bestAskYes: '0.4500',
      midpointYes: '0.4300',
      spread: '0.0400',
    });
    expect(String((fetchImpl as any).mock.calls[0][0])).toContain('/book?token_id=yes-token');
    expect((fetchImpl as any).mock.calls[0][1]).toMatchObject({ method: 'GET' });
  });

  it('rejects missing orderbooks', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ bids: [], asks: [] })) as unknown as typeof fetch;

    await expect(getOrderbook({
      marketId: 'mkt-1',
      conditionId: '0xabc',
      yesTokenId: 'yes-token',
      fetchImpl,
    })).rejects.toThrow(/no usable YES bid\/ask/);
  });

  it('maps final Polymarket outcome prices to YES/NO resolution states', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(market({
      closed: true,
      outcomes: '["Yes","No"]',
      outcomePrices: '["1","0"]',
      updatedAt: '2026-05-04T00:00:00.000Z',
    }))) as unknown as typeof fetch;

    const resolution = await getResolution({ marketId: 'mkt-1', fetchImpl });

    expect(resolution).toMatchObject({
      status: 'resolved',
      outcome: 'YES',
      conditionId: '0xabc',
      resolvedAt: '2026-05-04T00:00:00.000Z',
    });
  });

  it('maps invalid/cancelled/unresolved final states without scoring them', async () => {
    expect(normalizeMarketCandidate(market())).not.toBeNull();

    const invalidFetch = vi.fn(async () => jsonResponse(market({
      closed: true,
      resolutionStatus: 'invalid',
    }))) as unknown as typeof fetch;
    await expect(getResolution({ marketId: 'mkt-1', fetchImpl: invalidFetch }))
      .resolves.toMatchObject({ status: 'invalid' });

    const cancelledFetch = vi.fn(async () => jsonResponse(market({
      closed: true,
      resolutionStatus: 'cancelled',
    }))) as unknown as typeof fetch;
    await expect(getResolution({ marketId: 'mkt-1', fetchImpl: cancelledFetch }))
      .resolves.toMatchObject({ status: 'cancelled' });

    const unresolvedFetch = vi.fn(async () => jsonResponse(market())) as unknown as typeof fetch;
    await expect(getResolution({ marketId: 'mkt-1', fetchImpl: unresolvedFetch }))
      .resolves.toMatchObject({ status: 'unresolved' });
  });

  it('propagates resolution read failures instead of emitting unresolved verdict state', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: 'temporary outage' }, 500)) as unknown as typeof fetch;

    await expect(getResolution({ marketId: 'mkt-1', fetchImpl }))
      .rejects.toThrow(/Polymarket request failed 500/);
  });
});
