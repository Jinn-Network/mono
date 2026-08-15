/**
 * Unit tests for the ERC-8004 → Safe wallet binding helper (jinn-mono-aev).
 *
 * Anvil-fork integration is out of scope for vitest (the existing test
 * suite has no anvil harness). These tests pin the *protocol*-level
 * shapes — the EIP-712 digests, SafeMessage hash, and signature blob
 * format — against reference values computed via the same primitives
 * (viem `hashTypedData`, raw ECDSA), so any drift in our typed-data
 * construction shows up as a hard failure rather than as a silent
 * on-chain revert.
 *
 * What we verify here:
 *   1. `buildIdentityDigest` matches a hand-rolled `_hashTypedDataV4`
 *      reference computed from the EIP-712 primitives directly.
 *   2. `buildSafeMessageHash` matches the @safe-global/protocol-kit
 *      `calculateSafeMessageHash` shape (chainId-only domain,
 *      `SafeMessage(bytes message)` type) when given the same inputs.
 *   3. `packSafeOwnerSignature` emits a 65-byte blob with v ∈ {27,28}
 *      that recovers to the signing EOA when verified against the
 *      SafeMessage hash via plain ECDSA — i.e. exactly what Safe's
 *      `checkSignatures` does for the EIP-712 path.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  encodeAbiParameters,
  hashTypedData,
  hexToBytes,
  keccak256,
  recoverAddress,
  toHex,
  BaseError,
  ContractFunctionRevertedError,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  buildIdentityDigest,
  buildSafeMessageHash,
  packSafeOwnerSignature,
  bindAgentWalletToSafe,
} from '../../src/earning/agent-wallet-binding.js';
import { IDENTITY_REGISTRY_ABI } from '../../src/earning/contracts.js';

// Deterministic fixtures — matches the contract test pattern.
const AGENT_PK: Hex = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const AGENT_EOA: Address = privateKeyToAccount(AGENT_PK).address;

const IDENTITY_REGISTRY: Address = '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432';
const SAFE_ADDRESS: Address = '0x1111111111111111111111111111111111111111';
const CHAIN_ID = 8453; // Base mainnet
const AGENT_ID = 42n;
const DEADLINE = 1_700_000_000n;

describe('buildIdentityDigest', () => {
  it('matches a hand-rolled `_hashTypedDataV4` reference', () => {
    // Reference: replicate exactly what
    // IdentityRegistryUpgradeable._hashTypedDataV4(structHash) does.
    //
    // Domain typehash (OZ EIP712Upgradeable: name + version + chainId +
    // verifyingContract):
    //   keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)")
    const DOMAIN_TYPEHASH = keccak256(
      toHex('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)'),
    );
    const NAME_HASH = keccak256(toHex('ERC8004IdentityRegistry'));
    const VERSION_HASH = keccak256(toHex('1'));

    const domainSeparator = keccak256(
      encodeAbiParameters(
        [
          { type: 'bytes32' },
          { type: 'bytes32' },
          { type: 'bytes32' },
          { type: 'uint256' },
          { type: 'address' },
        ],
        [DOMAIN_TYPEHASH, NAME_HASH, VERSION_HASH, BigInt(CHAIN_ID), IDENTITY_REGISTRY],
      ),
    );

    // Struct typehash:
    //   keccak256("AgentWalletSet(uint256 agentId,address newWallet,address owner,uint256 deadline)")
    const TYPE_HASH = keccak256(
      toHex('AgentWalletSet(uint256 agentId,address newWallet,address owner,uint256 deadline)'),
    );
    const structHash = keccak256(
      encodeAbiParameters(
        [
          { type: 'bytes32' },
          { type: 'uint256' },
          { type: 'address' },
          { type: 'address' },
          { type: 'uint256' },
        ],
        [TYPE_HASH, AGENT_ID, SAFE_ADDRESS, AGENT_EOA, DEADLINE],
      ),
    );

    // EIP-712 final digest: keccak256("\x19\x01" || domainSeparator || structHash)
    const expectedDigest = keccak256(
      ('0x1901' + domainSeparator.slice(2) + structHash.slice(2)) as Hex,
    );

    const actualDigest = buildIdentityDigest({
      identityRegistryAddress: IDENTITY_REGISTRY,
      chainId: CHAIN_ID,
      agentId: AGENT_ID,
      newWallet: SAFE_ADDRESS,
      owner: AGENT_EOA,
      deadline: DEADLINE,
    });

    expect(actualDigest).toBe(expectedDigest);
  });

  it('changes when any field changes (no-collision sanity check)', () => {
    const base = buildIdentityDigest({
      identityRegistryAddress: IDENTITY_REGISTRY,
      chainId: CHAIN_ID,
      agentId: AGENT_ID,
      newWallet: SAFE_ADDRESS,
      owner: AGENT_EOA,
      deadline: DEADLINE,
    });
    expect(
      buildIdentityDigest({
        identityRegistryAddress: IDENTITY_REGISTRY,
        chainId: CHAIN_ID,
        agentId: AGENT_ID + 1n,
        newWallet: SAFE_ADDRESS,
        owner: AGENT_EOA,
        deadline: DEADLINE,
      }),
    ).not.toBe(base);
    expect(
      buildIdentityDigest({
        identityRegistryAddress: IDENTITY_REGISTRY,
        chainId: CHAIN_ID + 1,
        agentId: AGENT_ID,
        newWallet: SAFE_ADDRESS,
        owner: AGENT_EOA,
        deadline: DEADLINE,
      }),
    ).not.toBe(base);
  });
});

describe('buildSafeMessageHash', () => {
  it('matches a hand-rolled SafeMessage `_hashTypedDataV4` (chainId-only domain)', () => {
    const identityDigest = buildIdentityDigest({
      identityRegistryAddress: IDENTITY_REGISTRY,
      chainId: CHAIN_ID,
      agentId: AGENT_ID,
      newWallet: SAFE_ADDRESS,
      owner: AGENT_EOA,
      deadline: DEADLINE,
    });

    // Safe v1.3+ domain: keccak256("EIP712Domain(uint256 chainId,address verifyingContract)")
    const SAFE_DOMAIN_TYPEHASH = keccak256(
      toHex('EIP712Domain(uint256 chainId,address verifyingContract)'),
    );
    const safeDomainSeparator = keccak256(
      encodeAbiParameters(
        [{ type: 'bytes32' }, { type: 'uint256' }, { type: 'address' }],
        [SAFE_DOMAIN_TYPEHASH, BigInt(CHAIN_ID), SAFE_ADDRESS],
      ),
    );

    // Type: keccak256("SafeMessage(bytes message)") — `bytes` field is
    // hashed with keccak256, which for our 32-byte digest is keccak256(digest).
    const SAFE_MSG_TYPEHASH = keccak256(toHex('SafeMessage(bytes message)'));
    const messageBytesHash = keccak256(identityDigest);
    const safeStructHash = keccak256(
      encodeAbiParameters(
        [{ type: 'bytes32' }, { type: 'bytes32' }],
        [SAFE_MSG_TYPEHASH, messageBytesHash],
      ),
    );
    const expected = keccak256(
      ('0x1901' + safeDomainSeparator.slice(2) + safeStructHash.slice(2)) as Hex,
    );

    const actual = buildSafeMessageHash({
      safeAddress: SAFE_ADDRESS,
      chainId: CHAIN_ID,
      identityDigest,
    });

    expect(actual).toBe(expected);
  });

  it('matches a viem-direct `hashTypedData` invocation (cross-check)', () => {
    const identityDigest = buildIdentityDigest({
      identityRegistryAddress: IDENTITY_REGISTRY,
      chainId: CHAIN_ID,
      agentId: AGENT_ID,
      newWallet: SAFE_ADDRESS,
      owner: AGENT_EOA,
      deadline: DEADLINE,
    });

    // Same inputs viem `calculateSafeMessageHash` would use in
    // @safe-global/protocol-kit: chainId-only domain + SafeMessage(bytes).
    const direct = hashTypedData({
      domain: {
        chainId: CHAIN_ID,
        verifyingContract: SAFE_ADDRESS,
      },
      types: {
        SafeMessage: [{ name: 'message', type: 'bytes' }],
      },
      primaryType: 'SafeMessage',
      message: { message: identityDigest },
    });

    const helper = buildSafeMessageHash({
      safeAddress: SAFE_ADDRESS,
      chainId: CHAIN_ID,
      identityDigest,
    });

    expect(helper).toBe(direct);
  });
});

describe('packSafeOwnerSignature', () => {
  it('returns 65 bytes with v ∈ {27,28} for an account.sign({hash}) blob', async () => {
    const account = privateKeyToAccount(AGENT_PK);
    const identityDigest = buildIdentityDigest({
      identityRegistryAddress: IDENTITY_REGISTRY,
      chainId: CHAIN_ID,
      agentId: AGENT_ID,
      newWallet: SAFE_ADDRESS,
      owner: account.address,
      deadline: DEADLINE,
    });
    const safeMessageHash = buildSafeMessageHash({
      safeAddress: SAFE_ADDRESS,
      chainId: CHAIN_ID,
      identityDigest,
    });

    const rawSig = await account.sign({ hash: safeMessageHash });
    const packed = packSafeOwnerSignature(rawSig);

    const bytes = hexToBytes(packed);
    expect(bytes.length).toBe(65);
    const v = bytes[64]!;
    expect([27, 28]).toContain(v);

    // The signature recovers to the agent EOA when verified against the
    // SafeMessage hash with plain ECDSA — this is exactly what Safe's
    // `checkSignatures` does for an EIP-712 owner signature.
    const recovered = await recoverAddress({
      hash: safeMessageHash,
      signature: packed,
    });
    expect(recovered.toLowerCase()).toBe(account.address.toLowerCase());
  });

  it('rejects yParity-only sigs (v ∈ {0,1}) — Safe needs v ∈ {27,28}', () => {
    // Hand-craft a 65-byte sig whose v byte is 0.
    const fake = ('0x' + 'ab'.repeat(64) + '00') as Hex;
    expect(() => packSafeOwnerSignature(fake)).toThrow(/v in \{27,28\}/);
  });

  it('rejects malformed (non-65-byte) sigs', () => {
    expect(() => packSafeOwnerSignature(('0x' + '00'.repeat(64)) as Hex)).toThrow(
      /Expected 65-byte/,
    );
  });
});

describe('bindAgentWalletToSafe — error result (jinn-mono-hjex.4)', () => {
  it('captures the contract revert reason when setAgentWallet reverts (jinn-mono-hjex.4)', async () => {
    // Build a viem BaseError wrapping a ContractFunctionRevertedError whose
    // Error(string) payload is "Not authorized". This mirrors what viem
    // produces when the node returns an `execution reverted` with the
    // Error(string) selector + ABI-encoded reason.
    const revertedError = new ContractFunctionRevertedError({
      abi: IDENTITY_REGISTRY_ABI,
      functionName: 'setAgentWallet',
      // Pass the reason directly; viem will set `.reason = 'Not authorized'`
      message: 'Not authorized',
    });
    const wrappedRevert = new BaseError('Execution reverted', {
      cause: revertedError,
    });

    const agentAccount = privateKeyToAccount(AGENT_PK);

    // Mock walletClient: sendTransaction rejects with the wrapped revert.
    const mockWalletClient = {
      sendTransaction: vi.fn().mockRejectedValue(wrappedRevert),
    };

    // Mock publicClient: getBlock returns a recent timestamp; no receipt wait needed
    // because sendTransaction throws before we get a hash.
    const mockPublicClient = {
      getBlock: vi.fn().mockResolvedValue({ timestamp: BigInt(Math.floor(Date.now() / 1000)) }),
    };

    const result = await bindAgentWalletToSafe({
      identityRegistryAddress: IDENTITY_REGISTRY,
      agentId: AGENT_ID,
      safeAddress: SAFE_ADDRESS,
      agentEoaAccount: agentAccount,
      agentEoaWalletClient: mockWalletClient as any,
      publicClient: mockPublicClient as any,
      chainId: CHAIN_ID,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected ok=false');
    expect(result.error.kind).toBe('safe_binding_failed');
    expect(result.error.revertReason).toBe('Not authorized');
    expect(result.error.shortMessage).toContain('Not authorized');
  });
});
