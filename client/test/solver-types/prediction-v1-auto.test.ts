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
  const marketById = new Map(
    markets.map((row) => [String((row as Record<string, unknown>)['id'] ?? ''), row]),
  );
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname === '/markets') return jsonResponse(markets);
    if (url.pathname.startsWith('/markets/')) {
      const id = decodeURIComponent(url.pathname.slice('/markets/'.length));
      return jsonResponse(marketById.get(id) ?? {});
    }
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

    const generator = makePredictionV1Generator({ fetchImpl, cadenceMs: 0, maxNewRoundsPerPoll: 25 });
    const tasks = await generator();

    expect(tasks).toHaveLength(1);
    const task = PredictionV1TaskSchema.parse(tasks![0]);
    expect(task.solverType).toBe('prediction.v1');
    expect(task.claimPolicy).toMatchObject({
      mode: 'parallel',
      maxClaims: 25,
      maxClaimsPerOperator: 1,
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

    const generator = makePredictionV1Generator({ fetchImpl, cadenceMs: 0, maxNewRoundsPerPoll: 1 });
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

    const generator = makePredictionV1Generator({ fetchImpl, cadenceMs: 0 });
    await generator();

    const calls = (fetchImpl as any).mock.calls.map((call: unknown[]) => String(call[0]));
    expect(calls.every((url: string) => url.includes('/markets') || url.includes('/book'))).toBe(true);
    expect(calls.some((url: string) => /order|trade|auth|wallet|sign/i.test(url))).toBe(false);
  });

  it('honors generator cadence independently from daemon poll frequency', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const fetchImpl = fetchFixture(
      [market('abc', 'yes-abc')],
      { 'yes-abc': book('0.60', '0.64') },
    );

    const generator = makePredictionV1Generator({ fetchImpl, cadenceMs: 6 * 60 * 60 * 1000 });
    const first = await generator();
    const second = await generator();

    expect(first).toHaveLength(1);
    expect(second).toBeNull();
    expect((fetchImpl as any).mock.calls).toHaveLength(3);

    vi.setSystemTime(NOW + 6 * 60 * 60 * 1000 + 1);
    await generator();

    expect((fetchImpl as any).mock.calls.filter((call: unknown[]) => String(call[0]).includes('/markets'))).toHaveLength(3);
  });

  it('prioritizes valid allowlisted markets when per-poll caps bind', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const fetchImpl = fetchFixture(
      [
        market('liquid', 'yes-liquid', { liquidity: '90000' }),
        market('manual', 'yes-manual', { liquidity: '12000' }),
      ],
      {
        'yes-liquid': book('0.60', '0.64'),
        'yes-manual': book('0.51', '0.55'),
      },
    );

    const generator = makePredictionV1Generator({
      fetchImpl,
      cadenceMs: 0,
      maxNewRoundsPerPoll: 1,
      allowlistConditionIds: ['0xmanual'],
    });
    const tasks = await generator();

    expect(tasks).toHaveLength(1);
    expect(tasks![0].spec?.source).toMatchObject({ identifiers: { conditionId: '0xmanual' } });
    expect(tasks![0].eligibility).toMatchObject({ manualAllowlistHit: true });
  });

  it('keeps blocklist above allowlist and does not let allowlist bypass validation', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const fetchImpl = fetchFixture(
      [
        market('blocked', 'yes-blocked', { liquidity: '99000' }),
        market('ambiguous-schema', 'yes-ambiguous', { outcomes: '["Yes","Maybe"]' }),
        market('too-soon', 'yes-too-soon', { endDateIso: new Date(NOW + 2 * 3_600_000).toISOString() }),
        market('stale', 'yes-stale'),
        market('valid', 'yes-valid'),
      ],
      {
        'yes-blocked': book('0.60', '0.64'),
        'yes-too-soon': book('0.60', '0.64'),
        'yes-stale': book('0.50', '0.54', NOW - 120_000),
        'yes-valid': book('0.51', '0.55'),
      },
    );

    const generator = makePredictionV1Generator({
      fetchImpl,
      cadenceMs: 0,
      maxNewRoundsPerPoll: 1,
      allowlistConditionIds: ['0xblocked', '0xambiguous-schema', '0xtoo-soon', '0xstale'],
      blocklistConditionIds: ['0xblocked'],
    });
    const tasks = await generator();

    expect(tasks).toHaveLength(1);
    expect(tasks![0].spec?.source).toMatchObject({ identifiers: { conditionId: '0xvalid' } });
    const calledUrls = (fetchImpl as any).mock.calls.map((call: unknown[]) => String(call[0]));
    expect(calledUrls.some((url: string) => url.includes('yes-blocked'))).toBe(false);
    expect(calledUrls.some((url: string) => url.includes('yes-too-soon'))).toBe(false);
    expect(calledUrls.some((url: string) => url.includes('yes-stale'))).toBe(true);
  });

  it('skips invalid, cancelled, and ambiguous Polymarket statuses', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const fetchImpl = fetchFixture(
      [
        market('invalid', 'yes-invalid', { resolutionStatus: 'invalid' }),
        market('cancelled', 'yes-cancelled', { resolutionStatus: 'cancelled' }),
        market('ambiguous', 'yes-ambiguous', { closed: true }),
        market('valid', 'yes-valid'),
      ],
      {
        'yes-invalid': book('0.60', '0.64'),
        'yes-cancelled': book('0.60', '0.64'),
        'yes-ambiguous': book('0.60', '0.64'),
        'yes-valid': book('0.51', '0.55'),
      },
    );

    const generator = makePredictionV1Generator({ fetchImpl, cadenceMs: 0 });
    const tasks = await generator();

    expect(tasks).toHaveLength(1);
    expect(tasks![0].spec?.source).toMatchObject({ identifiers: { conditionId: '0xvalid' } });
    const calledUrls = (fetchImpl as any).mock.calls.map((call: unknown[]) => String(call[0]));
    expect(calledUrls.some((url: string) => url.includes('yes-invalid'))).toBe(false);
    expect(calledUrls.some((url: string) => url.includes('yes-cancelled'))).toBe(false);
    expect(calledUrls.some((url: string) => url.includes('yes-ambiguous'))).toBe(false);
  });
});
