import { afterEach, describe, expect, it, vi } from 'vitest';
import { makePredictionV1Generator } from '../../src/solver-types/prediction-v1-auto.js';
import { PredictionV1TaskSchema } from '../../src/types/prediction-v1.js';

const NOW = Date.parse('2026-05-02T00:00:00.000Z');

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function market(id: string, token: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    conditionId: `0x${id}`,
    slug: `${id}-slug`,
    question: `Will ${id} resolve yes?`,
    description: `Resolution rules for ${id}.`,
    outcomes: '["Yes","No"]',
    clobTokenIds: `["${token}","${token}-no"]`,
    endDateIso: new Date(NOW + 48 * 3_600_000).toISOString(),
    active: true,
    closed: false,
    archived: false,
    liquidity: '12000',
    volume24hr: '2600',
    ...overrides,
  };
}

function book(bid: string, ask: string, timestamp = NOW) {
  return {
    timestamp,
    bids: [{ price: bid, size: '10' }],
    asks: [{ price: ask, size: '10' }],
  };
}

function fetchFixture(markets: unknown[], books: Record<string, unknown>) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname === '/markets') return jsonResponse(markets);
    if (url.pathname === '/book') {
      const token = url.searchParams.get('token_id') ?? '';
      return jsonResponse(books[token] ?? { bids: [], asks: [] });
    }
    throw new Error(`unexpected Polymarket endpoint: ${url.toString()}`);
  }) as unknown as typeof fetch;
}

describe('prediction.v1 auto-generator', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('turns eligible Polymarket markets into parallel Task-first rounds', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const fetchImpl = fetchFixture(
      [
        market('abc', 'yes-abc'),
        market('wide', 'yes-wide'),
        market('stale', 'yes-stale'),
      ],
      {
        'yes-abc': book('0.60', '0.64'),
        'yes-wide': book('0.40', '0.60'),
        'yes-stale': book('0.50', '0.54', NOW - 120_000),
      },
    );

    const generator = makePredictionV1Generator({ fetchImpl, maxNewRoundsPerPoll: 25 });
    const tasks = await generator();

    expect(tasks).toHaveLength(1);
    const task = PredictionV1TaskSchema.parse(tasks![0]);
    expect(task.solverType).toBe('prediction.v1');
    expect(task.claimPolicy).toMatchObject({
      kind: 'parallel',
      maxClaims: 25,
      maxClaimsPerSolver: 1,
    });
    expect(task.spec.source.identifiers).toMatchObject({
      marketId: 'abc',
      conditionId: '0xabc',
      yesTokenId: 'yes-abc',
      noTokenId: 'yes-abc-no',
    });
    expect(task.spec.consensusSnapshot).toMatchObject({
      probabilityYes: '0.6200',
      bestBidYes: '0.6000',
      bestAskYes: '0.6400',
      spread: '0.0400',
    });
    expect(task.spec.eligibilitySnapshot).toMatchObject({
      liquidityUsd: '12000',
      volume24hUsd: '2600',
      orderbookAgeSeconds: 0,
    });
    expect(task.eligibility.dedupKey).toBe('polymarket:0xabc');
  });

  it('enforces per-poll caps and in-generator conditionId dedup', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const fetchImpl = fetchFixture(
      [
        market('abc', 'yes-abc'),
        market('def', 'yes-def'),
      ],
      {
        'yes-abc': book('0.60', '0.64'),
        'yes-def': book('0.51', '0.55'),
      },
    );

    const generator = makePredictionV1Generator({ fetchImpl, maxNewRoundsPerPoll: 1 });
    const first = await generator();
    const second = await generator();

    expect(first).toHaveLength(1);
    expect(first![0].spec?.source).toMatchObject({ identifiers: { conditionId: '0xabc' } });
    expect(second).toHaveLength(1);
    expect(second![0].spec?.source).toMatchObject({ identifiers: { conditionId: '0xdef' } });
  });

  it('does not call authenticated or trading endpoints', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const fetchImpl = fetchFixture(
      [market('abc', 'yes-abc')],
      { 'yes-abc': book('0.60', '0.64') },
    );

    const generator = makePredictionV1Generator({ fetchImpl });
    await generator();

    const calls = (fetchImpl as any).mock.calls.map((call: unknown[]) => String(call[0]));
    expect(calls.every((url: string) => url.includes('/markets') || url.includes('/book'))).toBe(true);
    expect(calls.some((url: string) => /order|trade|auth|wallet|sign/i.test(url))).toBe(false);
  });
});
