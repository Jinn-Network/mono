import { describe, it, expect } from 'vitest';
import { parseTask } from '../../src/types/task.js';
import {
  PortfolioV0TaskSchema,
} from '../../src/types/portfolio.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

const START_TS = 1_700_000_000_000;
const END_TS = START_TS + 86_400_000; // exactly 24h later

const portfolioV0Task = {
  id: 'task-1',
  description: 'Increase HL portfolio over 24h with bounded drawdown.',
  solverType: 'portfolio.v0',
  window: { startTs: START_TS, endTs: END_TS },
  spec: {
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

describe('Task legacy backwards compat', () => {
  it('parses {id, description} (minimal legacy)', () => {
    const result = parseTask({ id: 'abc', description: 'Check health.' });
    expect(result.id).toBe('abc');
    expect(result.description).toBe('Check health.');
    expect(result.context).toBeUndefined();
    expect(result.window).toBeUndefined();
    expect(result.spec).toBeUndefined();
    expect(result.eligibility).toBeUndefined();
  });

  it('parses {id, description, context} (legacy with context)', () => {
    const result = parseTask({
      id: 'def',
      description: 'API health check.',
      context: { endpoint: 'https://api.example.com/health' },
    });
    expect(result.context).toEqual({ endpoint: 'https://api.example.com/health' });
    expect(result.window).toBeUndefined();
  });

  it('assigns a UUID when id is omitted', () => {
    const result = parseTask({ description: 'No id provided.' });
    expect(typeof result.id).toBe('string');
    expect(result.id.length).toBeGreaterThan(0);
  });

  it('rejects a missing description', () => {
    expect(() => parseTask({ id: 'x' })).toThrow();
  });
});

// ── Task with new optional fields ─────────────────────────────────────

describe('Task with window / spec / eligibility', () => {
  it('parses a portfolio.v0 Task', () => {
    const result = parseTask(portfolioV0Task);
    expect(result.window).toEqual({ startTs: START_TS, endTs: END_TS });
    expect(result.solverType).toBe('portfolio.v0');
    expect(Object.prototype.hasOwnProperty.call(result.spec ?? {}, 'kind')).toBe(false);
    expect(result.eligibility).toBeDefined();
  });
});

// ── portfolio.v0 task schema ────────────────────────────────────────────────

describe('PortfolioV0TaskSchema', () => {
  it('parses a fully-specified portfolio.v0 task', () => {
    const result = PortfolioV0TaskSchema.parse(portfolioV0Task);
    expect(result.solverType).toBe('portfolio.v0');
    expect(Object.prototype.hasOwnProperty.call(result.spec, 'kind')).toBe(false);
    expect(result.spec.account.venue).toBe('hyperliquid-testnet');
    expect(result.eligibility?.minClosedTrades).toBe(25);
  });

  it('applies eligibility defaults when eligibility is omitted', () => {
    const { eligibility: _, ...withoutEligibility } = portfolioV0Task;
    const result = PortfolioV0TaskSchema.parse(withoutEligibility);
    // eligibility defaults to {} which triggers sub-field defaults per spec §4.1
    expect(result.eligibility).toEqual({ minClosedTrades: 20, minTradedNotionalMultiple: 5.0 });
  });

  it('parses eligibility with explicit defaults', () => {
    const result = PortfolioV0TaskSchema.parse({
      ...portfolioV0Task,
      eligibility: { minClosedTrades: 20, minTradedNotionalMultiple: 5.0 },
    });
    expect(result.eligibility?.minClosedTrades).toBe(20);
    expect(result.eligibility?.minTradedNotionalMultiple).toBe(5.0);
  });

  it('rejects a non-24h window', () => {
    const bad = {
      ...portfolioV0Task,
      window: { startTs: START_TS, endTs: START_TS + 3_600_000 }, // 1h, not 24h
    };
    expect(() => PortfolioV0TaskSchema.parse(bad)).toThrow(/24 h/);
  });

  it('rejects an unknown venue', () => {
    const bad = {
      ...portfolioV0Task,
      spec: {
        ...portfolioV0Task.spec,
        account: { ...portfolioV0Task.spec.account, venue: 'unknown-venue' },
      },
    };
    expect(() => PortfolioV0TaskSchema.parse(bad)).toThrow();
  });
});
