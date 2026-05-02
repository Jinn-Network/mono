import { describe, it, expect } from 'vitest';
import { SOLVER_TYPE_PAYLOADS, validatePayload } from '../../../src/types/payloads/index.js';

describe('SOLVER_TYPE_PAYLOADS registry', () => {
  it('has all in-repo typed solver types', () => {
    expect(SOLVER_TYPE_PAYLOADS['portfolio.v0']).toBeDefined();
    expect(SOLVER_TYPE_PAYLOADS['prediction.v0']).toBeDefined();
    expect(SOLVER_TYPE_PAYLOADS['prediction.v1']).toBeDefined();
    expect(SOLVER_TYPE_PAYLOADS['prediction.apy.v0']).toBeDefined();
  });

  it('each solver type has restoration + verdict schemas', () => {
    for (const solverType of ['portfolio.v0', 'prediction.v0', 'prediction.v1', 'prediction.apy.v0']) {
      expect(SOLVER_TYPE_PAYLOADS[solverType].restoration).toBeDefined();
      expect(SOLVER_TYPE_PAYLOADS[solverType].verdict).toBeDefined();
    }
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
