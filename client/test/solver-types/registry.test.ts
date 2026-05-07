import { afterEach, describe, expect, it, vi } from 'vitest';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { LocalAdapter } from '../../src/adapters/local/adapter.js';
import { TaskPostingService } from '../../src/tasks/posting-service.js';
import { GeneratedTaskSource } from '../../src/tasks/sources.js';
import { PredictionV1TaskSchema } from '../../src/types/prediction-v1.js';
import {
  SOLVER_TYPES,
  knownSolverTypes,
  unknownSolverTypeMessage,
  collectTestnetAutoTaskGenerators,
} from '../../src/solver-types/index.js';

const NOW = Date.parse('2026-05-02T00:00:00.000Z');

function polymarketTask(overrides: Record<string, unknown> = {}) {
  return {
    id: 'prediction-v1-polymarket-abc',
    description: 'Forecast a binary externally resolved prediction market.',
    solverType: 'prediction.v1',
    role: 'restoration',
    window: {
      startTs: NOW,
      endTs: NOW + 6 * 60 * 60 * 1000,
    },
    claimPolicy: {
      mode: 'parallel',
      maxClaims: 25,
      maxClaimsPerOperator: 1,
      claimLeaseTtlSeconds: 30 * 60,
    },
    spec: {
      question: { kind: 'binary', text: 'Will test pass?', yesLabel: 'YES', noLabel: 'NO' },
      source: {
        type: 'prediction-market',
        venue: 'polymarket',
        url: 'https://polymarket.com/event/test-market',
        identifiers: {
          marketId: 'mkt-1',
          conditionId: '0xabc',
          yesTokenId: 'yes-token',
          noTokenId: 'no-token',
        },
      },
      resolution: {
        expectedResolutionTime: '2026-05-04T00:00:00.000Z',
        rulesText: 'Resolve according to UMA final market resolution.',
        rulesUrl: 'https://polymarket.com/event/test-market',
        timezone: 'UTC',
      },
      consensusSnapshot: {
        sampledAt: '2026-05-02T00:00:00.000Z',
        probabilityYes: '0.6200',
        method: 'best-bid-ask-midpoint',
        bestBidYes: '0.6000',
        bestAskYes: '0.6400',
        spread: '0.0400',
        source: 'polymarket-clob',
      },
      eligibilitySnapshot: {
        sampledAt: '2026-05-02T00:00:00.000Z',
        timeToResolutionHours: 48,
        liquidityUsd: '12000',
        volume24hUsd: '2600',
        orderbookAgeSeconds: 1,
        selectionReason: 'weekly-binary-liquid-clear-rules',
      },
    },
    eligibility: {
      dedupKey: 'polymarket:0xabc',
    },
    ...overrides,
  };
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

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
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

describe('SOLVER_TYPES manifest', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('knownSolverTypes returns stable insertion order', () => {
    expect(knownSolverTypes()).toEqual([
      'portfolio.v0',
      'prediction.v1',
      'prediction.apy.v0',
      'learner-loop-test',
      'swe-rebench-v2.v1',
    ]);
  });

  it('unknownSolverTypeMessage lists known SolverTypes', () => {
    expect(unknownSolverTypeMessage('demo.v0')).toMatch(/unknown SolverType: demo\.v0/);
    expect(unknownSolverTypeMessage('demo.v0')).toMatch(/portfolio\.v0/);
    expect(unknownSolverTypeMessage(undefined)).toMatch(/missing/);
  });

  it('parses prediction.apy.v0 round-trip from fixture shape', async () => {
    const raw = {
      id: 'apy-1',
      description: 'test',
      window: { startTs: 1_700_000_000_000, endTs: 1_700_000_600_000 },
      spec: {
        kind: 'prediction.apy.v0',
        oracle: {
          venue: 'aave-v3-base-sepolia',
          pool: '0x6Ae43d3271ff6888e7Fc43Fd7321a503ff738951',
          reserve: '0x31d3A7711a10C45D72649D51E1c8D74282702572',
          reserveSymbol: 'USDC',
        },
        metric: {
          type: 'supply-apy-twa-bps',
          twaWindowSeconds: 3600,
          sampleCount: 12,
          toleranceBps: 50,
        },
        question: { resolveTs: 1_700_000_900_000 },
      },
      eligibility: { maxSubmissionDelayMs: 60_000 },
    };
    const out = await SOLVER_TYPES['prediction.apy.v0']!.parseSpec(raw);
    expect(out.spec).not.toHaveProperty('kind');
    expect(out.window).toEqual(raw.window);
  });

  it('parses portfolio.v0 with 24h window', async () => {
    const start = 1_700_000_000_000;
    const raw = {
      id: 'pf-1',
      description: 'portfolio test',
      window: { startTs: start, endTs: start + 86_400_000 },
      spec: {
        kind: 'portfolio.v0',
        account: {
          venue: 'hyperliquid-testnet',
          masterAddress: '0x1234567890123456789012345678901234567890',
        },
        target: { metric: 'equity_return_pct', minReturnPct: 1 },
        constraint: { maxDrawdownPct: 10 },
      },
      eligibility: {},
    };
    const out = await SOLVER_TYPES['portfolio.v0']!.parseSpec(raw);
    expect(out.spec).not.toHaveProperty('kind');
  });

  it('prediction.v1 parseSpec accepts canonical Polymarket tasks', async () => {
    const raw = polymarketTask();
    const out = await SOLVER_TYPES['prediction.v1']!.parseSpec(raw);
    expect(out.window).toEqual((raw as any).window);
    expect(out.claimPolicy).toMatchObject({ mode: 'parallel', maxClaims: 25 });
    expect(out.spec).toMatchObject({
      source: {
        venue: 'polymarket',
        identifiers: { conditionId: '0xabc' },
      },
    });
  });

  it('prediction.v1 parseSpec rejects legacy Chainlink threshold templates', async () => {
    const raw = {
      id: 'p-1',
      description: 'x',
      window: { startTs: 1, endTs: 120_000 },
      spec: {
        kind: 'prediction.v1',
        oracle: {
          venue: 'chainlink-base-sepolia',
          feed: '0x4aDC67696bA383F43DD60A9e78F2C97Fbbfc7cb1',
          feedDescription: 'ETH / USD',
        },
        question: { kind: 'threshold', operator: 'GT', threshold: '1', resolveTs: 200_000 },
      },
      eligibility: {},
    };
    await expect(SOLVER_TYPES['prediction.v1']!.parseSpec(raw)).rejects.toThrow();
  });

  it('collectTestnetAutoTaskGenerators leaves Polymarket disabled for ordinary operators', () => {
    const { generators, logLines } = collectTestnetAutoTaskGenerators({
      network: 'testnet',
      rpcUrl: 'https://sepolia.base.org',
      autoTasksDisabled: false,
      env: {},
    });
    expect(generators.map((g) => g.solverType)).not.toContain('prediction.v1');
    expect(logLines.some((l) => l.includes('prediction.v1'))).toBe(false);
  });

  it('collectTestnetAutoTaskGenerators keeps disable-all ahead of launcher opt-in', () => {
    const { generators, logLines } = collectTestnetAutoTaskGenerators({
      network: 'testnet',
      rpcUrl: 'https://sepolia.base.org',
      autoTasksDisabled: true,
      env: { JINN_ENABLE_APY_AUTO_TASKS: '1' },
      predictionV1LauncherEnabled: true,
    });
    expect(generators).toEqual([]);
    expect(logLines).toEqual([]);
  });

  it('collectTestnetAutoTaskGenerators registers kinds via getTestnetAutoConfig', () => {
    const { generators, logLines } = collectTestnetAutoTaskGenerators({
      network: 'testnet',
      rpcUrl: 'https://sepolia.base.org',
      autoTasksDisabled: false,
      env: { JINN_ENABLE_APY_AUTO_TASKS: '1' },
      predictionV1LauncherEnabled: true,
    });
    expect(generators.length).toBe(2);
    expect(generators.map((g) => g.solverType)).toEqual(['prediction.v1', 'prediction.apy.v0']);
    expect(logLines.some((l) => l.includes('prediction.v1'))).toBe(true);
    expect(logLines.some((l) => l.includes('prediction.apy.v0'))).toBe(true);
  });

  it('launcher-enabled testnet generator emits signed shared Polymarket prediction.v1 tasks', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.stubGlobal('fetch', fetchFixture(
      [market('abc', 'yes-abc')],
      { 'yes-abc': book('0.60', '0.64') },
    ));
    const pk = generatePrivateKey();
    const account = privateKeyToAccount(pk);
    const safeAddress = '0x1111111111111111111111111111111111111111' as `0x${string}`;

    const { generators } = collectTestnetAutoTaskGenerators({
      network: 'testnet',
      rpcUrl: 'https://sepolia.base.org',
      autoTasksDisabled: false,
      env: {
        JINN_PREDICTION_V1_CADENCE_MS: '12345',
        JINN_PREDICTION_V1_MAX_NEW_ROUNDS_PER_POLL: '7',
        JINN_PREDICTION_V1_MAX_NEW_ROUNDS_PER_DAY: '11',
        JINN_PREDICTION_V1_MAX_OPEN_ROUNDS: '13',
        JINN_PREDICTION_V1_ALLOWLIST_CONDITION_IDS: '0xabc',
      },
      agentEoa: account.address as `0x${string}`,
      safeAddress,
      agentPrivateKey: pk,
      predictionV1LauncherEnabled: true,
      predictionV1WindowMs: 60 * 60 * 1000,
    });
    const prediction = generators.find((g) => g.solverType === 'prediction.v1');
    expect(prediction).toBeDefined();

    const source = new GeneratedTaskSource('generated:prediction.v1', prediction!.generator);
    const [candidate] = await source.collect(new Date(NOW));
    const task = PredictionV1TaskSchema.parse(candidate.task);

    expect(candidate.sourceKey).toBe('generated:prediction.v1');
    expect(candidate.postingPolicy.kind).toBe('once_per_bucket');
    expect(task.claimPolicy).toMatchObject({
      mode: 'parallel',
      maxClaims: 25,
      maxClaimsPerOperator: 1,
    });
    expect(task.window.endTs - task.window.startTs).toBe(60 * 60 * 1000);
    expect(task.spec.source).toMatchObject({
      venue: 'polymarket',
      identifiers: { conditionId: '0xabc' },
    });
    expect(task.eligibility).toMatchObject({
      generatorCadenceMs: 12345,
      maxNewRoundsPerPoll: 7,
      maxNewRoundsPerDay: 11,
      maxOpenRounds: 13,
      manualAllowlistHit: true,
    });
    expect(candidate.task.signedTask?.creator.safeAddress).toBe(safeAddress);
    expect(candidate.task.signedTask?.creator.agentEoa.toLowerCase()).toBe(account.address.toLowerCase());

    const adapter = new LocalAdapter();
    await adapter.initialize();
    const records = new Map<string, any>();
    const store = {
      getTaskPostRecord: vi.fn((key: any) => records.get(JSON.stringify(key))),
      acquireTaskPostLock: vi.fn(() => true),
      releaseTaskPostLock: vi.fn(),
      upsertTaskPostRecord: vi.fn((record: any) => {
        records.set(JSON.stringify({
          creatorSafeAddress: record.creatorSafeAddress,
          sourceKey: record.sourceKey,
          policyType: record.policyType,
          scopeKey: record.scopeKey,
        }), record);
      }),
      recordOwnActivity: vi.fn(),
      recordActivityEvent: vi.fn(),
    };
    try {
      const posting = new TaskPostingService(adapter, store as any);
      const posted = await posting.postCandidate(candidate, { creatorSafeAddress: safeAddress });
      expect(posted.idempotent).toBe(false);
      expect(posted.taskId).toBeTruthy();
      expect(posted.task.solverType).toBe('prediction.v1');
      expect(posted.task.signedTask?.creator.safeAddress).toBe(safeAddress);
      expect(store.upsertTaskPostRecord).toHaveBeenCalledWith(expect.objectContaining({
        creatorSafeAddress: safeAddress,
        sourceKey: 'generated:prediction.v1',
        taskId: candidate.task.id,
      }));
    } finally {
      await adapter.stop();
    }
  });

  it('passes launcher generator knobs from config fields, not only env', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.stubGlobal('fetch', fetchFixture(
      [market('cfg', 'yes-cfg')],
      { 'yes-cfg': book('0.58', '0.62') },
    ));

    const { generators } = collectTestnetAutoTaskGenerators({
      network: 'testnet',
      rpcUrl: 'https://sepolia.base.org',
      autoTasksDisabled: false,
      env: {},
      predictionV1LauncherEnabled: true,
      predictionV1WindowMs: 30 * 60 * 1000,
      predictionV1CadenceMs: 67890,
      predictionV1MaxNewRoundsPerPoll: 3,
      predictionV1MaxNewRoundsPerDay: 5,
      predictionV1MaxOpenRounds: 8,
      predictionV1AllowlistConditionIds: ['0xcfg'],
      predictionV1BlocklistConditionIds: ['0xother'],
    });
    const prediction = generators.find((g) => g.solverType === 'prediction.v1');
    expect(prediction).toBeDefined();

    const source = new GeneratedTaskSource('generated:prediction.v1', prediction!.generator);
    const [candidate] = await source.collect(new Date(NOW));
    const task = PredictionV1TaskSchema.parse(candidate.task);

    expect(task.window.endTs - task.window.startTs).toBe(30 * 60 * 1000);
    expect(task.spec.source.identifiers.conditionId).toBe('0xcfg');
    expect(task.eligibility).toMatchObject({
      generatorCadenceMs: 67890,
      maxNewRoundsPerPoll: 3,
      maxNewRoundsPerDay: 5,
      maxOpenRounds: 8,
      manualAllowlistHit: true,
    });
  });
});
