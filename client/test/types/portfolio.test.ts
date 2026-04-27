import { describe, it, expect } from 'vitest';
import { parseRestorationJob } from '../../src/types/desired-state.js';
import {
  PortfolioV0IntentSchema,
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

// ── Legacy backwards compat ───────────────────────────────────────────────────

describe('RestorationJob legacy backwards compat', () => {
  it('parses {id, description} (minimal legacy)', () => {
    const result = parseRestorationJob({ id: 'abc', description: 'Check health.' });
    expect(result.id).toBe('abc');
    expect(result.description).toBe('Check health.');
    expect(result.context).toBeUndefined();
    expect(result.window).toBeUndefined();
    expect(result.spec).toBeUndefined();
    expect(result.eligibility).toBeUndefined();
  });

  it('parses {id, description, context} (legacy with context)', () => {
    const result = parseRestorationJob({
      id: 'def',
      description: 'API health check.',
      context: { endpoint: 'https://api.example.com/health' },
    });
    expect(result.context).toEqual({ endpoint: 'https://api.example.com/health' });
    expect(result.window).toBeUndefined();
  });

  it('assigns a UUID when id is omitted', () => {
    const result = parseRestorationJob({ description: 'No id provided.' });
    expect(typeof result.id).toBe('string');
    expect(result.id.length).toBeGreaterThan(0);
  });

  it('rejects a missing description', () => {
    expect(() => parseRestorationJob({ id: 'x' })).toThrow();
  });
});

// ── RestorationJob with new optional fields ─────────────────────────────────────

describe('RestorationJob with window / spec / eligibility', () => {
  it('parses a portfolio.v0 desired state', () => {
    const result = parseRestorationJob(portfolioV0Intent);
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
