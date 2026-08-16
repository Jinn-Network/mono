import { describe, expect, it } from 'vitest';
import { parsePredictionApySubmissionEnvelope } from '../../../../src/harnesses/impls/prediction-apy-v0-evaluator/parse-submission.js';

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

function makeValidEnvelope(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 'jinn.execution.v1',
    solverType: 'prediction.apy.v0',
    role: 'solution',
    generatedAt: 1_000,
    task: intentProv,
    participant: { safeAddress: '0x' + '44'.repeat(20), agentEoa: '0x' + '55'.repeat(20) },
    window: { startTs: 0, endTs: 600_000 },
    executor: {
      implName: 'claude-mcp-prediction-apy',
      implVersion: '1.0.0',
      clientGitSha: 'dev',
      codeDigest: 'sha256:' + '0'.repeat(64),
      runtimeBundleDigest: 'sha256:' + '1'.repeat(64),
      plugins: [],
      signingKey: { kind: 'agent-eoa', pubkey: '0x' + '55'.repeat(20) },
    },
    evidenceTier: 'self-signed',
    attestation: null,
    trajectory: null,
    artifacts: [],
    payload: {
      prediction: { predictedBps: '42', submittedAt: 100_000, modelId: 'apy-persistence.v1' },
    },
    signature: sigStub(),
    ...overrides,
  };
}

describe('parsePredictionApySubmissionEnvelope', () => {
  it('parses a valid jinn.execution.v1 envelope', () => {
    const raw = makeValidEnvelope();
    const { envelope, payload } = parsePredictionApySubmissionEnvelope(JSON.stringify(raw));
    expect(envelope.solverType).toBe('prediction.apy.v0');
    expect(envelope.role).toBe('solution');
    expect(payload.prediction.predictedBps).toBe('42');
    expect(payload.prediction.submittedAt).toBe(100_000);
  });

  it('returns correct payload fields', () => {
    const raw = makeValidEnvelope({
      payload: {
        prediction: { predictedBps: '7', submittedAt: 200_000, modelId: 'm' },
      },
    });
    const { payload } = parsePredictionApySubmissionEnvelope(JSON.stringify(raw));
    expect(payload.prediction.modelId).toBe('m');
  });

  it('accepts legacy restoration role envelopes without mutating signed data', () => {
    const raw = makeValidEnvelope({ role: 'restoration' });
    const { envelope } = parsePredictionApySubmissionEnvelope(JSON.stringify(raw));
    expect(envelope.role).toBe('restoration');
  });

  it('throws on invalid json', () => {
    expect(() => parsePredictionApySubmissionEnvelope('not json')).toThrow();
  });

  it('throws when envelope kind is wrong', () => {
    const raw = makeValidEnvelope({ solverType: 'portfolio.v0' });
    expect(() => parsePredictionApySubmissionEnvelope(JSON.stringify(raw))).toThrow(/kind\/role/);
  });
});
