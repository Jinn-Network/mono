import { describe, it, expect } from 'vitest';
import { SOLVER_TYPE_PAYLOADS, validatePayload } from '../../../src/types/payloads/index.js';

describe('SOLVER_TYPE_PAYLOADS registry', () => {
  it('has all four solver types', () => {
    expect(SOLVER_TYPE_PAYLOADS['portfolio.v0']).toBeDefined();
    expect(SOLVER_TYPE_PAYLOADS['prediction.v1']).toBeDefined();
    expect(SOLVER_TYPE_PAYLOADS['prediction.apy.v0']).toBeDefined();
    expect(SOLVER_TYPE_PAYLOADS['swe-rebench-v2.v1']).toBeDefined();
  });

  it('each solver type has restoration + verdict schemas', () => {
    for (const solverType of [
      'portfolio.v0',
      'prediction.v1',
      'prediction.apy.v0',
      'swe-rebench-v2.v1',
    ]) {
      expect(SOLVER_TYPE_PAYLOADS[solverType].restoration).toBeDefined();
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

  it('accepts a valid Solution payload (restoration role)', () => {
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
    expect(() => validatePayload('swe-rebench-v2.v1', 'restoration', bad)).toThrow();
  });

  it('rejects a Verdict with score outside the 0|1 union', () => {
    const bad = { ...validVerdict, score: 0.5 };
    expect(() => validatePayload('swe-rebench-v2.v1', 'verdict', bad)).toThrow();
  });

  it('rejects a Solution with the wrong schemaVersion literal', () => {
    const bad = { ...validSolution, schemaVersion: 'swe-rebench-v2-solution.v0' };
    expect(() => validatePayload('swe-rebench-v2.v1', 'restoration', bad)).toThrow();
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
      validatePayload('portfolio.v0', 'restoration', validPortfolioRestoration),
    ).not.toThrow();
  });

  it('throws for unknown solverType', () => {
    expect(() => validatePayload('bogus.v0', 'restoration', {})).toThrow(/Unknown solverType/);
  });

  it('throws for unknown role', () => {
    expect(() =>
      // cast to bypass TS; the function's responsibility is runtime guard
      validatePayload('portfolio.v0', 'witness' as unknown as 'restoration', {}),
    ).toThrow(/No payload schema/);
  });

  it('throws when payload fails schema validation', () => {
    expect(() =>
      validatePayload('portfolio.v0', 'restoration', { bogus: true }),
    ).toThrow();
  });
});
