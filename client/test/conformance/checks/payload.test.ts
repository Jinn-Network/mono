import { describe, it, expect, vi } from 'vitest';
import { checkPayload } from '../../../src/conformance/checks/payload.js';
import type { ConformanceContext } from '../../../src/conformance/types.js';
import { assembleAndSignEnvelope } from '../../../src/restorer/engine/envelope-assembly.js';
import type { EnvelopeInputs, EnvelopeAssemblyDeps } from '../../../src/restorer/engine/envelope-assembly.js';

vi.mock('../../../src/adapters/mech/ipfs.js', () => ({
  uploadToIpfs: vi.fn(async () => 'bafy-mock-cid'),
  cidToDigestHex: vi.fn().mockReturnValue('0xdeadbeef00000000000000000000000000000000000000000000000000000000'),
  fetchFromIpfs: vi.fn(),
  fetchFromDigest: vi.fn(),
  digestHexToGatewayUrl: vi.fn(),
}));

const TEST_PK: `0x${string}` = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const TEST_ADDRESS = '0x71bE63f3384f5fb98995898A86B02Fb2426c5788';

const baseInputs: EnvelopeInputs = {
  kind: 'portfolio.v0',
  role: 'restoration',
  intent: {
    cid: 'bafy-intent',
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
    envelopeCid: 'bafy-test',
    options: {},
  };
}

describe('checkPayload', () => {
  it('passes when payload parses against KIND_PAYLOADS[kind][role]', async () => {
    const ctx = await buildGoodCtx();
    const result = checkPayload(ctx);
    expect(result.passed).toBe(true);
    expect(result.id).toBe('envelope.payload');
    expect(result.layer).toBe(1);
  });

  it('fails when payload is malformed for the declared kind+role', async () => {
    const ctx = await buildGoodCtx();
    const bad: ConformanceContext = {
      ...ctx,
      envelope: { ...ctx.envelope!, payload: { bogus: 'data' } },
    };
    const result = checkPayload(bad);
    expect(result.passed).toBe(false);
    expect(result.detail).toBeTruthy();
  });

  it('fails when kind is not in KIND_PAYLOADS registry', async () => {
    const ctx = await buildGoodCtx();
    const bad: ConformanceContext = {
      ...ctx,
      envelope: { ...ctx.envelope!, kind: 'unknown.kind' },
    };
    const result = checkPayload(bad);
    expect(result.passed).toBe(false);
    expect(result.detail).toMatch(/unknown/i);
  });

  it('fails when envelope is not loaded', () => {
    const ctx: ConformanceContext = {
      envelopeCid: 'bafy-test',
      options: {},
    };
    const result = checkPayload(ctx);
    expect(result.passed).toBe(false);
    expect(result.detail).toMatch(/not loaded/);
  });

  it('fails when role has no schema in KIND_PAYLOADS', async () => {
    const ctx = await buildGoodCtx();
    const bad: ConformanceContext = {
      ...ctx,
      envelope: { ...ctx.envelope!, role: 'verdict' as any, kind: 'unknown.kind' },
    };
    const result = checkPayload(bad);
    expect(result.passed).toBe(false);
  });
});
