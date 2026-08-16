import { describe, it, expect } from 'vitest';
import { UnsignedEnvelopeSchema } from '../../src/types/envelope.js';

const baseFields = {
  schemaVersion: 'jinn.execution.v1' as const,
  solverType: 'capture',
  role: 'capture' as const,
  generatedAt: 1714694400,
  participant: {
    safeAddress: '0xabc' + 'd'.repeat(37),
    agentEoa: '0xabc' + 'd'.repeat(37),
  },
  window: { startTs: 1, endTs: 100 },
  executor: {
    implName: 'claude-code',
    implVersion: '1.0.42',
    clientGitSha: 'abc1234',
    codeDigest: 'sha256:' + 'a'.repeat(64),
    runtimeBundleDigest: 'sha256:' + 'b'.repeat(64),
    plugins: [],
    signingKey: { kind: 'agent-eoa' as const, pubkey: '0xdead' + 'b'.repeat(36) },
    mode: 'train' as const,
  },
  evidenceTier: 'self-signed' as const,
  attestation: null,
  trajectory: null,
  artifacts: [],
  payload: {},
};

describe('envelope: role=capture', () => {
  it('accepts role=capture with sessionProvenance and no task', () => {
    const env = {
      ...baseFields,
      sessionProvenance: {
        sessionId: '11111111-1111-4111-9111-111111111111',
        capturedAt: '2026-05-07T00:00:00.000Z',
        originatingTool: { name: 'claude-code', version: '1.0.42' },
        license: { operatorAssertion: 'unspecified' as const },
      },
    };
    const result = UnsignedEnvelopeSchema.safeParse(env);
    expect(result.success).toBe(true);
  });

  it('rejects role=capture if sessionProvenance is missing', () => {
    const env = { ...baseFields };
    const result = UnsignedEnvelopeSchema.safeParse(env);
    expect(result.success).toBe(false);
  });

  it('rejects role=capture if both task and sessionProvenance are present', () => {
    const env = {
      ...baseFields,
      task: {
        cid: 'bafyreiabc',
        onchainCreationTx: '0x' + 'a'.repeat(64),
        onchainCreationBlock: 1,
        requestId: '0x' + 'b'.repeat(64),
      },
      sessionProvenance: {
        sessionId: '11111111-1111-4111-9111-111111111111',
        capturedAt: '2026-05-07T00:00:00.000Z',
        originatingTool: { name: 'claude-code' },
        license: { operatorAssertion: 'unspecified' as const },
      },
    };
    const result = UnsignedEnvelopeSchema.safeParse(env);
    expect(result.success).toBe(false);
  });
});
