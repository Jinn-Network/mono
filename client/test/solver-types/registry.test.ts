import { describe, expect, it, vi } from 'vitest';
import {
  SOLVER_TYPES,
  knownSolverTypes,
  unknownSolverTypeMessage,
  PREDICTION_V0_KIND,
  collectTestnetAutoTaskGenerators,
} from '../../src/solver-types/index.js';

describe('SOLVER_TYPES manifest', () => {
  it('knownSolverTypes returns stable insertion order', () => {
    expect(knownSolverTypes()).toEqual([
      'portfolio.v0',
      'prediction.v0',
      'prediction.apy.v0',
      'learner-loop-test',
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

  it('prediction.v0 parseSpec works without readCurrent when threshold is not a current[±…] sentinel', async () => {
    const raw = {
      id: 'p-1',
      description: 'x',
      window: { startTs: 1, endTs: 120_000 },
      spec: {
        kind: PREDICTION_V0_KIND,
        oracle: {
          venue: 'chainlink-base-sepolia',
          feed: '0x4aDC67696bA383F43DD60A9e78F2C97Fbbfc7cb1',
          feedDescription: 'ETH / USD',
        },
        question: { kind: 'threshold', operator: 'GT', threshold: '1', resolveTs: 200_000 },
      },
      eligibility: {},
    };
    const out = await SOLVER_TYPES['prediction.v0']!.parseSpec(raw);
    expect(out.spec).not.toHaveProperty('kind');
  });

  it('prediction.v0 parseSpec requires readCurrent for current[±…] threshold sentinel', async () => {
    const raw = {
      id: 'p-1',
      description: 'x',
      window: { startTs: 1, endTs: 120_000 },
      spec: {
        kind: PREDICTION_V0_KIND,
        oracle: {
          venue: 'chainlink-base-sepolia',
          feed: '0x4aDC67696bA383F43DD60A9e78F2C97Fbbfc7cb1',
          feedDescription: 'ETH / USD',
        },
        question: { kind: 'threshold', operator: 'GT', threshold: 'current+0.5%', resolveTs: 200_000 },
      },
      eligibility: {},
    };
    await expect(SOLVER_TYPES['prediction.v0']!.parseSpec(raw)).rejects.toThrow(/readCurrent/);
  });

  it('prediction.v0 parseSpec resolves with readCurrent', async () => {
    const raw = {
      id: 'p-1',
      description: 'x',
      window: { startTs: 1, endTs: 120_000 },
      spec: {
        kind: PREDICTION_V0_KIND,
        oracle: {
          venue: 'chainlink-base-sepolia',
          feed: '0x4aDC67696bA383F43DD60A9e78F2C97Fbbfc7cb1',
          feedDescription: 'ETH / USD',
        },
        question: { kind: 'threshold', operator: 'GT', threshold: '1', resolveTs: 200_000 },
      },
      eligibility: {},
    };
    const out = await SOLVER_TYPES['prediction.v0']!.parseSpec(raw, {
      readCurrent: vi.fn(async () => '999'),
    });
    expect(out.spec).not.toHaveProperty('kind');
  });

  it('collectTestnetAutoTaskGenerators registers kinds via getTestnetAutoConfig', () => {
    const { generators, logLines } = collectTestnetAutoTaskGenerators({
      network: 'testnet',
      rpcUrl: 'https://sepolia.base.org',
      autoTasksDisabled: false,
      env: { ...process.env, JINN_ENABLE_APY_AUTO_TASKS: '1' },
    });
    expect(generators.length).toBe(2);
    expect(generators.map((g) => g.solverType)).toEqual(['prediction.v0', 'prediction.apy.v0']);
    expect(logLines.some((l) => l.includes('prediction.v0'))).toBe(true);
    expect(logLines.some((l) => l.includes('prediction.apy.v0'))).toBe(true);
  });
});
