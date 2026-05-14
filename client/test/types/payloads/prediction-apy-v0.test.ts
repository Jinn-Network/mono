import { describe, it, expect } from 'vitest';
import {
  PredictionApyV0RestorationPayloadSchema,
  PredictionApyV0VerdictPayloadSchema,
} from '../../../src/types/payloads/prediction-apy-v0.js';

describe('PredictionApyV0RestorationPayloadSchema', () => {
  const valid = {
    prediction: {
      predictedBps: '450',
      submittedAt: 1700000000000,
      modelId: 'claude-haiku-4-5',
    },
  };

  it('accepts a restoration payload', () => {
    expect(() => PredictionApyV0RestorationPayloadSchema.parse(valid)).not.toThrow();
  });

  it('accepts a restoration payload with negative predictedBps', () => {
    const withNegative = {
      prediction: { ...valid.prediction, predictedBps: '-10' },
    };
    expect(() => PredictionApyV0RestorationPayloadSchema.parse(withNegative)).not.toThrow();
  });

  it('rejects invalid restoration payload — non-integer predictedBps', () => {
    expect(() =>
      PredictionApyV0RestorationPayloadSchema.parse({
        prediction: { ...valid.prediction, predictedBps: '4.5' },
      }),
    ).toThrow();
  });

  it('rejects invalid restoration payload — missing modelId', () => {
    expect(() =>
      PredictionApyV0RestorationPayloadSchema.parse({
        prediction: { predictedBps: '450', submittedAt: 1700000000000 },
      }),
    ).toThrow();
  });
});

describe('PredictionApyV0VerdictPayloadSchema', () => {
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
    score: '0.90',
    scoreBasis: 'absolute-error-linear.v1',
    scoreVersion: '1',
    oracleReading: {
      pool: '0xabcd1234',
      reserve: '0xdead5678',
      sampleCount: 10,
      twaWindowSeconds: 86400,
      resolveTs: 1700000000,
    },
    claimed: {
      predictedBps: '450',
      submittedAt: 1700000000000,
      modelId: 'claude-haiku-4-5',
    },
    groundTruth: {
      twApyBps: '430',
      errorBps: '20',
    },
    checks: [{ name: 'submission-window', status: 'PASS' }],
  };

  it('accepts a verdict payload', () => {
    expect(() => PredictionApyV0VerdictPayloadSchema.parse(valid)).not.toThrow();
  });

  it('accepts a verdict payload with optional submissionManifestCid', () => {
    const withOptional = {
      ...valid,
      claimed: { ...valid.claimed, submissionManifestCid: 'bafy-submission' },
    };
    expect(() => PredictionApyV0VerdictPayloadSchema.parse(withOptional)).not.toThrow();
  });

  it('accepts legacy restorationEnvelope as a read-compat alias', () => {
    const { solutionEnvelope, ...rest } = valid;
    const parsed = PredictionApyV0VerdictPayloadSchema.parse({
      ...rest,
      restorationEnvelope: solutionEnvelope,
    });
    expect(parsed.solutionEnvelope).toEqual(solutionEnvelope);
  });

  it('rejects invalid verdict payload — bad sha256 in solutionEnvelope', () => {
    expect(() =>
      PredictionApyV0VerdictPayloadSchema.parse({
        ...valid,
        solutionEnvelope: { cid: 'bafy-solution', sha256: 'not-a-hash' },
      }),
    ).toThrow();
  });

  it('rejects invalid verdict payload — missing verificationOfRestoration', () => {
    const { verificationOfRestoration: _ignored, ...rest } = valid;
    expect(() => PredictionApyV0VerdictPayloadSchema.parse(rest)).toThrow();
  });

  it('rejects invalid verdict payload — wrong scoreBasis', () => {
    expect(() =>
      PredictionApyV0VerdictPayloadSchema.parse({
        ...valid,
        scoreBasis: 'brier.v1',
      }),
    ).toThrow();
  });
});
