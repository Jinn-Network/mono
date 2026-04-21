import { describe, it, expect } from 'vitest';
import { parseDesiredState } from '../../src/types/desired-state.js';
import {
  PortfolioV0IntentSchema,
  RestorationManifestSchema,
  VerdictManifestSchema,
} from '../../src/types/portfolio.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

const START_TS = 1_700_000_000_000;
const END_TS = START_TS + 86_400_000; // exactly 24h later

const portfolioV0Intent = {
  id: 'intent-1',
  description: 'Increase HL portfolio over 24h with bounded drawdown.',
  window: { startTs: START_TS, endTs: END_TS },
  spec: {
    kind: 'portfolio.v0',
    account: {
      venue: 'hyperliquid-testnet',
      masterAddress: '0xabcdef1234567890abcdef1234567890abcdef12',
    },
    target: {
      metric: 'equity_return_pct',
      minReturnPct: 5.0,
    },
    constraint: {
      maxDrawdownPct: 10.0,
    },
  },
  eligibility: {
    minClosedTrades: 25,
    minTradedNotionalMultiple: 6.0,
  },
};

const intentProvenance = {
  cid: 'bafybeig...',
  onchainCreationTx: '0xabc0000000000000000000000000000000000000000000000000000000000001',
  onchainCreationBlock: 123456,
  requestId: '0xdef0000000000000000000000000000000000000000000000000000000000002',
};

const participant = {
  safeAddress: '0x1111111111111111111111111111111111111111',
  agentEoa: '0x2222222222222222222222222222222222222222',
};

const signature = {
  algo: 'secp256k1' as const,
  signer: '0x2222222222222222222222222222222222222222',
  hash: '0xaaaa000000000000000000000000000000000000000000000000000000000001',
  sig: '0xbbbb000000000000000000000000000000000000000000000000000000000002',
};

const snapshot = {
  capturedAt: START_TS,
  hlTime: START_TS - 500,
  payload: { equity: '10000.00' },
};

const postSnapshot = {
  capturedAt: END_TS,
  hlTime: END_TS - 500,
  payload: { equity: '10600.00' },
};

// ── Legacy backwards compat ───────────────────────────────────────────────────

describe('DesiredState legacy backwards compat', () => {
  it('parses {id, description} (minimal legacy)', () => {
    const result = parseDesiredState({ id: 'abc', description: 'Check health.' });
    expect(result.id).toBe('abc');
    expect(result.description).toBe('Check health.');
    expect(result.context).toBeUndefined();
    expect(result.window).toBeUndefined();
    expect(result.spec).toBeUndefined();
    expect(result.eligibility).toBeUndefined();
  });

  it('parses {id, description, context} (legacy with context)', () => {
    const result = parseDesiredState({
      id: 'def',
      description: 'API health check.',
      context: { endpoint: 'https://api.example.com/health' },
    });
    expect(result.context).toEqual({ endpoint: 'https://api.example.com/health' });
    expect(result.window).toBeUndefined();
  });

  it('assigns a UUID when id is omitted', () => {
    const result = parseDesiredState({ description: 'No id provided.' });
    expect(typeof result.id).toBe('string');
    expect(result.id.length).toBeGreaterThan(0);
  });

  it('rejects a missing description', () => {
    expect(() => parseDesiredState({ id: 'x' })).toThrow();
  });
});

// ── DesiredState with new optional fields ─────────────────────────────────────

describe('DesiredState with window / spec / eligibility', () => {
  it('parses a portfolio.v0 desired state', () => {
    const result = parseDesiredState(portfolioV0Intent);
    expect(result.window).toEqual({ startTs: START_TS, endTs: END_TS });
    expect(result.spec?.kind).toBe('portfolio.v0');
    expect(result.eligibility).toBeDefined();
  });
});

// ── portfolio.v0 intent schema ────────────────────────────────────────────────

describe('PortfolioV0IntentSchema', () => {
  it('parses a fully-specified portfolio.v0 intent', () => {
    const result = PortfolioV0IntentSchema.parse(portfolioV0Intent);
    expect(result.spec.kind).toBe('portfolio.v0');
    expect(result.spec.account.venue).toBe('hyperliquid-testnet');
    expect(result.eligibility?.minClosedTrades).toBe(25);
  });

  it('applies eligibility defaults when eligibility is omitted', () => {
    const { eligibility: _, ...withoutEligibility } = portfolioV0Intent;
    const result = PortfolioV0IntentSchema.parse(withoutEligibility);
    // eligibility defaults to {} which triggers sub-field defaults per spec §4.1
    expect(result.eligibility).toEqual({ minClosedTrades: 20, minTradedNotionalMultiple: 5.0 });
  });

  it('parses eligibility with explicit defaults', () => {
    const result = PortfolioV0IntentSchema.parse({
      ...portfolioV0Intent,
      eligibility: { minClosedTrades: 20, minTradedNotionalMultiple: 5.0 },
    });
    expect(result.eligibility?.minClosedTrades).toBe(20);
    expect(result.eligibility?.minTradedNotionalMultiple).toBe(5.0);
  });

  it('rejects a non-24h window', () => {
    const bad = {
      ...portfolioV0Intent,
      window: { startTs: START_TS, endTs: START_TS + 3_600_000 }, // 1h, not 24h
    };
    expect(() => PortfolioV0IntentSchema.parse(bad)).toThrow(/24 h/);
  });

  it('rejects an unknown venue', () => {
    const bad = {
      ...portfolioV0Intent,
      spec: {
        ...portfolioV0Intent.spec,
        account: { ...portfolioV0Intent.spec.account, venue: 'unknown-venue' },
      },
    };
    expect(() => PortfolioV0IntentSchema.parse(bad)).toThrow();
  });
});

// ── Restoration manifest ──────────────────────────────────────────────────────

describe('RestorationManifestSchema', () => {
  const baseManifest = {
    schemaVersion: 'portfolio.v0.manifest.v1' as const,
    generatedAt: END_TS + 1000,
    intent: intentProvenance,
    restorer: participant,
    window: { startTs: START_TS, endTs: END_TS },
    preSnapshot: snapshot,
    postSnapshot: postSnapshot,
    fills: [{ tid: 1, side: 'B', px: '100', sz: '1' }],
    gating: {
      equityReturnPct: '6.00',
      maxDrawdownPct: '3.50',
      closedTradesCount: 22,
      tradedNotionalMultiple: '5.5',
    },
    artifacts: [
      {
        cid: 'bafybeig...',
        role: 'session_transcript',
        tags: ['trading'],
      },
    ],
    signature,
  };

  it('parses a minimal valid restoration manifest', () => {
    const result = RestorationManifestSchema.parse(baseManifest);
    expect(result.schemaVersion).toBe('portfolio.v0.manifest.v1');
    expect(result.gating.closedTradesCount).toBe(22);
    expect(result.fills).toHaveLength(1);
    expect(result.informational).toBeUndefined();
    expect(result.rationale).toBeUndefined();
  });

  it('parses a manifest with optional informational + rationale', () => {
    const result = RestorationManifestSchema.parse({
      ...baseManifest,
      informational: {
        sharpe: '1.23',
        calmar: '0.85',
        holdTimeMs: { mean: 3600000, median: 1800000, p95: 7200000 },
        longShortMix: { longCount: 14, shortCount: 8 },
      },
      rationale: [
        {
          ts: START_TS + 3_600_000,
          sessionId: 'sess-1',
          note: 'Opened long BTC based on momentum.',
          relatedFillTids: [42, 43],
        },
      ],
    });
    expect(result.informational?.sharpe).toBe('1.23');
    expect(result.rationale?.[0]?.sessionId).toBe('sess-1');
  });

  it('parses a manifest with x402-gated artifact', () => {
    const result = RestorationManifestSchema.parse({
      ...baseManifest,
      artifacts: [
        {
          cid: 'bafybeig...',
          role: 'generated_file',
          access: { kind: 'x402-gated', endpoint: 'https://api.example.com/artifact', priceUsdc: '1.00' },
        },
      ],
    });
    expect(result.artifacts[0]?.access?.kind).toBe('x402-gated');
  });

  it('rejects a manifest with a wrong schemaVersion', () => {
    expect(() =>
      RestorationManifestSchema.parse({ ...baseManifest, schemaVersion: 'portfolio.v0.eval.manifest.v1' }),
    ).toThrow();
  });
});

// ── Verdict manifest ──────────────────────────────────────────────────────────

describe('VerdictManifestSchema', () => {
  const baseVerdict = {
    schemaVersion: 'portfolio.v0.eval.manifest.v1' as const,
    generatedAt: END_TS + 2000,
    intent: intentProvenance,
    evaluator: { safeAddress: '0x3333333333333333333333333333333333333333', agentEoa: '0x4444444444444444444444444444444444444444' },
    window: { startTs: START_TS, endTs: END_TS },
    verdict: 'PASS' as const,
    score: '1230000000000000000',
    scoreBasis: 'calmar.v1',
    scoreVersion: '1',
    rederived: {
      preSnapshot: { capturedAt: START_TS, payload: { equity: '10000.00' } },
      postSnapshot: { capturedAt: END_TS, payload: { equity: '10600.00' } },
      fills: [{ tid: 1 }],
      gating: { equityReturnPct: '6.00', closedTradesCount: 22 },
    },
    claimed: {
      preSnapshot: { capturedAt: START_TS, payload: { equity: '10000.00' } },
      postSnapshot: { capturedAt: END_TS, payload: { equity: '10600.00' } },
      fillsHash: '0xcccc000000000000000000000000000000000000000000000000000000000003',
      fillsCount: 1,
      gating: { equityReturnPct: '6.00', closedTradesCount: 22 },
    },
    checks: [
      { name: 'consistency.gating.equity_return', status: 'PASS' as const },
      { name: 'consistency.fills.count', status: 'PASS' as const, detail: 'counts match' },
    ],
    signature: {
      algo: 'secp256k1' as const,
      signer: '0x4444444444444444444444444444444444444444',
      hash: '0xdddd000000000000000000000000000000000000000000000000000000000004',
      sig: '0xeeee000000000000000000000000000000000000000000000000000000000005',
    },
  };

  it('parses a PASS verdict', () => {
    const result = VerdictManifestSchema.parse(baseVerdict);
    expect(result.verdict).toBe('PASS');
    expect(result.scoreBasis).toBe('calmar.v1');
    expect(result.checks).toHaveLength(2);
  });

  it('parses all verdict values', () => {
    for (const verdict of ['PASS', 'FAIL', 'REJECTED', 'INDETERMINATE'] as const) {
      const result = VerdictManifestSchema.parse({ ...baseVerdict, verdict });
      expect(result.verdict).toBe(verdict);
    }
  });

  it('parses a check with an object detail', () => {
    const result = VerdictManifestSchema.parse({
      ...baseVerdict,
      checks: [
        {
          name: 'consistency.snapshots.equity',
          status: 'FAIL',
          detail: { restorer: '10600', evaluator: '10580', delta: '20' },
        },
      ],
    });
    expect(result.checks[0]?.status).toBe('FAIL');
    expect(typeof result.checks[0]?.detail).toBe('object');
  });

  it('rejects an invalid verdict value', () => {
    expect(() => VerdictManifestSchema.parse({ ...baseVerdict, verdict: 'UNKNOWN' })).toThrow();
  });

  it('rejects a manifest with a wrong schemaVersion', () => {
    expect(() =>
      VerdictManifestSchema.parse({ ...baseVerdict, schemaVersion: 'portfolio.v0.manifest.v1' }),
    ).toThrow();
  });
});
