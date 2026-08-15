import { describe, it, expect } from 'vitest';
import {
  PortfolioV0RestorationPayloadSchema,
  PortfolioV0VerdictPayloadSchema,
} from '../../../src/types/payloads/portfolio-v0.js';

describe('PortfolioV0RestorationPayloadSchema', () => {
  const valid = {
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
  it('accepts a restoration payload', () => {
    expect(() => PortfolioV0RestorationPayloadSchema.parse(valid)).not.toThrow();
  });
  it('rejects invalid gating', () => {
    expect(() =>
      PortfolioV0RestorationPayloadSchema.parse({ ...valid, gating: { bogus: 1 } }),
    ).toThrow();
  });
});

describe('PortfolioV0VerdictPayloadSchema', () => {
  const valid = {
    solutionEnvelope: {
      cid: 'bafy-solution',
      sha256: '0'.repeat(64),
    },
    verificationOfRestoration: {
      claimedTier: 'self-signed',
      sdkVersion: '1.0.0',
      timestamp: 1700000000000,
      checks: [{ name: 'signature', passed: true }],
      overall: 'valid',
    },
    verdict: 'PASS',
    score: '0.95',
    scoreBasis: 'equityReturnPct',
    scoreVersion: '1',
    rederived: {
      preSnapshot: { capturedAt: 1, payload: {} },
      postSnapshot: { capturedAt: 2, payload: {} },
      fills: [],
      gating: {},
    },
    claimed: {
      preSnapshot: { capturedAt: 1, payload: {} },
      postSnapshot: { capturedAt: 2, payload: {} },
      fillsHash: '0xff',
      fillsCount: 0,
      gating: {},
    },
    checks: [{ name: 'x', status: 'PASS' }],
  };
  it('accepts a verdict payload', () => {
    expect(() => PortfolioV0VerdictPayloadSchema.parse(valid)).not.toThrow();
  });

  it('accepts legacy restorationEnvelope as a read-compat alias', () => {
    const { solutionEnvelope, ...rest } = valid;
    const parsed = PortfolioV0VerdictPayloadSchema.parse({
      ...rest,
      restorationEnvelope: solutionEnvelope,
    });
    expect(parsed.solutionEnvelope).toEqual(solutionEnvelope);
  });
});
