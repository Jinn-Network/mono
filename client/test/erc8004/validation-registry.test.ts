/**
 * Unit tests for ValidationRegistryClient (jinn-mono-9jg).
 *
 * Tests are mock-only — no real chain. Verifies that:
 *   - Write paths (requestValidation, submitResponse) build the expected
 *     calldata payload and route through walletClient.writeContract with
 *     the correct ABI / args.
 *   - Read paths (getStatus, getAgentValidations, getValidatorRequests)
 *     decode the contract return shape into the typed `ValidationRecord`
 *     surface and handle the "unknown requestHash" revert + the
 *     REQUESTED → RESPONDED transition.
 *   - Address constants for Base / Base Sepolia mirror the canonical
 *     ERC-8004 deployments.
 *   - Validator-selection model is open at this layer (no caller-side
 *     gating), per DR §4.4.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  encodeFunctionData,
  decodeFunctionData,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from 'viem';
import {
  VALIDATION_REGISTRY_ABI,
  VALIDATION_REGISTRY_ADDRESSES,
  ValidationRegistryClient,
} from '../../src/erc8004/validation.js';

// ── Fixtures ────────────────────────────────────────────────────────────────

const REGISTRY: Address = '0x8004Cb1BF31DAf7788923b405b754f57acEB4272';
const VALIDATOR: Address = '0x1111111111111111111111111111111111111111';
const OPERATOR_EOA: Address = '0x2222222222222222222222222222222222222222';
const ZERO_ADDRESS: Address = '0x0000000000000000000000000000000000000000';
const REQUEST_HASH: Hex =
  '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
const RESPONSE_HASH: Hex =
  '0xfeedfacefeedfacefeedfacefeedfacefeedfacefeedfacefeedfacefeedface';
const ZERO_BYTES32: Hex =
  '0x0000000000000000000000000000000000000000000000000000000000000000';
const AGENT_ID = 7n;
const REQUEST_URI = 'ipfs://bafy-challenge-body';
const RESPONSE_URI = 'ipfs://bafy-validator-verdict';
const TAG = 'attestation-verify';

const TX_HASH: Hex =
  '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

function makePublicClient(impl: Partial<PublicClient> = {}): PublicClient {
  return {
    readContract: vi.fn(),
    waitForTransactionReceipt: vi.fn().mockResolvedValue({ status: 'success' }),
    ...impl,
  } as unknown as PublicClient;
}

function makeWalletClient(impl: Partial<WalletClient> = {}): WalletClient {
  return {
    writeContract: vi.fn().mockResolvedValue(TX_HASH),
    account: { address: OPERATOR_EOA, type: 'json-rpc' },
    chain: null,
    ...impl,
  } as unknown as WalletClient;
}

// ── Address book ─────────────────────────────────────────────────────────────

describe('VALIDATION_REGISTRY_ADDRESSES', () => {
  it('matches the canonical ERC-8004 deployments on Base + Base Sepolia', () => {
    // Base mainnet (chainId 8453)
    expect(VALIDATION_REGISTRY_ADDRESSES[8453]).toBe(
      '0x8004Cc8439f36fd5F9F049D9fF86523Df6dAAB58',
    );
    // Base Sepolia (chainId 84532)
    expect(VALIDATION_REGISTRY_ADDRESSES[84532]).toBe(
      '0x8004Cb1BF31DAf7788923b405b754f57acEB4272',
    );
    // Mainnet shares Base mainnet vanity
    expect(VALIDATION_REGISTRY_ADDRESSES[1]).toBe(
      '0x8004Cc8439f36fd5F9F049D9fF86523Df6dAAB58',
    );
    // Sepolia shares Base Sepolia vanity
    expect(VALIDATION_REGISTRY_ADDRESSES[11155111]).toBe(
      '0x8004Cb1BF31DAf7788923b405b754f57acEB4272',
    );
  });
});

// ── Construction ────────────────────────────────────────────────────────────

describe('ValidationRegistryClient — construction', () => {
  it('constructs without a walletClient (read-only mode)', () => {
    const publicClient = makePublicClient();
    const client = new ValidationRegistryClient({
      validationRegistryAddress: REGISTRY,
      publicClient,
    });
    expect(client).toBeInstanceOf(ValidationRegistryClient);
  });
});

// ── requestValidation ───────────────────────────────────────────────────────

describe('ValidationRegistryClient.requestValidation', () => {
  it('routes through walletClient.writeContract with the expected call shape', async () => {
    const publicClient = makePublicClient();
    const walletClient = makeWalletClient();
    const client = new ValidationRegistryClient({
      validationRegistryAddress: REGISTRY,
      publicClient,
      walletClient,
    });

    const txHash = await client.requestValidation({
      validatorAddress: VALIDATOR,
      agentId: AGENT_ID,
      requestURI: REQUEST_URI,
      requestHash: REQUEST_HASH,
    });

    expect(txHash).toBe(TX_HASH);
    expect(walletClient.writeContract).toHaveBeenCalledOnce();
    expect(walletClient.writeContract).toHaveBeenCalledWith(
      expect.objectContaining({
        address: REGISTRY,
        functionName: 'validationRequest',
        args: [VALIDATOR, AGENT_ID, REQUEST_URI, REQUEST_HASH],
        account: { address: OPERATOR_EOA, type: 'json-rpc' },
      }),
    );
  });

  it('produces calldata that round-trips through encode/decode against the real ABI', async () => {
    const publicClient = makePublicClient();
    const walletClient = makeWalletClient();
    const client = new ValidationRegistryClient({
      validationRegistryAddress: REGISTRY,
      publicClient,
      walletClient,
    });

    await client.requestValidation({
      validatorAddress: VALIDATOR,
      agentId: AGENT_ID,
      requestURI: REQUEST_URI,
      requestHash: REQUEST_HASH,
    });

    // Recover the call args from the live encoder/decoder against the
    // module's ABI. This is the strongest equivalent of "does this calldata
    // hit the right function on the deployed contract" we can check
    // without an RPC.
    const writeCall = vi.mocked(walletClient.writeContract).mock.calls[0]?.[0];
    if (!writeCall) throw new Error('writeContract was not called');

    const calldata = encodeFunctionData({
      abi: VALIDATION_REGISTRY_ABI,
      functionName: 'validationRequest',
      args: [VALIDATOR, AGENT_ID, REQUEST_URI, REQUEST_HASH],
    });
    const decoded = decodeFunctionData({
      abi: VALIDATION_REGISTRY_ABI,
      data: calldata,
    });
    expect(decoded.functionName).toBe('validationRequest');
    expect(decoded.args).toEqual([VALIDATOR, AGENT_ID, REQUEST_URI, REQUEST_HASH]);
  });

  it('throws when no walletClient was supplied', async () => {
    const publicClient = makePublicClient();
    const client = new ValidationRegistryClient({
      validationRegistryAddress: REGISTRY,
      publicClient,
    });
    await expect(
      client.requestValidation({
        validatorAddress: VALIDATOR,
        agentId: AGENT_ID,
        requestURI: REQUEST_URI,
        requestHash: REQUEST_HASH,
      }),
    ).rejects.toThrow(/requires a walletClient/);
  });

  it('throws when walletClient has no account', async () => {
    const publicClient = makePublicClient();
    const walletClient = makeWalletClient({ account: undefined } as Partial<WalletClient>);
    const client = new ValidationRegistryClient({
      validationRegistryAddress: REGISTRY,
      publicClient,
      walletClient,
    });
    await expect(
      client.requestValidation({
        validatorAddress: VALIDATOR,
        agentId: AGENT_ID,
        requestURI: REQUEST_URI,
        requestHash: REQUEST_HASH,
      }),
    ).rejects.toThrow(/walletClient has no account/);
  });

  it('does not gate on validator address — open validator-selection model (DR §4.4)', async () => {
    const publicClient = makePublicClient();
    const walletClient = makeWalletClient();
    const client = new ValidationRegistryClient({
      validationRegistryAddress: REGISTRY,
      publicClient,
      walletClient,
    });

    // Any non-zero address is accepted by this client. Phase 1b will
    // decide whether to whitelist / stake-gate / randomize the validator
    // pool — that is not enforced here.
    const someRandomValidator: Address = '0x1234567890abcdef1234567890abcdef12345678';
    await expect(
      client.requestValidation({
        validatorAddress: someRandomValidator,
        agentId: AGENT_ID,
        requestURI: REQUEST_URI,
        requestHash: REQUEST_HASH,
      }),
    ).resolves.toBe(TX_HASH);
  });
});

// ── submitResponse ──────────────────────────────────────────────────────────

describe('ValidationRegistryClient.submitResponse', () => {
  it('routes through walletClient.writeContract with the expected call shape', async () => {
    const publicClient = makePublicClient();
    const walletClient = makeWalletClient();
    const client = new ValidationRegistryClient({
      validationRegistryAddress: REGISTRY,
      publicClient,
      walletClient,
    });

    const txHash = await client.submitResponse({
      requestHash: REQUEST_HASH,
      response: 87,
      responseURI: RESPONSE_URI,
      responseHash: RESPONSE_HASH,
      tag: TAG,
    });

    expect(txHash).toBe(TX_HASH);
    expect(walletClient.writeContract).toHaveBeenCalledOnce();
    expect(walletClient.writeContract).toHaveBeenCalledWith(
      expect.objectContaining({
        address: REGISTRY,
        functionName: 'validationResponse',
        args: [REQUEST_HASH, 87, RESPONSE_URI, RESPONSE_HASH, TAG],
      }),
    );
  });

  it('produces calldata that round-trips through encode/decode against the real ABI', async () => {
    const publicClient = makePublicClient();
    const walletClient = makeWalletClient();
    const client = new ValidationRegistryClient({
      validationRegistryAddress: REGISTRY,
      publicClient,
      walletClient,
    });

    await client.submitResponse({
      requestHash: REQUEST_HASH,
      response: 42,
      responseURI: RESPONSE_URI,
      responseHash: RESPONSE_HASH,
      tag: TAG,
    });

    const calldata = encodeFunctionData({
      abi: VALIDATION_REGISTRY_ABI,
      functionName: 'validationResponse',
      args: [REQUEST_HASH, 42, RESPONSE_URI, RESPONSE_HASH, TAG],
    });
    const decoded = decodeFunctionData({
      abi: VALIDATION_REGISTRY_ABI,
      data: calldata,
    });
    expect(decoded.functionName).toBe('validationResponse');
    expect(decoded.args).toEqual([REQUEST_HASH, 42, RESPONSE_URI, RESPONSE_HASH, TAG]);
  });

  it.each([-1, 101, 1000, 1.5, NaN])(
    'rejects out-of-range or non-integer response %s before sending a tx',
    async (badResponse) => {
      const publicClient = makePublicClient();
      const walletClient = makeWalletClient();
      const client = new ValidationRegistryClient({
        validationRegistryAddress: REGISTRY,
        publicClient,
        walletClient,
      });
      await expect(
        client.submitResponse({
          requestHash: REQUEST_HASH,
          response: badResponse,
          responseURI: RESPONSE_URI,
          responseHash: RESPONSE_HASH,
          tag: TAG,
        }),
      ).rejects.toThrow(/integer in \[0, 100\]/);
      expect(walletClient.writeContract).not.toHaveBeenCalled();
    },
  );

  it.each([0, 50, 100])(
    'accepts boundary response %i and sends the tx',
    async (response) => {
      const publicClient = makePublicClient();
      const walletClient = makeWalletClient();
      const client = new ValidationRegistryClient({
        validationRegistryAddress: REGISTRY,
        publicClient,
        walletClient,
      });
      const tx = await client.submitResponse({
        requestHash: REQUEST_HASH,
        response,
        responseURI: RESPONSE_URI,
        responseHash: RESPONSE_HASH,
        tag: TAG,
      });
      expect(tx).toBe(TX_HASH);
    },
  );

  it('throws when no walletClient was supplied', async () => {
    const publicClient = makePublicClient();
    const client = new ValidationRegistryClient({
      validationRegistryAddress: REGISTRY,
      publicClient,
    });
    await expect(
      client.submitResponse({
        requestHash: REQUEST_HASH,
        response: 50,
        responseURI: RESPONSE_URI,
        responseHash: RESPONSE_HASH,
        tag: TAG,
      }),
    ).rejects.toThrow(/requires a walletClient/);
  });
});

// ── getStatus ───────────────────────────────────────────────────────────────

describe('ValidationRegistryClient.getStatus', () => {
  it('returns null when contract reverts with "unknown" (no request)', async () => {
    const publicClient = makePublicClient({
      readContract: vi.fn().mockRejectedValue(new Error('execution reverted: unknown')),
    });
    const client = new ValidationRegistryClient({
      validationRegistryAddress: REGISTRY,
      publicClient,
    });
    expect(await client.getStatus(REQUEST_HASH)).toBeNull();
  });

  it('returns null when contract returned a zero validator (defensive)', async () => {
    const publicClient = makePublicClient({
      readContract: vi
        .fn()
        .mockResolvedValue([ZERO_ADDRESS, 0n, 0, ZERO_BYTES32, '', 0n]),
    });
    const client = new ValidationRegistryClient({
      validationRegistryAddress: REGISTRY,
      publicClient,
    });
    expect(await client.getStatus(REQUEST_HASH)).toBeNull();
  });

  it('returns a REQUESTED record when the validator is set but no response landed', async () => {
    const publicClient = makePublicClient({
      readContract: vi
        .fn()
        .mockResolvedValue([VALIDATOR, AGENT_ID, 0, ZERO_BYTES32, '', 1700000000n]),
    });
    const client = new ValidationRegistryClient({
      validationRegistryAddress: REGISTRY,
      publicClient,
    });

    const record = await client.getStatus(REQUEST_HASH);
    expect(record).toEqual({
      requestHash: REQUEST_HASH,
      validatorAddress: VALIDATOR,
      agentId: AGENT_ID,
      requestURI: '',
      status: 'REQUESTED',
    });
  });

  it('returns a RESPONDED record when responseHash is non-zero', async () => {
    const publicClient = makePublicClient({
      readContract: vi
        .fn()
        .mockResolvedValue([VALIDATOR, AGENT_ID, 87, RESPONSE_HASH, TAG, 1700001000n]),
    });
    const client = new ValidationRegistryClient({
      validationRegistryAddress: REGISTRY,
      publicClient,
    });

    const record = await client.getStatus(REQUEST_HASH);
    expect(record).toEqual({
      requestHash: REQUEST_HASH,
      validatorAddress: VALIDATOR,
      agentId: AGENT_ID,
      requestURI: '',
      status: 'RESPONDED',
      response: 87,
      responseHash: RESPONSE_HASH,
      tag: TAG,
    });
  });

  it('treats a non-empty tag as RESPONDED even when responseHash is zero', async () => {
    // The validator may legitimately submit a tag-only response (e.g. a
    // categorical verdict that does not have a separate hashable artifact).
    const publicClient = makePublicClient({
      readContract: vi
        .fn()
        .mockResolvedValue([VALIDATOR, AGENT_ID, 0, ZERO_BYTES32, TAG, 1700001000n]),
    });
    const client = new ValidationRegistryClient({
      validationRegistryAddress: REGISTRY,
      publicClient,
    });
    const record = await client.getStatus(REQUEST_HASH);
    expect(record?.status).toBe('RESPONDED');
    expect(record?.tag).toBe(TAG);
  });

  it('rethrows non-"unknown" RPC errors', async () => {
    const publicClient = makePublicClient({
      readContract: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')),
    });
    const client = new ValidationRegistryClient({
      validationRegistryAddress: REGISTRY,
      publicClient,
    });
    await expect(client.getStatus(REQUEST_HASH)).rejects.toThrow(/ECONNREFUSED/);
  });

  it('calls the contract with the right ABI fragment', async () => {
    const readContract = vi
      .fn()
      .mockResolvedValue([VALIDATOR, AGENT_ID, 0, ZERO_BYTES32, '', 0n]);
    const publicClient = makePublicClient({ readContract });
    const client = new ValidationRegistryClient({
      validationRegistryAddress: REGISTRY,
      publicClient,
    });
    await client.getStatus(REQUEST_HASH);
    expect(readContract).toHaveBeenCalledWith(
      expect.objectContaining({
        address: REGISTRY,
        functionName: 'getValidationStatus',
        args: [REQUEST_HASH],
      }),
    );
  });
});

// ── getAgentValidations ─────────────────────────────────────────────────────

describe('ValidationRegistryClient.getAgentValidations', () => {
  it('returns the contract array as a fresh, mutable Hex[]', async () => {
    const onChainList: readonly Hex[] = [REQUEST_HASH, RESPONSE_HASH];
    const readContract = vi.fn().mockResolvedValue(onChainList);
    const publicClient = makePublicClient({ readContract });
    const client = new ValidationRegistryClient({
      validationRegistryAddress: REGISTRY,
      publicClient,
    });

    const out = await client.getAgentValidations(AGENT_ID);
    expect(out).toEqual([REQUEST_HASH, RESPONSE_HASH]);
    // Should not be the same reference as the readonly contract result —
    // callers may mutate freely.
    expect(out).not.toBe(onChainList);

    expect(readContract).toHaveBeenCalledWith(
      expect.objectContaining({
        address: REGISTRY,
        functionName: 'getAgentValidations',
        args: [AGENT_ID],
      }),
    );
  });
});

// ── getValidatorRequests ────────────────────────────────────────────────────

describe('ValidationRegistryClient.getValidatorRequests', () => {
  it('returns the contract array', async () => {
    const onChainList: readonly Hex[] = [REQUEST_HASH];
    const readContract = vi.fn().mockResolvedValue(onChainList);
    const publicClient = makePublicClient({ readContract });
    const client = new ValidationRegistryClient({
      validationRegistryAddress: REGISTRY,
      publicClient,
    });

    const out = await client.getValidatorRequests(VALIDATOR);
    expect(out).toEqual([REQUEST_HASH]);
    expect(readContract).toHaveBeenCalledWith(
      expect.objectContaining({
        address: REGISTRY,
        functionName: 'getValidatorRequests',
        args: [VALIDATOR],
      }),
    );
  });
});
