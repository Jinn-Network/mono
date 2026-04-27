import { describe, it, expect } from 'vitest';
import {
  UnsignedEnvelopeSchema,
  SignedEnvelopeSchema,
  EvidenceTierSchema,
  type UnsignedEnvelope,
} from '../../src/types/envelope.js';

describe('EvidenceTierSchema', () => {
  it('accepts the three V1 tiers', () => {
    for (const t of ['self-signed', 'committed', 'attested']) {
      expect(() => EvidenceTierSchema.parse(t)).not.toThrow();
    }
  });
  it('rejects V2+ tiers (consensus, proved) at V1', () => {
    expect(() => EvidenceTierSchema.parse('consensus')).toThrow();
    expect(() => EvidenceTierSchema.parse('proved')).toThrow();
  });
  it('rejects unknown tier', () => {
    expect(() => EvidenceTierSchema.parse('bronze')).toThrow();
  });
});

describe('UnsignedEnvelopeSchema', () => {
  const baseEnv: UnsignedEnvelope = {
    schemaVersion: 'jinn.execution.v1',
    kind: 'portfolio.v0',
    role: 'restoration',
    generatedAt: 1700000000000,
    intent: {
      cid: 'bafy...',
      onchainCreationTx: '0x' + 'ab'.repeat(32),
      onchainCreationBlock: 100,
      requestId: '0x' + 'cd'.repeat(32),
    },
    participant: {
      safeAddress: '0x1111111111111111111111111111111111111111',
      agentEoa: '0x2222222222222222222222222222222222222222',
    },
    window: { startTs: 1, endTs: 86400001 },
    executor: {
      implName: 'claude-mcp-hyperliquid',
      implVersion: '1.0.0',
      clientGitSha: 'abcdef1',
      codeDigest: 'sha256:' + 'ab'.repeat(32),
      signingKey: {
        kind: 'agent-eoa',
        pubkey: '0x2222222222222222222222222222222222222222',
      },
    },
    evidenceTier: 'self-signed',
    attestation: null,
    trajectory: null,
    artifacts: [],
    payload: { preSnapshot: {} as any, postSnapshot: {} as any, fills: [], gating: {} },
  };

  it('accepts a well-formed restoration envelope', () => {
    expect(() => UnsignedEnvelopeSchema.parse(baseEnv)).not.toThrow();
  });

  it('rejects wrong schemaVersion', () => {
    expect(() => UnsignedEnvelopeSchema.parse({ ...baseEnv, schemaVersion: 'jinn.execution.v2' })).toThrow();
  });

  it('rejects invalid role', () => {
    expect(() => UnsignedEnvelopeSchema.parse({ ...baseEnv, role: 'witness' })).toThrow();
  });

  it('requires executor.source when evidenceTier is attested', () => {
    const env = { ...baseEnv, evidenceTier: 'attested' as const };
    expect(() => UnsignedEnvelopeSchema.parse(env)).toThrow();
  });

  it('requires attestation when evidenceTier is attested', () => {
    const env = {
      ...baseEnv,
      evidenceTier: 'attested' as const,
      executor: {
        ...baseEnv.executor,
        signingKey: { kind: 'enclave-bound' as const, pubkey: baseEnv.executor.signingKey.pubkey },
        source: {
          bundleCid: 'bafy-src',
          sha256: 'ab'.repeat(32),
          buildRecipe: { kind: 'dockerfile' as const, path: 'Dockerfile' },
          measurement: '0x' + 'cc'.repeat(48),
        },
      },
      attestation: null,
    };
    expect(() => UnsignedEnvelopeSchema.parse(env)).toThrow();
  });

  it('artifact uses artifactType field (not role)', () => {
    const env = {
      ...baseEnv,
      artifacts: [
        {
          cid: 'bafy-art',
          artifactType: 'system_snapshot',
          sha256: 'cd'.repeat(32),
        },
      ],
    };
    expect(() => UnsignedEnvelopeSchema.parse(env)).not.toThrow();

    const envWithRole = {
      ...baseEnv,
      artifacts: [{ cid: 'bafy-art', role: 'system_snapshot' }],
    };
    expect(() => UnsignedEnvelopeSchema.parse(envWithRole)).toThrow();
  });
});

describe('SignedEnvelopeSchema', () => {
  const baseSigned = {
    schemaVersion: 'jinn.execution.v1' as const,
    kind: 'portfolio.v0',
    role: 'restoration' as const,
    generatedAt: 1700000000000,
    intent: {
      cid: 'bafy',
      onchainCreationTx: '0x' + 'ab'.repeat(32),
      onchainCreationBlock: 1,
      requestId: '0x' + 'cd'.repeat(32),
    },
    participant: {
      safeAddress: '0x1111111111111111111111111111111111111111',
      agentEoa: '0x2222222222222222222222222222222222222222',
    },
    window: { startTs: 1, endTs: 86400001 },
    executor: {
      implName: 'x',
      implVersion: '1',
      clientGitSha: 'a',
      codeDigest: 'sha256:' + 'ab'.repeat(32),
      signingKey: { kind: 'agent-eoa' as const, pubkey: '0x22' },
    },
    evidenceTier: 'self-signed' as const,
    attestation: null,
    trajectory: null,
    artifacts: [],
    payload: { preSnapshot: {}, postSnapshot: {}, fills: [], gating: {} },
    signature: {
      algo: 'secp256k1' as const,
      signer: '0x2222222222222222222222222222222222222222',
      hash: '0x' + 'ef'.repeat(32),
      sig: '0x' + '12'.repeat(65),
    },
  };

  it('accepts a signed envelope', () => {
    expect(() => SignedEnvelopeSchema.parse(baseSigned)).not.toThrow();
  });
});
