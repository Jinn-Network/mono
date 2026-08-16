import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SOLVER_TYPES,
  knownSolverTypes,
  unknownSolverTypeMessage,
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
      'jinn-repo.v1',
      'session-derived.v1',
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

  // Tests for the legacy `collectTestnetAutoTaskGenerators` helper were
  // dropped by Task 22 of spec/2026-05-05-solvernet-creation-and-launch.md
  // (registry-only catalog; generators are now constructed from owned
  // launched records in `operator/src/solvernets/daemon-init.ts`). End-to-end
  // coverage for the launched-record generator lives in
  // `prediction-v1-auto-launched-gate.test.ts`.
});
