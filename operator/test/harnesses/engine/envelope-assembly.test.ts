import { describe, it, expect, vi } from 'vitest';
import { assembleAndSignEnvelope } from '../../../src/harnesses/engine/envelope-assembly.js';
import { SignedEnvelopeSchema } from '../../../src/types/envelope.js';
import type { EnvelopeInputs, EnvelopeAssemblyDeps } from '../../../src/harnesses/engine/envelope-assembly.js';

// Mock uploadToIpfs to avoid real network
vi.mock('../../../src/adapters/mech/ipfs.js', () => ({
  uploadToIpfs: vi.fn(async () => 'bafy-mock-cid'),
  cidToDigestHex: vi.fn().mockReturnValue('0xdeadbeef00000000000000000000000000000000000000000000000000000000'),
  fetchFromIpfs: vi.fn(),
  fetchFromDigest: vi.fn(),
  digestHexToGatewayUrl: vi.fn(),
}));

// Use the foundry default test account #0 private key and its corresponding address.
const TEST_PK: `0x${string}` = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const TEST_ADDRESS = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';

const validPortfolioSolutionPayload = {
  preSnapshot: { capturedAt: 1, hlTime: 1, payload: {} },
  postSnapshot: { capturedAt: 2, hlTime: 2, payload: {} },
  fills: [],
  gating: {
    equityReturnPct: '0.05',
    maxDrawdownPct: '0.01',
    closedTradesCount: 25,
    tradedNotionalMultiple: '5.1',
  },
};

const baseInputs: EnvelopeInputs = {
  solverType: 'portfolio.v0',
  role: 'solution',
  task: {
    cid: 'bafy-task',
    onchainCreationTx: '0x' + 'ab'.repeat(32),
    onchainCreationBlock: 100,
    requestId: '0x' + 'cd'.repeat(32),
  },
  participant: {
    safeAddress: TEST_ADDRESS,
    agentEoa: TEST_ADDRESS,
  },
  window: { startTs: 1, endTs: 86400001 },
  executor: {
    implName: 'claude-mcp-hyperliquid',
    implVersion: '1.0.0',
    clientGitSha: 'abc123',
    codeDigest: 'sha256:' + 'ab'.repeat(32),
    runtimeBundleDigest: 'sha256:' + 'bc'.repeat(32),
    plugins: [],
    signingKey: {
      kind: 'agent-eoa',
      pubkey: TEST_ADDRESS,
    },
  },
  artifacts: [],
  payload: validPortfolioSolutionPayload,
  generatedAt: 1700000000000,
};

const deps: EnvelopeAssemblyDeps = {
  ipfsRegistryUrl: 'http://mock',
  agentEoaPrivateKey: TEST_PK,
};

describe('assembleAndSignEnvelope', () => {
  it('returns { envelope, envelopeCid, envelopeHash } shape', async () => {
    const result = await assembleAndSignEnvelope(baseInputs, deps);
    expect(result.envelope).toBeDefined();
    expect(result.envelopeCid).toBe('bafy-mock-cid');
    expect(result.envelopeHash).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('produces an envelope that passes SignedEnvelopeSchema', async () => {
    const result = await assembleAndSignEnvelope(baseInputs, deps);
    expect(() => SignedEnvelopeSchema.parse(result.envelope)).not.toThrow();
  });

  it('envelope.signature.hash equals envelopeHash', async () => {
    const result = await assembleAndSignEnvelope(baseInputs, deps);
    expect(result.envelope.signature.hash).toBe(result.envelopeHash);
  });

  it('defaults evidenceTier to self-signed', async () => {
    const result = await assembleAndSignEnvelope(baseInputs, deps);
    expect(result.envelope.evidenceTier).toBe('self-signed');
  });

  it('normalizes legacy restoration input to canonical solution before signing', async () => {
    const result = await assembleAndSignEnvelope(baseInputs, deps);
    expect(result.envelope.role).toBe('solution');
  });

  it('defaults attestation and trajectory to null', async () => {
    const result = await assembleAndSignEnvelope(baseInputs, deps);
    expect(result.envelope.attestation).toBeNull();
    expect(result.envelope.trajectory).toBeNull();
  });

  it('throws when payload does not match (kind, role) schema', async () => {
    const bad: EnvelopeInputs = {
      ...baseInputs,
      payload: { bogus: true }, // not a valid portfolio.v0 restoration payload
    };
    await expect(assembleAndSignEnvelope(bad, deps)).rejects.toThrow();
  });

  it('accepts verdict role with verdict payload', async () => {
    const verdictPayload = {
      solutionEnvelope: {
        cid: 'bafy-solution',
        sha256: 'ab'.repeat(32),
      },
      verificationOfRestoration: {
        claimedTier: 'self-signed' as const,
        sdkVersion: '1.0.0',
        timestamp: 1,
        checks: [{ name: 'sig', passed: true }],
        overall: 'valid' as const,
      },
      verdict: 'PASS' as const,
      score: '0.95',
      scoreBasis: 'equityReturnPct',
      scoreVersion: '1',
      rederived: {
        preSnapshot: { capturedAt: 1, payload: {} },
        postSnapshot: { capturedAt: 2, payload: {} },
        fills: [],
        gating: {},
      },
      claimed: {
        preSnapshot: { capturedAt: 1, payload: {} },
        postSnapshot: { capturedAt: 2, payload: {} },
        fillsHash: '0xff',
        fillsCount: 0,
        gating: {},
      },
      checks: [],
    };
    const verdictInputs: EnvelopeInputs = {
      ...baseInputs,
      role: 'verdict',
      payload: verdictPayload,
    };
    const result = await assembleAndSignEnvelope(verdictInputs, deps);
    expect(result.envelope.role).toBe('verdict');
    expect(() => SignedEnvelopeSchema.parse(result.envelope)).not.toThrow();
  });

  it('uses caller-supplied generatedAt for determinism', async () => {
    const result1 = await assembleAndSignEnvelope(baseInputs, deps);
    const result2 = await assembleAndSignEnvelope(baseInputs, deps);
    // Same generatedAt → same envelopeHash (canonical JSON is deterministic)
    expect(result1.envelopeHash).toBe(result2.envelopeHash);
  });

  it('envelope.schemaVersion is jinn.execution.v1', async () => {
    const result = await assembleAndSignEnvelope(baseInputs, deps);
    expect(result.envelope.schemaVersion).toBe('jinn.execution.v1');
  });

  describe('executor.model stamping (jinn-mono-gbut, gh#191)', () => {
    it('stamps executor.model when inputs.executor.model is provided', async () => {
      const inputs: EnvelopeInputs = {
        ...baseInputs,
        executor: { ...baseInputs.executor, model: 'claude-haiku-4-5-20251001' },
      };
      const result = await assembleAndSignEnvelope(inputs, deps);
      expect(result.envelope.executor.model).toBe('claude-haiku-4-5-20251001');
      expect(() => SignedEnvelopeSchema.parse(result.envelope)).not.toThrow();
    });

    it('leaves executor.model undefined when inputs.executor.model is absent', async () => {
      // baseInputs.executor has no model field
      const result = await assembleAndSignEnvelope(baseInputs, deps);
      expect(result.envelope.executor.model).toBeUndefined();
      expect(() => SignedEnvelopeSchema.parse(result.envelope)).not.toThrow();
    });

    it('does not stamp empty string when model is undefined', async () => {
      const result = await assembleAndSignEnvelope(baseInputs, deps);
      expect(result.envelope.executor.model).not.toBe('');
    });
  });
});

describe('assembleAndSignEnvelope — generatorModel / distributionClass / task provenance (#1827)', () => {
  it('stamps distributionClass="restricted-tos" when executor.generatorModel.provider is anthropic', async () => {
    const inputs: EnvelopeInputs = {
      ...baseInputs,
      executor: {
        ...baseInputs.executor,
        generatorModel: { id: 'claude-sonnet-4-6', provider: 'anthropic', source: 'stream' },
      },
    };
    const { envelope } = await assembleAndSignEnvelope(inputs, deps);
    expect(envelope.distributionClass).toBe('restricted-tos');
    expect(envelope.executor.generatorModel).toEqual({ id: 'claude-sonnet-4-6', provider: 'anthropic', source: 'stream' });
  });

  it('stamps distributionClass="unknown" when executor.generatorModel is absent', async () => {
    const { envelope } = await assembleAndSignEnvelope(baseInputs, deps);
    expect(envelope.distributionClass).toBe('unknown');
    expect(envelope.executor.generatorModel).toBeUndefined();
  });

  it('threads task.createdAt / instanceId / repo / baseCommit through to the signed envelope', async () => {
    const inputs: EnvelopeInputs = {
      ...baseInputs,
      task: {
        ...baseInputs.task,
        createdAt: 1752000000,
        instanceId: 'astropy__astropy-12907',
        repo: 'astropy/astropy',
        baseCommit: 'abc123def456',
      },
    };
    const { envelope } = await assembleAndSignEnvelope(inputs, deps);
    expect(envelope.task).toMatchObject({
      createdAt: 1752000000,
      instanceId: 'astropy__astropy-12907',
      repo: 'astropy/astropy',
      baseCommit: 'abc123def456',
    });
  });

  it('produces an envelope that still passes SignedEnvelopeSchema with all four new fields set', async () => {
    const inputs: EnvelopeInputs = {
      ...baseInputs,
      task: { ...baseInputs.task, createdAt: 1752000000, instanceId: 'x', repo: 'y/z', baseCommit: 'abc' },
      executor: { ...baseInputs.executor, generatorModel: { id: 'claude-sonnet-4-6', provider: 'anthropic', source: 'stream' } },
    };
    const { envelope } = await assembleAndSignEnvelope(inputs, deps);
    expect(() => SignedEnvelopeSchema.parse(envelope)).not.toThrow();
  });

  it('omits task.createdAt/instanceId/repo/baseCommit when not supplied (no fabricated defaults)', async () => {
    const { envelope } = await assembleAndSignEnvelope(baseInputs, deps);
    expect((envelope.task as { createdAt?: unknown }).createdAt).toBeUndefined();
    expect((envelope.task as { instanceId?: unknown }).instanceId).toBeUndefined();
  });
});
