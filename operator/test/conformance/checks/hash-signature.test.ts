import { describe, it, expect, vi } from 'vitest';
import { checkHashAndSignature } from '../../../src/conformance/checks/hash-signature.js';
import type { ConformanceContext } from '../../../src/conformance/types.js';
import { assembleAndSignEnvelope } from '../../../src/harnesses/engine/envelope-assembly.js';
import type { EnvelopeInputs, EnvelopeAssemblyDeps } from '../../../src/harnesses/engine/envelope-assembly.js';
import { signCanonical } from '../../../src/harnesses/engine/signing.js';
import { SignedEnvelopeSchema } from '../../../src/types/envelope.js';

vi.mock('../../../src/adapters/mech/ipfs.js', () => ({
  uploadToIpfs: vi.fn(async () => 'bafy-mock-cid'),
  cidToDigestHex: vi.fn().mockReturnValue('0xdeadbeef00000000000000000000000000000000000000000000000000000000'),
  fetchFromIpfs: vi.fn(),
  fetchFromDigest: vi.fn(),
  digestHexToGatewayUrl: vi.fn(),
}));

const TEST_PK: `0x${string}` = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const TEST_ADDRESS = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';

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
  payload: {
    preSnapshot: { capturedAt: 1, hlTime: 1, payload: {} },
    postSnapshot: { capturedAt: 2, hlTime: 2, payload: {} },
    fills: [],
    gating: {
      equityReturnPct: '0.05',
      maxDrawdownPct: '0.01',
      closedTradesCount: 25,
      tradedNotionalMultiple: '5.1',
    },
  },
  generatedAt: 1700000000000,
};

const deps: EnvelopeAssemblyDeps = {
  ipfsRegistryUrl: 'http://mock',
  agentEoaPrivateKey: TEST_PK,
};

async function buildGoodCtx(): Promise<ConformanceContext> {
  const result = await assembleAndSignEnvelope(baseInputs, deps);
  return {
    envelope: result.envelope,
    rawEnvelope: result.envelope,
    envelopeCid: 'bafy-test',
    options: {},
  };
}

async function buildLegacyRestorationCtx(): Promise<ConformanceContext> {
  const unsigned = {
    schemaVersion: 'jinn.execution.v1' as const,
    solverType: baseInputs.solverType,
    role: 'restoration' as const,
    generatedAt: baseInputs.generatedAt!,
    task: baseInputs.task,
    participant: baseInputs.participant,
    window: baseInputs.window,
    executor: { ...baseInputs.executor, mode: 'train' as const },
    evidenceTier: 'self-signed' as const,
    attestation: null,
    trajectory: null,
    artifacts: baseInputs.artifacts,
    payload: baseInputs.payload,
  };
  const signed = await signCanonical(unsigned, TEST_PK, TEST_ADDRESS);
  const envelope = SignedEnvelopeSchema.parse({
    ...unsigned,
    signature: {
      algo: 'secp256k1',
      signer: TEST_ADDRESS,
      hash: signed.hash,
      sig: signed.sig,
    },
  });

  return {
    envelope,
    envelopeCid: 'bafy-legacy-test',
    options: {},
  };
}

describe('checkHashAndSignature', () => {
  it('passes on a valid envelope with correct hash and signature', async () => {
    const ctx = await buildGoodCtx();
    const result = await checkHashAndSignature(ctx);
    expect(result.passed).toBe(true);
    expect(result.id).toBe('envelope.hash-signature');
    expect(result.layer).toBe(1);
  });

  it('passes on a legacy restoration envelope signed before role canonicalization', async () => {
    const ctx = await buildLegacyRestorationCtx();
    expect(ctx.envelope!.role).toBe('restoration');
    const result = await checkHashAndSignature(ctx);
    expect(result.passed).toBe(true);
  });

  it('fails when signature.hash does not match recomputed hash', async () => {
    const ctx = await buildGoodCtx();
    const bad: ConformanceContext = {
      ...ctx,
      envelope: {
        ...ctx.envelope!,
        signature: {
          ...ctx.envelope!.signature,
          hash: ('0x' + '00'.repeat(32)) as `0x${string}`,
        },
      },
    };
    const result = await checkHashAndSignature(bad);
    expect(result.passed).toBe(false);
    expect(result.detail).toMatch(/hash/i);
  });

  it('fails when a non-signature field is tampered (hash becomes stale)', async () => {
    const ctx = await buildGoodCtx();
    const bad: ConformanceContext = {
      ...ctx,
      envelope: {
        ...ctx.envelope!,
        generatedAt: ctx.envelope!.generatedAt + 1,
      },
      rawEnvelope: {
        ...ctx.rawEnvelope!,
        generatedAt: ctx.envelope!.generatedAt + 1,
      },
    };
    const result = await checkHashAndSignature(bad);
    expect(result.passed).toBe(false);
  });

  it('fails when signer does not match recovered address', async () => {
    const ctx = await buildGoodCtx();
    const bad: ConformanceContext = {
      ...ctx,
      envelope: {
        ...ctx.envelope!,
        signature: {
          ...ctx.envelope!.signature,
          signer: '0x0000000000000000000000000000000000000001' as `0x${string}`,
        },
      },
    };
    const result = await checkHashAndSignature(bad);
    expect(result.passed).toBe(false);
    expect(result.detail).toMatch(/signer/i);
  });

  it('fails when sig is malformed', async () => {
    const ctx = await buildGoodCtx();
    const bad: ConformanceContext = {
      ...ctx,
      envelope: {
        ...ctx.envelope!,
        signature: {
          ...ctx.envelope!.signature,
          sig: '0xbeef' as `0x${string}`,
        },
      },
    };
    const result = await checkHashAndSignature(bad);
    expect(result.passed).toBe(false);
  });

  it('fails when envelope is not loaded', async () => {
    const ctx: ConformanceContext = {
      envelopeCid: 'bafy-test',
      options: {},
    };
    const result = await checkHashAndSignature(ctx);
    expect(result.passed).toBe(false);
    expect(result.detail).toMatch(/not loaded/);
  });
});
