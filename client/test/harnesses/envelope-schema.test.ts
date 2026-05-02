import { describe, it, expect } from 'vitest';
import { SignedEnvelopeSchema } from '../../src/types/envelope.js';

const baseEnvelope = {
  schemaVersion: 'jinn.execution.v1',
  solverType: 'prediction.v0',
  role: 'restoration',
  generatedAt: 1745978400,
  task: {
    cid: 'bafyIntent',
    onchainCreationTx: '0x' + 'a'.repeat(64),
    onchainCreationBlock: 1,
    requestId: '0x' + 'b'.repeat(64),
  },
  participant: {
    safeAddress: '0x' + '1'.repeat(40),
    agentEoa: '0x' + '2'.repeat(40),
  },
  window: { startTs: 0, endTs: 1000 },
  executor: {
    implName: 'test',
    implVersion: '0.1.0',
    clientGitSha: 'abc',
    codeDigest: 'sha256:' + 'c'.repeat(64),
    runtimeBundleDigest: 'sha256:' + 'd'.repeat(64),
    plugins: [],
    signingKey: { kind: 'agent-eoa', pubkey: '0x' + 'd'.repeat(128) },
  },
  evidenceTier: 'self-signed',
  attestation: null,
  trajectory: null,
  payload: {},
  signature: {
    algo: 'secp256k1',
    signer: '0x' + '2'.repeat(40),
    hash: '0x' + 'e'.repeat(64),
    sig: '0x' + 'f'.repeat(130),
  },
};

describe('Artifact schema (post-gating-fix)', () => {
  it('accepts an artifact with required access fields and no cid', () => {
    const env = {
      ...baseEnvelope,
      artifacts: [{
        artifactType: 'output.prediction.v0',
        sha256: 'a'.repeat(64),
        access: { endpoint: 'https://op.example.com', priceUsdc: '0' },
      }],
    };
    const result = SignedEnvelopeSchema.safeParse(env);
    expect(result.success).toBe(true);
  });

  it('rejects an artifact missing access', () => {
    const env = {
      ...baseEnvelope,
      artifacts: [{
        artifactType: 'output.prediction.v0',
        sha256: 'a'.repeat(64),
      }],
    };
    const result = SignedEnvelopeSchema.safeParse(env);
    expect(result.success).toBe(false);
  });

  it('strips cid from a parsed artifact (field removed)', () => {
    const env = {
      ...baseEnvelope,
      artifacts: [{
        artifactType: 'output.prediction.v0',
        sha256: 'a'.repeat(64),
        cid: 'bafyContent',
        access: { endpoint: 'https://op.example.com', priceUsdc: '0' },
      }],
    };
    const result = SignedEnvelopeSchema.safeParse(env);
    expect(result.success).toBe(true);
    expect((result.data!.artifacts[0] as Record<string, unknown>).cid).toBeUndefined();
  });

  it('strips access.kind discriminator (field removed)', () => {
    const env = {
      ...baseEnvelope,
      artifacts: [{
        artifactType: 'output.prediction.v0',
        sha256: 'a'.repeat(64),
        access: { kind: 'open', endpoint: 'https://op.example.com', priceUsdc: '0' },
      }],
    };
    const result = SignedEnvelopeSchema.safeParse(env);
    expect(result.success).toBe(true);
    const parsedAccess = result.data!.artifacts[0].access as Record<string, unknown>;
    expect(parsedAccess.kind).toBeUndefined();
  });
});
