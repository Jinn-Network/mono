/**
 * Tests for IdentityPublisher (jinn-mono-3zk).
 *
 * Cross-checks the encoder against the normative test vectors in
 * `docs/superpowers/specs/2026-04-27-erc-8004-payload-schema.md` §8 and
 * exercises the strict-mode validity rules from §5.
 */

import { describe, it, expect, vi } from 'vitest';
import { decodeFunctionData, type Hex, type PublicClient, type WalletClient } from 'viem';
import {
  IdentityPublisher,
  IDENTITY_REGISTRY_SET_METADATA_ABI,
  PayloadValidationError,
  buildMetadataKey,
  contentKindForAnchor,
  parseMetadataKey,
  encodeExecutionPayload,
  encodeExecutionPayloadV2,
  validatePayload,
  type ExecutionPayload,
  type ExecutionPayloadV2,
} from '../../src/erc8004/identity.js';

/**
 * Decode the calldata of a `setMetadata` send-tx mock call back to the
 * `{ address, functionName, args }` shape the assertions check.
 *
 * IdentityPublisher now routes setMetadata through
 * `viemSendTransactionWithRetry` (per-EOA broadcast lock + nonce ledger, the
 * #525 nonce-collision fix), so the calldata arrives ABI-encoded in `data`
 * rather than as discrete `writeContract` args.
 */
function decodeSetMetadataCall(call: { to: Hex; data: Hex }): {
  address: string;
  functionName: string;
  args: readonly [bigint, string, Hex];
} {
  const decoded = decodeFunctionData({
    abi: IDENTITY_REGISTRY_SET_METADATA_ABI,
    data: call.data,
  });
  return {
    address: call.to,
    functionName: decoded.functionName,
    args: decoded.args as unknown as readonly [bigint, string, Hex],
  };
}

// ── Spec test vectors (payload-schema §8) ─────────────────────────────────────

const VECTOR_A_INPUT: ExecutionPayload = {
  version: 1,
  tier: 0,
  manifestHash: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  attestationQuoteCid: '0x',
  sourceMeasurement: '0x0000000000000000000000000000000000000000000000000000000000000000',
};
const VECTOR_A_EXPECTED: Hex =
  ('0x' +
    '0000000000000000000000000000000000000000000000000000000000000001' +
    '0000000000000000000000000000000000000000000000000000000000000000' +
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' +
    '00000000000000000000000000000000000000000000000000000000000000a0' +
    '0000000000000000000000000000000000000000000000000000000000000000' +
    '0000000000000000000000000000000000000000000000000000000000000000') as Hex;

const VECTOR_B_INPUT: ExecutionPayload = {
  version: 1,
  tier: 1,
  manifestHash: '0x1111111111111111111111111111111111111111111111111111111111111111',
  attestationQuoteCid: '0x',
  sourceMeasurement: '0x0000000000000000000000000000000000000000000000000000000000000000',
};
const VECTOR_B_EXPECTED: Hex =
  ('0x' +
    '0000000000000000000000000000000000000000000000000000000000000001' +
    '0000000000000000000000000000000000000000000000000000000000000001' +
    '1111111111111111111111111111111111111111111111111111111111111111' +
    '00000000000000000000000000000000000000000000000000000000000000a0' +
    '0000000000000000000000000000000000000000000000000000000000000000' +
    '0000000000000000000000000000000000000000000000000000000000000000') as Hex;

const VECTOR_C_INPUT: ExecutionPayload = {
  version: 1,
  tier: 3,
  manifestHash: '0x2222222222222222222222222222222222222222222222222222222222222222',
  attestationQuoteCid: '0x01701220c3c4733ec8affd06cf9e9ff50ffc6bcd2ec85a6170004bb709669c31de94391a',
  sourceMeasurement: '0x3333333333333333333333333333333333333333333333333333333333333333',
};
const VECTOR_C_EXPECTED: Hex =
  ('0x' +
    '0000000000000000000000000000000000000000000000000000000000000001' +
    '0000000000000000000000000000000000000000000000000000000000000003' +
    '2222222222222222222222222222222222222222222222222222222222222222' +
    '00000000000000000000000000000000000000000000000000000000000000a0' +
    '3333333333333333333333333333333333333333333333333333333333333333' +
    '0000000000000000000000000000000000000000000000000000000000000024' +
    '01701220c3c4733ec8affd06cf9e9ff50ffc6bcd2ec85a6170004bb709669c31' +
    'de94391a00000000000000000000000000000000000000000000000000000000') as Hex;

// ── Encoder tests ─────────────────────────────────────────────────────────────

describe('encodeExecutionPayload — spec test vectors', () => {
  it('Vector A: tier=self-signed envelope encodes to 192 bytes matching spec §8.1', () => {
    const encoded = encodeExecutionPayload(VECTOR_A_INPUT);
    expect(encoded).toBe(VECTOR_A_EXPECTED);
    // 0x + 384 hex chars = 192 bytes
    expect(encoded.length).toBe(2 + 192 * 2);
  });

  it('Vector B: tier=committed envelope encodes to 192 bytes matching spec §8.2', () => {
    const encoded = encodeExecutionPayload(VECTOR_B_INPUT);
    expect(encoded).toBe(VECTOR_B_EXPECTED);
    expect(encoded.length).toBe(2 + 192 * 2);
  });

  it('Vector C: tier=attested envelope with 36-byte CIDv1 encodes to 256 bytes matching spec §8.3', () => {
    const encoded = encodeExecutionPayload(VECTOR_C_INPUT);
    expect(encoded).toBe(VECTOR_C_EXPECTED);
    // 0x + 512 hex chars = 256 bytes
    expect(encoded.length).toBe(2 + 256 * 2);
  });
});

// ── Validation tests (payload-schema §5 strict mode) ──────────────────────────

describe('validatePayload — strict-mode tier rules', () => {
  it('accepts tier 0 with empty quote and zero measurement', () => {
    expect(() => validatePayload(VECTOR_A_INPUT)).not.toThrow();
  });

  it('accepts tier 1 with empty quote and zero measurement', () => {
    expect(() => validatePayload(VECTOR_B_INPUT)).not.toThrow();
  });

  it('rejects tier 2 (consensus) — V2+ only in V1 schema', () => {
    expect(() =>
      validatePayload({
        ...VECTOR_A_INPUT,
        // @ts-expect-error — tier 2 is intentionally excluded from ExecutionTier
        tier: 2,
      }),
    ).toThrow(PayloadValidationError);
  });

  it('accepts tier 3 with non-empty quote and non-zero measurement', () => {
    expect(() => validatePayload(VECTOR_C_INPUT)).not.toThrow();
  });

  it('rejects tier 4 (proved) — V2+ only in V1 schema', () => {
    expect(() =>
      validatePayload({
        ...VECTOR_C_INPUT,
        // @ts-expect-error — tier 4 is intentionally excluded from ExecutionTier
        tier: 4,
      }),
    ).toThrow(PayloadValidationError);
  });

  it('rejects tier 0 with non-empty attestationQuoteCid (PayloadValidationError)', () => {
    expect(() =>
      validatePayload({
        ...VECTOR_A_INPUT,
        attestationQuoteCid: '0xdeadbeef',
      }),
    ).toThrow(PayloadValidationError);
  });

  it('rejects tier 0 with non-zero sourceMeasurement', () => {
    expect(() =>
      validatePayload({
        ...VECTOR_A_INPUT,
        sourceMeasurement:
          '0x1111111111111111111111111111111111111111111111111111111111111111',
      }),
    ).toThrow(PayloadValidationError);
  });

  it('rejects tier 1 with non-empty attestationQuoteCid', () => {
    expect(() =>
      validatePayload({
        ...VECTOR_B_INPUT,
        attestationQuoteCid: '0xdeadbeef',
      }),
    ).toThrow(PayloadValidationError);
  });

  it('rejects tier 3 with empty attestationQuoteCid', () => {
    expect(() =>
      validatePayload({
        ...VECTOR_C_INPUT,
        attestationQuoteCid: '0x',
      }),
    ).toThrow(PayloadValidationError);
  });

  it('rejects tier 3 with zero sourceMeasurement', () => {
    expect(() =>
      validatePayload({
        ...VECTOR_C_INPUT,
        sourceMeasurement:
          '0x0000000000000000000000000000000000000000000000000000000000000000',
      }),
    ).toThrow(PayloadValidationError);
  });

  it('rejects malformed manifestHash', () => {
    expect(() =>
      validatePayload({
        ...VECTOR_A_INPUT,
        // 31-byte hex (62 chars after 0x)
        manifestHash: '0x' + 'aa'.repeat(31) as Hex,
      }),
    ).toThrow(PayloadValidationError);
  });

  it('rejects malformed sourceMeasurement', () => {
    expect(() =>
      validatePayload({
        ...VECTOR_A_INPUT,
        sourceMeasurement: '0x00' as Hex,
      }),
    ).toThrow(PayloadValidationError);
  });

  it('rejects out-of-range tier', () => {
    expect(() =>
      validatePayload({
        ...VECTOR_A_INPUT,
        tier: 5 as unknown as 0,
      }),
    ).toThrow(PayloadValidationError);
  });

  it('encodeExecutionPayload also throws PayloadValidationError on mismatch', () => {
    expect(() =>
      encodeExecutionPayload({
        ...VECTOR_A_INPUT,
        attestationQuoteCid: '0xdeadbeef',
      }),
    ).toThrow(PayloadValidationError);
  });
});

// ── Metadata key helper ───────────────────────────────────────────────────────

describe('buildMetadataKey', () => {
  it('builds envelope key as "envelope:<cid>"', () => {
    expect(buildMetadataKey('envelope', 'bafyreigh2akiscaildc'))
      .toBe('envelope:bafyreigh2akiscaildc');
  });

  it('builds evaluation key as "evaluation:<cid>"', () => {
    expect(buildMetadataKey('evaluation', 'bafyverdict001'))
      .toBe('evaluation:bafyverdict001');
  });

  it('builds skill key as "skill:<cid>"', () => {
    expect(buildMetadataKey('skill', 'bafyskill001'))
      .toBe('skill:bafyskill001');
  });
});

describe('parseMetadataKey', () => {
  it('parses skill keys', () => {
    expect(parseMetadataKey('skill:bafyskill001')).toEqual({
      kind: 'skill',
      cid: 'bafyskill001',
    });
  });

  it('rejects unknown kinds', () => {
    expect(parseMetadataKey('plugin:bafyplugin')).toBeNull();
  });
});

describe('contentKindForAnchor', () => {
  it('returns skill for skill metadata keys', () => {
    expect(contentKindForAnchor('skill:bafyskill001', 'bafyskill001')).toBe('skill');
  });

  it('rejects cid mismatch', () => {
    expect(() => contentKindForAnchor('skill:bafy-a', 'bafy-b')).toThrow(/does not match/);
  });
});

// ── publishContent — calldata + lifecycle ─────────────────────────────────────

function makeMocks(overrides?: {
  sendTransactionImpl?: (...args: unknown[]) => Promise<Hex>;
  waitImpl?: (...args: unknown[]) => Promise<unknown>;
}) {
  const sendTransaction = vi
    .fn<[unknown], Promise<Hex>>()
    .mockImplementation(
      overrides?.sendTransactionImpl as (...args: unknown[]) => Promise<Hex> ??
        (() => Promise.resolve('0xfeedfeedfeedfeedfeedfeedfeedfeedfeedfeedfeedfeedfeedfeedfeedfeed' as Hex)),
    );
  const waitForTransactionReceipt = vi.fn().mockImplementation(
    overrides?.waitImpl ?? (() => Promise.resolve({ status: 'success' })),
  );

  const account = { address: '0x1111111111111111111111111111111111111111' } as const;
  const chain = { id: 8453, name: 'base' } as const;
  const walletClient = {
    account,
    chain,
    sendTransaction,
  } as unknown as WalletClient;
  // The publicClient methods below back viemSendTransactionWithRetry's nonce
  // ledger + fee estimation. getTransactionCount returns a stable value so the
  // first attempt's pinned nonce is deterministic and stuck-nonce recovery is a
  // no-op (pending === latest).
  const publicClient = {
    waitForTransactionReceipt,
    getChainId: vi.fn().mockResolvedValue(8453),
    getTransactionCount: vi.fn().mockResolvedValue(0),
    estimateFeesPerGas: vi.fn().mockResolvedValue({
      maxFeePerGas: 100n,
      maxPriorityFeePerGas: 10n,
    }),
    getGasPrice: vi.fn().mockResolvedValue(50n),
  } as unknown as PublicClient;
  return { walletClient, publicClient, sendTransaction, waitForTransactionReceipt };
}

describe('IdentityPublisher.publishContent', () => {
  const REGISTRY = '0x8004800480048004800480048004800480048004' as `0x${string}`;
  const AGENT_ID = 42n;

  it('calls setMetadata with correct address, args, and ABI-encoded value', async () => {
    const { walletClient, publicClient, sendTransaction, waitForTransactionReceipt } = makeMocks();

    const publisher = new IdentityPublisher({
      identityRegistryAddress: REGISTRY,
      agentId: AGENT_ID,
      walletClient,
      publicClient,
    });

    const cid = 'bafyreienvelope001';
    const { txHash } = await publisher.publishContent({
      kind: 'envelope',
      cid,
      payload: VECTOR_B_INPUT,
    });

    expect(txHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(sendTransaction).toHaveBeenCalledTimes(1);
    expect(waitForTransactionReceipt).toHaveBeenCalledTimes(1);

    const call = decodeSetMetadataCall(sendTransaction.mock.calls[0]![0] as { to: Hex; data: Hex });
    expect(call.address).toBe(REGISTRY);
    expect(call.functionName).toBe('setMetadata');
    expect(call.args[0]).toBe(AGENT_ID);
    expect(call.args[1]).toBe(`envelope:${cid}`);
    expect(call.args[2]).toBe(VECTOR_B_EXPECTED);
  });

  it('uses "evaluation:" prefix when kind=evaluation', async () => {
    const { walletClient, publicClient, sendTransaction } = makeMocks();
    const publisher = new IdentityPublisher({
      identityRegistryAddress: REGISTRY,
      agentId: AGENT_ID,
      walletClient,
      publicClient,
    });

    await publisher.publishContent({
      kind: 'evaluation',
      cid: 'bafyverdict002',
      payload: VECTOR_A_INPUT,
    });

    const call = decodeSetMetadataCall(sendTransaction.mock.calls[0]![0] as { to: Hex; data: Hex });
    expect(call.args[1]).toBe('evaluation:bafyverdict002');
    expect(call.args[2]).toBe(VECTOR_A_EXPECTED);
  });

  it('journals v1 broadcasts and fails closed on a reverted required receipt', async () => {
    const { walletClient, publicClient } = makeMocks({
      waitImpl: () => Promise.resolve({ status: 'reverted' }),
    });
    const publisher = new IdentityPublisher({
      identityRegistryAddress: REGISTRY,
      agentId: AGENT_ID,
      walletClient,
      publicClient,
    });
    const onBroadcast = vi.fn();

    await expect(publisher.publishContent({
      kind: 'envelope',
      cid: 'bafy-required-receipt',
      payload: VECTOR_A_INPUT,
      requireSuccessfulReceipt: true,
      onBroadcast,
    })).rejects.toThrow('manifest receipt reverted');

    expect(onBroadcast).toHaveBeenCalledOnce();
    expect(onBroadcast).toHaveBeenCalledWith(
      '0xfeedfeedfeedfeedfeedfeedfeedfeedfeedfeedfeedfeedfeedfeedfeedfeed',
    );
  });

  it('propagates PayloadValidationError on bad payload (no contract call)', async () => {
    const { walletClient, publicClient, sendTransaction } = makeMocks();
    const publisher = new IdentityPublisher({
      identityRegistryAddress: REGISTRY,
      agentId: AGENT_ID,
      walletClient,
      publicClient,
    });

    await expect(
      publisher.publishContent({
        kind: 'envelope',
        cid: 'bafy123',
        payload: {
          ...VECTOR_A_INPUT,
          // tier 0 but with quote bytes — strict-mode mismatch
          attestationQuoteCid: '0xdeadbeef',
        },
      }),
    ).rejects.toBeInstanceOf(PayloadValidationError);

    expect(sendTransaction).not.toHaveBeenCalled();
  });

  it('propagates send-transaction errors to the caller', async () => {
    const { walletClient, publicClient } = makeMocks({
      // A non-recoverable error so the retry wrapper surfaces it immediately
      // rather than burning the retry budget on a transient classification.
      sendTransactionImpl: () => Promise.reject(new Error('insufficient funds: rpc unreachable')),
    });
    const publisher = new IdentityPublisher({
      identityRegistryAddress: REGISTRY,
      agentId: AGENT_ID,
      walletClient,
      publicClient,
    });

    await expect(
      publisher.publishContent({
        kind: 'envelope',
        cid: 'bafy123',
        payload: VECTOR_A_INPUT,
      }),
    ).rejects.toThrow('rpc unreachable');
  });
});

// ── publishContentV2 — kind-prefix calldata ───────────────────────────────────

const V2_VECTOR_INPUT: ExecutionPayloadV2 = {
  version: 2,
  tier: 1,
  manifestHash: '0x1111111111111111111111111111111111111111111111111111111111111111',
  attestationQuoteCid: '0x',
  sourceMeasurement: '0x0000000000000000000000000000000000000000000000000000000000000000',
  codeDigest: ('0x' + 'cd'.repeat(32)) as Hex,
  implName: 'claude-code-learner',
  modeFlag: 0,
};

describe('IdentityPublisher.publishContentV2', () => {
  const REGISTRY = '0x8004800480048004800480048004800480048004' as `0x${string}`;
  const AGENT_ID = 42n;

  it('uses "evaluation:" prefix when kind=evaluation (jinn-mono-n93o)', async () => {
    const { walletClient, publicClient, sendTransaction, waitForTransactionReceipt } = makeMocks();
    const publisher = new IdentityPublisher({
      identityRegistryAddress: REGISTRY,
      agentId: AGENT_ID,
      walletClient,
      publicClient,
    });

    const cid = 'bafyverdict003';
    const { txHash } = await publisher.publishContentV2({
      kind: 'evaluation',
      cid,
      payload: V2_VECTOR_INPUT,
    });

    expect(txHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(sendTransaction).toHaveBeenCalledTimes(1);
    expect(waitForTransactionReceipt).toHaveBeenCalledTimes(1);

    const call = decodeSetMetadataCall(sendTransaction.mock.calls[0]![0] as { to: Hex; data: Hex });
    expect(call.address).toBe(REGISTRY);
    expect(call.functionName).toBe('setMetadata');
    expect(call.args[0]).toBe(AGENT_ID);
    expect(call.args[1]).toBe(`evaluation:${cid}`);
    expect(call.args[2]).toBe(encodeExecutionPayloadV2(V2_VECTOR_INPUT));
  });

  it('uses "envelope:" prefix when kind=envelope (back-compat regression)', async () => {
    const { walletClient, publicClient, sendTransaction } = makeMocks();
    const publisher = new IdentityPublisher({
      identityRegistryAddress: REGISTRY,
      agentId: AGENT_ID,
      walletClient,
      publicClient,
    });

    await publisher.publishContentV2({
      kind: 'envelope',
      cid: 'bafyenvelope004',
      payload: V2_VECTOR_INPUT,
    });

    const call = decodeSetMetadataCall(sendTransaction.mock.calls[0]![0] as { to: Hex; data: Hex });
    expect(call.args[1]).toBe('envelope:bafyenvelope004');
  });

  it('uses "skill:" prefix when kind=skill (#1439)', async () => {
    const { walletClient, publicClient, sendTransaction } = makeMocks();
    const publisher = new IdentityPublisher({
      identityRegistryAddress: REGISTRY,
      agentId: AGENT_ID,
      walletClient,
      publicClient,
    });

    const cid = 'bafyskill005';
    await publisher.publishContentV2({
      kind: 'skill',
      cid,
      payload: V2_VECTOR_INPUT,
    });

    const call = decodeSetMetadataCall(sendTransaction.mock.calls[0]![0] as { to: Hex; data: Hex });
    expect(call.args[1]).toBe(`skill:${cid}`);
    expect(call.args[2]).toBe(encodeExecutionPayloadV2(V2_VECTOR_INPUT));
  });
});
