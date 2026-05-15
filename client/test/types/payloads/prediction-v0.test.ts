import { describe, it, expect } from 'vitest';
import {
  PredictionV0RestorationPayloadSchema,
  PredictionV0VerdictPayloadSchema,
} from '../../../src/types/payloads/prediction-v0.js';

describe('PredictionV0RestorationPayloadSchema', () => {
  const valid = {
    prediction: {
      probability: '0.75',
      submittedAt: 1700000000000,
      modelId: 'claude-haiku-4-5',
    },
  };

  it('accepts a restoration payload', () => {
    expect(() => PredictionV0RestorationPayloadSchema.parse(valid)).not.toThrow();
  });

  it('accepts a restoration payload with optional oracleSnapshot and rationale', () => {
    const withOptionals = {
      ...valid,
      oracleSnapshot: {
        feed: '0xabcd1234',
        roundId: '42',
        answer: '100000000',
        updatedAt: 1700000000,
      },
      rationale: [{ ts: 1700000000000, note: 'Market trending up' }],
    };
    expect(() => PredictionV0RestorationPayloadSchema.parse(withOptionals)).not.toThrow();
  });

  it('rejects invalid restoration payload — probability out of range', () => {
    expect(() =>
      PredictionV0RestorationPayloadSchema.parse({
        ...valid,
        prediction: { ...valid.prediction, probability: '1.5' },
      }),
    ).toThrow();
  });

  it('rejects invalid restoration payload — missing modelId', () => {
    expect(() =>
      PredictionV0RestorationPayloadSchema.parse({
        prediction: { probability: '0.5', submittedAt: 1700000000000 },
      }),
    ).toThrow();
  });
});

describe('PredictionV0VerdictPayloadSchema', () => {
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
    score: '0.85',
    scoreBasis: 'brier.v1',
    scoreVersion: '1',
    oracleReading: {
      feed: '0xabcd1234',
      roundId: '100',
      answer: '200000000',
      updatedAt: 1700000000,
    },
    claimed: {
      probability: '0.75',
      submittedAt: 1700000000000,
      modelId: 'claude-haiku-4-5',
    },
    groundTruth: 'YES',
    checks: [{ name: 'probability-range', status: 'PASS' }],
  };

  it('accepts a verdict payload', () => {
    expect(() => PredictionV0VerdictPayloadSchema.parse(valid)).not.toThrow();
  });

  it('accepts a verdict payload with optional fields', () => {
    const withOptionals = {
      ...valid,
      oracleReading: {
        ...valid.oracleReading,
        nextRoundUpdatedAt: 1700001000,
      },
      claimed: {
        ...valid.claimed,
        submissionManifestCid: 'bafy-submission',
      },
    };
    expect(() => PredictionV0VerdictPayloadSchema.parse(withOptionals)).not.toThrow();
  });

  it('accepts legacy restorationEnvelope as a read-compat alias', () => {
    const { solutionEnvelope, ...rest } = valid;
    const parsed = PredictionV0VerdictPayloadSchema.parse({
      ...rest,
      restorationEnvelope: solutionEnvelope,
    });
    expect(parsed.solutionEnvelope).toEqual(solutionEnvelope);
  });

  it('rejects invalid verdict payload — bad sha256 in solutionEnvelope', () => {
    expect(() =>
      PredictionV0VerdictPayloadSchema.parse({
        ...valid,
        solutionEnvelope: { cid: 'bafy-solution', sha256: 'not-a-hash' },
      }),
    ).toThrow();
  });

  it('rejects invalid verdict payload — missing verificationOfRestoration', () => {
    const { verificationOfRestoration: _ignored, ...rest } = valid;
    expect(() => PredictionV0VerdictPayloadSchema.parse(rest)).toThrow();
  });
});
