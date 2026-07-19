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
    solverType: 'portfolio.v0',
    role: 'solution',
    generatedAt: 1700000000000,
    task: {
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
      runtimeBundleDigest: 'sha256:' + 'bc'.repeat(32),
      plugins: [],
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

  it('accepts a well-formed solution envelope', () => {
    expect(() => UnsignedEnvelopeSchema.parse(baseEnv)).not.toThrow();
  });

  it('normalizes legacy restoration envelopes to solution on read', () => {
    const parsed = UnsignedEnvelopeSchema.parse({ ...baseEnv, role: 'restoration' });
    expect(parsed.role).toBe('solution');
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
          artifactType: 'system_snapshot',
          sha256: 'cd'.repeat(32),
          access: { endpoint: 'https://op.example.com', priceUsdc: '0' },
        },
      ],
    };
    expect(() => UnsignedEnvelopeSchema.parse(env)).not.toThrow();

    const envWithRole = {
      ...baseEnv,
      artifacts: [{ role: 'system_snapshot', sha256: 'cd'.repeat(32) }],
    };
    expect(() => UnsignedEnvelopeSchema.parse(envWithRole)).toThrow();
  });
});

describe('SignedEnvelopeSchema', () => {
  const baseSigned = {
    schemaVersion: 'jinn.execution.v1' as const,
    solverType: 'portfolio.v0',
    role: 'solution' as const,
    generatedAt: 1700000000000,
    task: {
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
      runtimeBundleDigest: 'sha256:' + 'bc'.repeat(32),
      plugins: [],
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

  it('preserves signed legacy restoration envelopes for hash verification', () => {
    const parsed = SignedEnvelopeSchema.parse({ ...baseSigned, role: 'restoration' });
    expect(parsed.role).toBe('restoration');
  });

  describe('executor.model (jinn-mono-gbut, gh#191)', () => {
    it('accepts envelope with executor.model set', () => {
      const env = {
        ...baseSigned,
        executor: { ...baseSigned.executor, model: 'claude-haiku-4-5-20251001' },
      };
      const parsed = SignedEnvelopeSchema.parse(env);
      expect(parsed.executor.model).toBe('claude-haiku-4-5-20251001');
    });

    it('accepts envelope without executor.model (back-compat)', () => {
      // baseSigned has no model field — must parse cleanly
      const parsed = SignedEnvelopeSchema.parse(baseSigned);
      expect(parsed.executor.model).toBeUndefined();
    });

    it('does not coerce missing executor.model to empty string', () => {
      const parsed = SignedEnvelopeSchema.parse(baseSigned);
      expect(parsed.executor.model).not.toBe('');
    });
  });

  describe('generatorModel / distributionClass / task.createdAt / instanceId (#1827)', () => {
    it('accepts executor.generatorModel with source="stream"', () => {
      const envelope = {
        ...baseSigned,
        executor: {
          ...baseSigned.executor,
          generatorModel: {
            id: 'claude-sonnet-4-6',
            provider: 'anthropic',
            source: 'stream' as const,
          },
        },
      };
      const parsed = SignedEnvelopeSchema.parse(envelope);
      expect(parsed.executor.generatorModel).toEqual({
        id: 'claude-sonnet-4-6',
        provider: 'anthropic',
        source: 'stream',
      });
    });

    it('accepts executor.generatorModel with source="config" and no provider/openWeights', () => {
      const envelope = {
        ...baseSigned,
        executor: {
          ...baseSigned.executor,
          generatorModel: { id: 'claude-haiku-4-5-20251001', source: 'config' as const },
        },
      };
      const parsed = SignedEnvelopeSchema.parse(envelope);
      expect(parsed.executor.generatorModel).toEqual({
        id: 'claude-haiku-4-5-20251001',
        source: 'config',
      });
    });

    it('rejects executor.generatorModel with an invalid source value', () => {
      const envelope = {
        ...baseSigned,
        executor: {
          ...baseSigned.executor,
          generatorModel: { id: 'x', source: 'guess' },
        },
      };
      expect(() => SignedEnvelopeSchema.parse(envelope)).toThrow();
    });

    it('accepts envelope without executor.generatorModel (back-compat)', () => {
      const parsed = SignedEnvelopeSchema.parse(baseSigned);
      expect(parsed.executor.generatorModel).toBeUndefined();
    });

    it('accepts top-level distributionClass "open" | "restricted-tos" | "unknown"', () => {
      for (const distributionClass of ['open', 'restricted-tos', 'unknown'] as const) {
        const parsed = SignedEnvelopeSchema.parse({ ...baseSigned, distributionClass });
        expect(parsed.distributionClass).toBe(distributionClass);
      }
    });

    it('rejects an invalid distributionClass value', () => {
      expect(() => SignedEnvelopeSchema.parse({ ...baseSigned, distributionClass: 'proprietary' })).toThrow();
    });

    it('accepts envelope without distributionClass (back-compat)', () => {
      const parsed = SignedEnvelopeSchema.parse(baseSigned);
      expect(parsed.distributionClass).toBeUndefined();
    });

    it('accepts task.createdAt / task.instanceId / task.repo / task.baseCommit', () => {
      const envelope = {
        ...baseSigned,
        task: {
          ...baseSigned.task,
          createdAt: 1752000000,
          instanceId: 'astropy__astropy-12907',
          repo: 'astropy/astropy',
          baseCommit: 'abc123def456',
        },
      };
      const parsed = SignedEnvelopeSchema.parse(envelope);
      expect(parsed.task).toMatchObject({
        createdAt: 1752000000,
        instanceId: 'astropy__astropy-12907',
        repo: 'astropy/astropy',
        baseCommit: 'abc123def456',
      });
    });

    it('accepts envelope without task.createdAt/instanceId/repo/baseCommit (back-compat)', () => {
      const parsed = SignedEnvelopeSchema.parse(baseSigned);
      expect(parsed.task?.createdAt).toBeUndefined();
      expect(parsed.task?.instanceId).toBeUndefined();
    });
  });
});
