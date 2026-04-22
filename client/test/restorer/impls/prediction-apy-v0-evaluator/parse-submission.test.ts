import { describe, expect, it } from 'vitest';
import { parsePredictionApySubmissionManifest } from '../../../../src/restorer/impls/prediction-apy-v0-evaluator/parse-submission.js';

const intentProv = {
  cid: 'bafytest',
  onchainCreationTx: '0x' + 'ab'.repeat(32),
  onchainCreationBlock: 1,
  requestId: '0x' + 'cd'.repeat(32),
};

function sigStub() {
  return {
    algo: 'secp256k1' as const,
    signer: '0x' + '11'.repeat(20),
    hash: '0x' + '22'.repeat(32),
    sig: '0x' + '33'.repeat(65),
  };
}

describe('parsePredictionApySubmissionManifest', () => {
  it('normalizes engine gating shape', () => {
    const raw = {
      schemaVersion: 'prediction.apy.v0.submission.v1',
      generatedAt: 1_000,
      intent: intentProv,
      restorer: { safeAddress: '0x' + '44'.repeat(20), agentEoa: '0x' + '55'.repeat(20) },
      window: { startTs: 0, endTs: 600_000 },
      gating: { predictedBps: '42', submittedAt: 100_000, modelId: 'apy-persistence.v1' },
      signature: sigStub(),
    };
    const m = parsePredictionApySubmissionManifest(JSON.stringify(raw));
    expect(m.prediction.predictedBps).toBe('42');
    expect(m.prediction.submittedAt).toBe(100_000);
  });

  it('accepts direct schema-shaped manifest', () => {
    const raw = {
      schemaVersion: 'prediction.apy.v0.submission.v1',
      generatedAt: 1_000,
      intent: intentProv,
      restorer: { safeAddress: '0x' + '44'.repeat(20), agentEoa: '0x' + '55'.repeat(20) },
      window: { startTs: 0, endTs: 600_000 },
      prediction: { predictedBps: '7', submittedAt: 200_000, modelId: 'm' },
      signature: sigStub(),
    };
    const m = parsePredictionApySubmissionManifest(JSON.stringify(raw));
    expect(m.prediction.modelId).toBe('m');
  });

  it('throws on invalid json', () => {
    expect(() => parsePredictionApySubmissionManifest('not json')).toThrow();
  });
});
