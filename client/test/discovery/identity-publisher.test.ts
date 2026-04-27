/**
 * Tests for IdentityPublisher (jinn-mono-3zk).
 *
 * Cross-checks the encoder against the normative test vectors in
 * `docs/superpowers/specs/2026-04-27-erc-8004-payload-schema.md` §8 and
 * exercises the strict-mode validity rules from §5.
 */

import { describe, it, expect, vi } from 'vitest';
import type { Hex, PublicClient, WalletClient } from 'viem';
import {
  IdentityPublisher,
  PayloadValidationError,
  buildMetadataKey,
  encodeExecutionPayload,
  validatePayload,
  type ExecutionPayload,
} from '../../src/discovery/identity-publisher.js';

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

  it('accepts tier 2 with empty quote and zero measurement', () => {
    expect(() =>
      validatePayload({
        ...VECTOR_A_INPUT,
        tier: 2,
      }),
    ).not.toThrow();
  });

  it('accepts tier 3 with non-empty quote and non-zero measurement', () => {
    expect(() => validatePayload(VECTOR_C_INPUT)).not.toThrow();
  });

  it('accepts tier 4 with non-empty quote and non-zero measurement', () => {
    expect(() =>
      validatePayload({
        ...VECTOR_C_INPUT,
        tier: 4,
      }),
    ).not.toThrow();
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

  it('rejects tier 2 with non-zero sourceMeasurement', () => {
    expect(() =>
      validatePayload({
        ...VECTOR_A_INPUT,
        tier: 2,
        sourceMeasurement:
          '0x4444444444444444444444444444444444444444444444444444444444444444',
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

  it('rejects tier 4 with empty attestationQuoteCid', () => {
    expect(() =>
      validatePayload({
        ...VECTOR_C_INPUT,
        tier: 4,
        attestationQuoteCid: '0x',
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
});

// ── publishContent — calldata + lifecycle ─────────────────────────────────────

function makeMocks(overrides?: {
  writeContractImpl?: (...args: unknown[]) => Promise<Hex>;
  waitImpl?: (...args: unknown[]) => Promise<unknown>;
}) {
  const writeContract = vi
    .fn<[unknown], Promise<Hex>>()
    .mockImplementation(
      overrides?.writeContractImpl as (...args: unknown[]) => Promise<Hex> ??
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
    writeContract,
  } as unknown as WalletClient;
  const publicClient = {
    waitForTransactionReceipt,
  } as unknown as PublicClient;
  return { walletClient, publicClient, writeContract, waitForTransactionReceipt };
}

describe('IdentityPublisher.publishContent', () => {
  const REGISTRY = '0x8004800480048004800480048004800480048004' as `0x${string}`;
  const AGENT_ID = 42n;

  it('calls setMetadata with correct address, args, and ABI-encoded value', async () => {
    const { walletClient, publicClient, writeContract, waitForTransactionReceipt } = makeMocks();

    const publisher = new IdentityPublisher({
      identityRegistryAddress: REGISTRY,
      agentId: AGENT_ID,
      walletClient,
      publicClient,
    });

    const cid = 'bafyreienvelope001';
    const txHash = await publisher.publishContent({
      kind: 'envelope',
      cid,
      payload: VECTOR_B_INPUT,
    });

    expect(txHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(writeContract).toHaveBeenCalledTimes(1);
    expect(waitForTransactionReceipt).toHaveBeenCalledTimes(1);

    const call = writeContract.mock.calls[0]![0] as {
      address: string;
      functionName: string;
      args: [bigint, string, Hex];
    };
    expect(call.address).toBe(REGISTRY);
    expect(call.functionName).toBe('setMetadata');
    expect(call.args[0]).toBe(AGENT_ID);
    expect(call.args[1]).toBe(`envelope:${cid}`);
    expect(call.args[2]).toBe(VECTOR_B_EXPECTED);
  });

  it('uses "evaluation:" prefix when kind=evaluation', async () => {
    const { walletClient, publicClient, writeContract } = makeMocks();
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

    const call = writeContract.mock.calls[0]![0] as { args: [bigint, string, Hex] };
    expect(call.args[1]).toBe('evaluation:bafyverdict002');
    expect(call.args[2]).toBe(VECTOR_A_EXPECTED);
  });

  it('propagates PayloadValidationError on bad payload (no contract call)', async () => {
    const { walletClient, publicClient, writeContract } = makeMocks();
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

    expect(writeContract).not.toHaveBeenCalled();
  });

  it('propagates writeContract errors to the caller', async () => {
    const { walletClient, publicClient } = makeMocks({
      writeContractImpl: () => Promise.reject(new Error('rpc unreachable')),
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
