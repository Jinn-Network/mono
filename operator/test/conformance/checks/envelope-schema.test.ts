import { describe, it, expect, vi } from 'vitest';
import { checkEnvelopeSchema } from '../../../src/conformance/checks/envelope-schema.js';
import type { ConformanceContext } from '../../../src/conformance/types.js';
import { assembleAndSignEnvelope } from '../../../src/harnesses/engine/envelope-assembly.js';
import type { EnvelopeInputs, EnvelopeAssemblyDeps } from '../../../src/harnesses/engine/envelope-assembly.js';

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

async function buildGoodCtx(): Promise<Pick<ConformanceContext, 'envelope' | 'envelopeCid' | 'options'>> {
  const result = await assembleAndSignEnvelope(baseInputs, deps);
  return {
    envelope: result.envelope,
    envelopeCid: 'bafy-test',
    options: {},
  };
}

describe('checkEnvelopeSchema', () => {
  it('passes on a well-formed envelope', async () => {
    const ctx = await buildGoodCtx();
    const result = checkEnvelopeSchema(ctx as ConformanceContext);
    expect(result.passed).toBe(true);
    expect(result.id).toBe('envelope.schema');
    expect(result.layer).toBe(1);
  });

  it('fails when schemaVersion is wrong', async () => {
    const ctx = await buildGoodCtx();
    const bad = { ...ctx, envelope: { ...ctx.envelope!, schemaVersion: 'jinn.execution.v2' as any } };
    const result = checkEnvelopeSchema(bad as ConformanceContext);
    expect(result.passed).toBe(false);
    expect(result.detail).toMatch(/schemaVersion/);
  });

  it('fails when solverType is missing', async () => {
    const ctx = await buildGoodCtx();
    const { solverType: _solverType, ...noSolverType } = ctx.envelope!;
    const bad = { ...ctx, envelope: noSolverType as any };
    const result = checkEnvelopeSchema(bad as ConformanceContext);
    expect(result.passed).toBe(false);
  });

  it('fails when envelope is undefined', () => {
    const ctx: ConformanceContext = {
      envelopeCid: 'bafy-test',
      options: {},
    };
    const result = checkEnvelopeSchema(ctx);
    expect(result.passed).toBe(false);
    expect(result.detail).toMatch(/not loaded/);
  });
});
