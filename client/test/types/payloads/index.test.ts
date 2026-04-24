import { describe, it, expect } from 'vitest';
import { KIND_PAYLOADS, validatePayload } from '../../../src/types/payloads/index.js';

describe('KIND_PAYLOADS registry', () => {
  it('has all three kinds', () => {
    expect(KIND_PAYLOADS['portfolio.v0']).toBeDefined();
    expect(KIND_PAYLOADS['prediction.v0']).toBeDefined();
    expect(KIND_PAYLOADS['prediction.apy.v0']).toBeDefined();
  });

  it('each kind has restoration + verdict schemas', () => {
    for (const kind of ['portfolio.v0', 'prediction.v0', 'prediction.apy.v0']) {
      expect(KIND_PAYLOADS[kind].restoration).toBeDefined();
      expect(KIND_PAYLOADS[kind].verdict).toBeDefined();
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

  it('accepts a valid (kind, role) pair', () => {
    expect(() =>
      validatePayload('portfolio.v0', 'restoration', validPortfolioRestoration),
    ).not.toThrow();
  });

  it('throws for unknown kind', () => {
    expect(() => validatePayload('bogus.v0', 'restoration', {})).toThrow(/Unknown kind/);
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
