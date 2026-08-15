import { describe, it, expect } from 'vitest';
import { UnsignedEnvelopeSchema } from '../src/types/envelope.js';

describe('Executor.mode', () => {
  const baseExecutor = {
    implName: 'test-harness',
    implVersion: '0.1.0',
    clientGitSha: 'abc1234',
    codeDigest: 'sha256:' + '0'.repeat(64),
    runtimeBundleDigest: 'sha256:' + '1'.repeat(64),
    plugins: [],
    signingKey: { kind: 'agent-eoa' as const, pubkey: '0x' + '2'.repeat(64) },
  };

  const baseEnvelope = {
    schemaVersion: 'jinn.execution.v1' as const,
    solverType: 'prediction.v1',
    role: 'restoration' as const,
    generatedAt: Math.floor(Date.now() / 1000),
    task: {
      cid: 'QmTest',
      onchainCreationTx: '0x' + '3'.repeat(64),
      onchainCreationBlock: 100,
      requestId: '0x' + '4'.repeat(64),
    },
    participant: {
      safeAddress: '0x' + '5'.repeat(40),
      agentEoa: '0x' + '6'.repeat(40),
    },
    window: {
      startTs: 1000,
      endTs: 2000,
    },
    executor: baseExecutor,
    evidenceTier: 'self-signed' as const,
    attestation: null,
    trajectory: null,
    artifacts: [],
    payload: {},
  };

  it('accepts mode: "train" on Executor', () => {
    const env = { ...baseEnvelope, executor: { ...baseExecutor, mode: 'train' } };
    expect(() => UnsignedEnvelopeSchema.parse(env)).not.toThrow();
  });

  it('accepts mode: "frozen" on Executor', () => {
    const env = { ...baseEnvelope, executor: { ...baseExecutor, mode: 'frozen' } };
    expect(() => UnsignedEnvelopeSchema.parse(env)).not.toThrow();
  });

  it('parses envelopes without an Executor.mode field (back-compat: undefined treated as train at use sites)', () => {
    const env = { ...baseEnvelope, executor: baseExecutor };
    const parsed = UnsignedEnvelopeSchema.parse(env);
    expect(parsed.executor.mode).toBeUndefined();
  });

  it('rejects invalid mode values', () => {
    const env = { ...baseEnvelope, executor: { ...baseExecutor, mode: 'eval' } };
    expect(() => UnsignedEnvelopeSchema.parse(env)).toThrow();
  });
});
