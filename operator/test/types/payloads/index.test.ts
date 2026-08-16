import { describe, it, expect } from 'vitest';
import { SOLVER_TYPE_PAYLOADS, validatePayload } from '../../../src/types/payloads/index.js';

describe('SOLVER_TYPE_PAYLOADS registry', () => {
  it('has all four solver types', () => {
    expect(SOLVER_TYPE_PAYLOADS['portfolio.v0']).toBeDefined();
    expect(SOLVER_TYPE_PAYLOADS['prediction.v1']).toBeDefined();
    expect(SOLVER_TYPE_PAYLOADS['prediction.apy.v0']).toBeDefined();
    expect(SOLVER_TYPE_PAYLOADS['swe-rebench-v2.v1']).toBeDefined();
  });

  it('each solver type has solution + verdict schemas', () => {
    for (const solverType of [
      'portfolio.v0',
      'prediction.v1',
      'prediction.apy.v0',
      'swe-rebench-v2.v1',
    ]) {
      expect(SOLVER_TYPE_PAYLOADS[solverType].solution).toBeDefined();
      expect(SOLVER_TYPE_PAYLOADS[solverType].verdict).toBeDefined();
    }
  });
});

describe('validatePayload — swe-rebench-v2.v1', () => {
  const validSolution = {
    schemaVersion: 'swe-rebench-v2-solution.v1',
    patch: '--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n',
  };
  const validVerdict = {
    schemaVersion: 'swe-rebench-v2-verdict.v1',
    score: 1,
    passed_match: true,
    evaluator_cost_usd: 0.01,
  };

  it('accepts a valid Solution payload (solution role)', () => {
    expect(() =>
      validatePayload('swe-rebench-v2.v1', 'solution', validSolution),
    ).not.toThrow();
  });

  it('accepts a legacy restoration role as a read-compat alias', () => {
    expect(() =>
      validatePayload('swe-rebench-v2.v1', 'restoration', validSolution),
    ).not.toThrow();
  });

  it('accepts a valid Verdict payload (verdict role)', () => {
    expect(() =>
      validatePayload('swe-rebench-v2.v1', 'verdict', validVerdict),
    ).not.toThrow();
  });

  it('rejects a Solution missing the patch field', () => {
    const bad = { ...validSolution, patch: undefined };
    expect(() => validatePayload('swe-rebench-v2.v1', 'solution', bad)).toThrow();
  });

  it('rejects a Verdict with score outside the 0|1 union', () => {
    const bad = { ...validVerdict, score: 0.5 };
    expect(() => validatePayload('swe-rebench-v2.v1', 'verdict', bad)).toThrow();
  });

  it('rejects a Solution with the wrong schemaVersion literal', () => {
    const bad = { ...validSolution, schemaVersion: 'swe-rebench-v2-solution.v0' };
    expect(() => validatePayload('swe-rebench-v2.v1', 'solution', bad)).toThrow();
  });
});

describe('validatePayload', () => {
  const validPortfolioRestoration = {
    preSnapshot: { capturedAt: 1, hlTime: 1, payload: {} },
    postSnapshot: { capturedAt: 2, hlTime: 2, payload: {} },
    fills: [],
    gating: {
      equityReturnPct: '0.05',
      maxDrawdownPct: '0.01',
      closedTradesCount: 25,
      tradedNotionalMultiple: '5.1',
    },
  };

  it('accepts a valid (solverType, role) pair', () => {
    expect(() =>
      validatePayload('portfolio.v0', 'solution', validPortfolioRestoration),
    ).not.toThrow();
  });

  it('throws for unknown solverType', () => {
    expect(() => validatePayload('bogus.v0', 'solution', {})).toThrow(/Unknown solverType/);
  });

  it('throws for unknown role', () => {
    expect(() =>
      // cast to bypass TS; the function's responsibility is runtime guard
      validatePayload('portfolio.v0', 'witness' as unknown as 'solution', {}),
    ).toThrow(/No payload schema/);
  });

  it('throws when payload fails schema validation', () => {
    expect(() =>
      validatePayload('portfolio.v0', 'solution', { bogus: true }),
    ).toThrow();
  });

  it('accepts legacy verdict payload restorationEnvelope and normalizes through the schema', () => {
    const legacyVerdict = {
      restorationEnvelope: { cid: 'bafy-solution', sha256: 'a'.repeat(64) },
      verificationOfRestoration: {
        claimedTier: 'self-signed',
        sdkVersion: '1.0.0',
        timestamp: 1,
        checks: [{ name: 'schema', passed: true }],
        overall: 'valid',
      },
      verdict: 'PASS',
      score: '1.0',
      scoreBasis: 'brier.v1',
      scoreVersion: '1.0.0',
      oracleReading: {
        feed: `0x${'1'.repeat(40)}`,
        roundId: '1',
        answer: '1',
        updatedAt: 1,
      },
      claimed: {
        probability: '0.55',
        submittedAt: 1,
        modelId: 'm',
      },
      groundTruth: 'YES',
      checks: [{ name: 'schema', status: 'PASS' }],
    };

    expect(() => validatePayload('prediction.v0', 'verdict', legacyVerdict)).not.toThrow();
  });

  it('accepts prediction.v1 legacy verdict payload restorationEnvelope as a read alias', () => {
    const legacyVerdict = {
      verdict: 'SCORED',
      outcome: 'YES',
      resolvedAt: '2026-05-04T00:00:00.000Z',
      resolutionSource: {
        venue: 'polymarket',
        url: 'https://polymarket.com/event/test-market',
        marketId: 'mkt-1',
        conditionId: '0xabc',
      },
      task: { cid: 'bafy-task', id: 'prediction-v1-polymarket-abc' },
      restorationEnvelope: { cid: 'bafy-solution', sha256: 'a'.repeat(64) },
      claimed: {
        probabilityYes: '0.5700',
        submittedAt: '2026-05-02T01:00:00.000Z',
        modelId: 'prediction-v1-baseline/consensus',
      },
      benchmark: {
        probabilityYes: '0.6200',
        sampledAt: '2026-05-02T00:00:00.000Z',
        method: 'best-bid-ask-midpoint',
      },
      scores: {
        scoreBasis: 'brier-loss.v1',
        solverBrier: '0.184900',
        consensusBrier: '0.144400',
        brierSpread: '0.040500',
      },
      checks: [{ name: 'solution.schema', status: 'PASS' }],
    };

    expect(() => validatePayload('prediction.v1', 'verdict', legacyVerdict)).not.toThrow();
  });
});
