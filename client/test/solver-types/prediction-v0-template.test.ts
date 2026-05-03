import { describe, it, expect, vi } from 'vitest';
import {
  resolvePredictionV1Template,
  isCurrentSentinel,
  predictionV1TemplateNeedsReadCurrent,
} from '../../src/solver-types/prediction-v0-template.js';

const validTemplate = () => ({
  id: 'test-1',
  description: 'ETH direction test',
  window: { startTs: 0, endTs: 0 },
  spec: {
    kind: 'prediction.v1',
    oracle: {
      venue: 'chainlink-base-sepolia',
      feed: '0x4aDC67696bA383F43DD60A9e78F2C97Fbbfc7cb1',
      feedDescription: 'ETH / USD',
    },
    question: {
      kind: 'threshold',
      operator: 'GT',
      threshold: 'current',
      resolveTs: 0,
    },
  },
  eligibility: { maxSubmissionDelayMs: 60_000 },
});

describe('isCurrentSentinel', () => {
  it('matches "current" and "current±N[%]" forms', () => {
    expect(isCurrentSentinel('current')).toBe(true);
    expect(isCurrentSentinel('current+0.5%')).toBe(true);
    expect(isCurrentSentinel('current-2%')).toBe(true);
    expect(isCurrentSentinel('current+100')).toBe(true);
    expect(isCurrentSentinel('current-50')).toBe(true);
    expect(isCurrentSentinel('current-0.001')).toBe(true);
  });

  it('rejects non-sentinel strings', () => {
    expect(isCurrentSentinel('3000')).toBe(false);
    expect(isCurrentSentinel('currently')).toBe(false);
    expect(isCurrentSentinel('current*2')).toBe(false);
    expect(isCurrentSentinel('')).toBe(false);
    expect(isCurrentSentinel(3000)).toBe(false);
    expect(isCurrentSentinel(null)).toBe(false);
  });
});

describe('resolvePredictionV1Template', () => {
  it('rejects current[±…] threshold without readCurrent', async () => {
    const t = validTemplate();
    await expect(resolvePredictionV1Template(t, {})).rejects.toThrow(/readCurrent is required/);
  });

  it('predictionV1TemplateNeedsReadCurrent is true for current sentinel, false for literal threshold', () => {
    const base = validTemplate();
    expect(predictionV1TemplateNeedsReadCurrent(base)).toBe(true);
    const literal = {
      ...base,
      spec: {
        ...base.spec,
        question: { ...base.spec.question, threshold: '3500' },
      },
    };
    expect(predictionV1TemplateNeedsReadCurrent(literal)).toBe(false);
  });

  it('fills startTs=0 with now-relative values and maintains refinements', async () => {
    const before = Date.now();
    const readCurrent = vi.fn(async () => '2300');
    const resolved = await resolvePredictionV1Template(validTemplate(), { readCurrent });
    const after = Date.now();
    expect(resolved.window.startTs).toBeGreaterThanOrEqual(before);
    expect(resolved.window.startTs).toBeLessThanOrEqual(after);
    // Default: 10 min window + 5 min resolve gap (fast-test epoch cadence).
    expect(resolved.window.endTs - resolved.window.startTs).toBe(600_000);
    if (resolved.spec.question.kind !== 'threshold') throw new Error('wrong kind');
    expect(resolved.spec.question.resolveTs - resolved.window.endTs).toBe(300_000);
  });

  it('respects custom windowDurationMs + resolveGapMs overrides (mainnet-style)', async () => {
    const readCurrent = vi.fn(async () => '2300');
    const resolved = await resolvePredictionV1Template(validTemplate(), {
      readCurrent,
      windowDurationMs: 3_600_000,
      resolveGapMs: 900_000,
    });
    expect(resolved.window.endTs - resolved.window.startTs).toBe(3_600_000);
    if (resolved.spec.question.kind !== 'threshold') throw new Error('wrong kind');
    expect(resolved.spec.question.resolveTs - resolved.window.endTs).toBe(900_000);
  });

  it('resolves "current" threshold via readCurrent', async () => {
    const readCurrent = vi.fn(async () => '2306.35');
    const resolved = await resolvePredictionV1Template(validTemplate(), { readCurrent });
    if (resolved.spec.question.kind !== 'threshold') throw new Error('wrong kind');
    expect(resolved.spec.question.threshold).toBe('2306.35');
    expect(readCurrent).toHaveBeenCalledWith({
      feed: '0x4aDC67696bA383F43DD60A9e78F2C97Fbbfc7cb1',
      venue: 'chainlink-base-sepolia',
    });
  });

  it('resolves "current+0.5%" as current × 1.005', async () => {
    const t = validTemplate();
    t.spec.question.threshold = 'current+0.5%';
    const resolved = await resolvePredictionV1Template(t, { readCurrent: async () => '2000' });
    if (resolved.spec.question.kind !== 'threshold') throw new Error('wrong kind');
    expect(resolved.spec.question.threshold).toBe('2010');
  });

  it('resolves "current-2%" as current × 0.98', async () => {
    const t = validTemplate();
    t.spec.question.threshold = 'current-2%';
    const resolved = await resolvePredictionV1Template(t, { readCurrent: async () => '2000' });
    if (resolved.spec.question.kind !== 'threshold') throw new Error('wrong kind');
    expect(resolved.spec.question.threshold).toBe('1960');
  });

  it('resolves "current+100" as current + 100 (absolute delta)', async () => {
    const t = validTemplate();
    t.spec.question.threshold = 'current+100';
    const resolved = await resolvePredictionV1Template(t, { readCurrent: async () => '2306.35' });
    if (resolved.spec.question.kind !== 'threshold') throw new Error('wrong kind');
    expect(resolved.spec.question.threshold).toBe('2406.35');
  });

  it('resolves "current-50" as current - 50', async () => {
    const t = validTemplate();
    t.spec.question.threshold = 'current-50';
    const resolved = await resolvePredictionV1Template(t, { readCurrent: async () => '2306.35' });
    if (resolved.spec.question.kind !== 'threshold') throw new Error('wrong kind');
    expect(resolved.spec.question.threshold).toBe('2256.35');
  });

  it('passes through already-absolute thresholds without reading Chainlink', async () => {
    const t = validTemplate();
    t.spec.question.threshold = '3000';
    const readCurrent = vi.fn(async () => '2300');
    const resolved = await resolvePredictionV1Template(t, { readCurrent });
    if (resolved.spec.question.kind !== 'threshold') throw new Error('wrong kind');
    expect(resolved.spec.question.threshold).toBe('3000');
    expect(readCurrent).not.toHaveBeenCalled();
  });

  it('throws a helpful error for unparseable sentinels', async () => {
    const t = validTemplate();
    t.spec.question.threshold = 'current*2';
    // This doesn't match isCurrentSentinel so it's treated as an absolute string,
    // which fails Zod regex validation later. That's the expected failure path.
    await expect(resolvePredictionV1Template(t, { readCurrent: async () => '2000' })).rejects.toThrow();
  });

  it('propagates readCurrent errors', async () => {
    const readCurrent = vi.fn(async () => { throw new Error('RPC down'); });
    await expect(resolvePredictionV1Template(validTemplate(), { readCurrent })).rejects.toThrow(/RPC down/);
  });

  it('does not mutate the input template', async () => {
    const t = validTemplate();
    const snapshot = JSON.parse(JSON.stringify(t));
    await resolvePredictionV1Template(t, { readCurrent: async () => '2000' });
    expect(t).toEqual(snapshot);
  });
});
