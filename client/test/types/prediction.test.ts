import { describe, it, expect } from 'vitest';
import {
  PredictionV0SpecSchema,
  PredictionV0IntentSchema,
} from '../../src/types/prediction.js';

const validThresholdSpec = {
  kind: 'prediction.v0' as const,
  oracle: {
    venue: 'chainlink-base-sepolia' as const,
    feed: '0x4aDC67696bA383F43DD60A9e78F2C97Fbbfc7cb1',
    feedDescription: 'ETH / USD',
  },
  question: {
    kind: 'threshold' as const,
    operator: 'GT' as const,
    threshold: '3500',
    resolveTs: 4_500_000,
  },
};

describe('PredictionV0SpecSchema', () => {
  it('accepts a threshold spec', () => {
    expect(PredictionV0SpecSchema.parse(validThresholdSpec)).toEqual(validThresholdSpec);
  });

  it('accepts a range spec', () => {
    const range = {
      ...validThresholdSpec,
      question: { kind: 'range' as const, lowerBound: '3000', upperBound: '3500', resolveTs: 4_500_000 },
    };
    expect(PredictionV0SpecSchema.parse(range)).toEqual(range);
  });

  it('rejects unknown operators', () => {
    const bad = { ...validThresholdSpec, question: { ...validThresholdSpec.question, operator: 'BETWEEN' as any } };
    expect(() => PredictionV0SpecSchema.parse(bad)).toThrow();
  });

  it('rejects non-hex feed address', () => {
    const bad = { ...validThresholdSpec, oracle: { ...validThresholdSpec.oracle, feed: 'not-hex' } };
    expect(() => PredictionV0SpecSchema.parse(bad)).toThrow();
  });
});

describe('PredictionV0IntentSchema', () => {
  const validIntent = {
    id: 'test-1',
    description: 'ETH > $3500 at T',
    window: { startTs: 0, endTs: 3_600_000 },
    spec: validThresholdSpec,
  };

  it('accepts a 1h window with resolveTs = endTs + 15min (mainnet-style)', () => {
    expect(PredictionV0IntentSchema.parse(validIntent).window.endTs).toBe(3_600_000);
  });

  it('accepts a 10min window with resolveTs = endTs + 5min (fast-test cadence)', () => {
    const fast = {
      ...validIntent,
      window: { startTs: 0, endTs: 600_000 },
      spec: { ...validThresholdSpec, question: { ...validThresholdSpec.question, resolveTs: 900_000 } },
    };
    expect(() => PredictionV0IntentSchema.parse(fast)).not.toThrow();
  });

  it('rejects a window shorter than 1 minute', () => {
    const bad = {
      ...validIntent,
      window: { startTs: 0, endTs: 30_000 },
      spec: { ...validThresholdSpec, question: { ...validThresholdSpec.question, resolveTs: 30_000 } },
    };
    expect(() => PredictionV0IntentSchema.parse(bad)).toThrow(/at least 1 minute/);
  });

  it('rejects a window longer than 24 hours', () => {
    const tooLong = 86_400_001;
    const bad = {
      ...validIntent,
      window: { startTs: 0, endTs: tooLong },
      spec: { ...validThresholdSpec, question: { ...validThresholdSpec.question, resolveTs: tooLong + 60_000 } },
    };
    expect(() => PredictionV0IntentSchema.parse(bad)).toThrow(/at most 24 hours/);
  });

  it('rejects resolveTs before endTs', () => {
    const bad = {
      ...validIntent,
      spec: { ...validThresholdSpec, question: { ...validThresholdSpec.question, resolveTs: 3_500_000 } },
    };
    expect(() => PredictionV0IntentSchema.parse(bad)).toThrow(/resolveTs/);
  });

  it('rejects resolve gap > 1 hour', () => {
    const bad = {
      ...validIntent,
      spec: { ...validThresholdSpec, question: { ...validThresholdSpec.question, resolveTs: 3_600_000 + 3_600_001 } },
    };
    expect(() => PredictionV0IntentSchema.parse(bad)).toThrow(/≤ 1 hour/);
  });
});
