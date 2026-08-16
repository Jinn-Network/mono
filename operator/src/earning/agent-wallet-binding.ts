/**
 * ERC-8004 IdentityRegistry → Safe wallet binding (jinn-mono-aev).
 *
 * Calls `IdentityRegistry.setAgentWallet(agentId, safe, deadline, signature)`
 * from the agent EOA (the NFT owner). The contract recovers `signature`
 * against the *new* wallet (the Safe) — which is a smart-contract wallet,
 * so the call falls through ECDSA and lands in the ERC-1271
 * `IERC1271.isValidSignature(digest, signature)` path on the Safe.
 *
 * Signing flow (Safe v1.3+ / 1.4.x, single-owner threshold-1):
 *   1. Build the IdentityRegistry EIP-712 typed-data digest.
 *      Domain:  ("ERC8004IdentityRegistry", "1", chainId, verifyingContract).
 *      Type:    AgentWalletSet(uint256 agentId, address newWallet,
 *                              address owner, uint256 deadline).
 *      Mirrors `_hashTypedDataV4(structHash)` in the contract.
 *   2. Wrap that digest in Safe's SafeMessage typed-data.
 *      Domain:  (chainId, verifyingContract = safeAddress)
 *               — Safe v1.3+ uses chainId-only domain (no name/version).
 *      Type:    SafeMessage(bytes message)  with message = digest (bytes32 → bytes).
 *      The result is the `safeMessageHash` Safe verifies signatures against.
 *   3. Sign `safeMessageHash` with raw ECDSA (NO eth_sign \x19 prefix —
 *      the SafeMessage typed-data wrap *is* the EIP-712 envelope).
 *      The agent EOA is the sole owner of the Safe.
 *   4. Pack the 65-byte contract-signature blob: r ‖ s ‖ v with v in {27,28}.
 *      Safe's `checkSignatures` accepts this as an "ECDSA owner signature
 *      over the SafeMessage hash" path (no `+4` adjustment — that variant
 *      is for `eth_sign`-prefixed signatures over the raw safeTxHash, not
 *      the EIP-712 SafeMessage path).
 *
 * On-chain effect: `IdentityRegistry.getAgentWallet(agentId) == safeAddress`.
 *
 * Idempotency: the caller (bootstrap) gates this with `safe_bound_to_agent`.
 * If the binding has already happened, do not call again — the contract
 * enforces `MAX_DEADLINE_DELAY = 5 minutes`, so re-running with a stale
 * signature reverts; re-running with a fresh signature is harmless but
 * wasteful.
 *
 * See:
 *   - /tmp/erc8004-ref/IdentityRegistryUpgradeable.sol :: setAgentWallet
 *   - docs/superpowers/specs/2026-04-27-erc-8004-entity-model-design.md §4.1
 *   - jinn-mono-j07 (mint), jinn-mono-aev (this binding)
 */

import {
  encodeFunctionData,
  hashTypedData,
  hexToBytes,
  BaseError,
  ContractFunctionRevertedError,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from 'viem';
import type { PrivateKeyAccount } from 'viem/accounts';
import { IDENTITY_REGISTRY_ABI } from './contracts.js';
import { viemSendTransactionWithRetry, waitForTransactionReceiptWithRetry } from '../tx-retry.js';

/**
 * IdentityRegistry contract enforces this. Default deadline is "now + 4
 * minutes" — well under the cap, leaves wiggle for clock skew + slow RPCs.
 */
const IDENTITY_MAX_DEADLINE_DELAY_SEC = 5 * 60;
const DEFAULT_DEADLINE_OFFSET_SEC = 4 * 60;

export interface BindAgentWalletArgs {
  /** ERC-8004 IdentityRegistry contract (vanity 0x8004…). */
  identityRegistryAddress: Address;
  /** The agent NFT id minted by `IdentityRegistry.register()`. */
  agentId: bigint;
  /** The Safe smart-contract wallet to bind as the agent's wallet. */
  safeAddress: Address;
  /**
   * The agent EOA — owner of the NFT and (for our deployment topology)
   * sole owner of `safeAddress`. Used to ECDSA-sign the SafeMessage hash
   * AND to send the on-chain `setAgentWallet` tx (msg.sender must be NFT
   * owner / approved / operator).
   */
  agentEoaAccount: PrivateKeyAccount;
  /** Wallet client bound to `agentEoaAccount` for tx submission. */
  agentEoaWalletClient: WalletClient;
  /** Public client for chain reads + receipt waits. */
  publicClient: PublicClient;
  /** EVM chainId — used in both EIP-712 domains. */
  chainId: number;
  /**
   * Unix-seconds deadline. Default = now + 4 minutes (under the contract's
   * 5-minute cap). The contract requires `block.timestamp <= deadline` AND
   * `deadline <= block.timestamp + 5 minutes`.
   */
  deadline?: bigint;
}

export interface BindAgentWalletResult {
  ok: true;
  txHash: Hex;
  /** Final EIP-712 digest the IdentityRegistry checks against. */
  identityDigest: Hex;
  /** SafeMessage hash the Safe's `checkSignatures` recovers against. */
  safeMessageHash: Hex;
  /** 65-byte contract-signature blob passed to `setAgentWallet`. */
  signature: Hex;
  /** Deadline actually used. */
  deadline: bigint;
}

export interface SafeBindingError {
  kind: 'safe_binding_failed';
  /** Full error message (from BaseError.message). */
  message: string;
  /** Concise one-liner (from BaseError.shortMessage, falls back to message). */
  shortMessage: string;
  /**
   * Decoded contract revert reason. Set when the revert carries an
   * `Error(string)` payload or a named custom error. `null` when the
   * transaction reverted without a reason string (e.g. plain `revert`).
   */
  revertReason: string | null;
}

export interface BindAgentWalletFailure {
  ok: false;
  error: SafeBindingError;
}

export type BindAgentWalletOutcome = BindAgentWalletResult | BindAgentWalletFailure;

/**
 * Build the IdentityRegistry EIP-712 digest exactly as the contract's
 * `_hashTypedDataV4(structHash)` would produce it.
 *
 * Exposed for tests + symmetry; the main entry point uses this internally.
 */
export function buildIdentityDigest(args: {
  identityRegistryAddress: Address;
  chainId: number;
  agentId: bigint;
  newWallet: Address;
  owner: Address;
  deadline: bigint;
}): Hex {
  return hashTypedData({
    domain: {
      name: 'ERC8004IdentityRegistry',
      version: '1',
      chainId: args.chainId,
      verifyingContract: args.identityRegistryAddress,
    },
    types: {
      AgentWalletSet: [
        { name: 'agentId', type: 'uint256' },
        { name: 'newWallet', type: 'address' },
        { name: 'owner', type: 'address' },
        { name: 'deadline', type: 'uint256' },
      ],
    },
    primaryType: 'AgentWalletSet',
    message: {
      agentId: args.agentId,
      newWallet: args.newWallet,
      owner: args.owner,
      deadline: args.deadline,
    },
  });
}

/**
 * Build the Safe SafeMessage hash that an owner signs to satisfy the
 * Safe's ERC-1271 `isValidSignature(_dataHash, _signature)` for
 * `_dataHash = identityDigest`.
 *
 * Safe v1.3+ uses a chainId-only EIP-712 domain (no name/version):
 *   keccak256("EIP712Domain(uint256 chainId,address verifyingContract)")
 * Type:
 *   keccak256("SafeMessage(bytes message)")
 * Message bytes:
 *   the 32-byte identityDigest, hashed once by the type-encoder
 *   (`bytes` is dynamic → keccak256 of contents).
 */
export function buildSafeMessageHash(args: {
  safeAddress: Address;
  chainId: number;
  identityDigest: Hex;
}): Hex {
  return hashTypedData({
    domain: {
      chainId: args.chainId,
      verifyingContract: args.safeAddress,
    },
    types: {
      SafeMessage: [{ name: 'message', type: 'bytes' }],
    },
    primaryType: 'SafeMessage',
    message: {
      message: args.identityDigest,
    },
  });
}

/**
 * Pack the Safe contract-signature blob from a raw ECDSA signature.
 *
 * Safe's `checkSignatures` for an EIP-712 SafeMessage owner signature
 * expects 65 bytes `r ‖ s ‖ v` with `v ∈ {27,28}`. (The `v + 4` adjustment
 * applies to the `eth_sign` variant where the owner signed
 * `\x19Ethereum Signed Message:\n32 ‖ safeTxHash` rather than the EIP-712
 * SafeMessage hash directly. We're on the EIP-712 path here.)
 */
export function packSafeOwnerSignature(rawSig: Hex): Hex {
  const bytes = hexToBytes(rawSig);
  if (bytes.length !== 65) {
    throw new Error(`Expected 65-byte ECDSA signature, got ${bytes.length} bytes`);
  }
  const v = bytes[64]!;
  if (v !== 27 && v !== 28) {
    // viem's account.sign returns v ∈ {27,28} for legacy sigs; bail loudly
    // if a yParity-only blob (v ∈ {0,1}) ever leaks through.
    throw new Error(
      `Unexpected v byte ${v} in ECDSA signature; Safe owner sig requires v in {27,28}`,
    );
  }
  // Already in the right shape — Safe accepts r||s||v as-is.
  return rawSig;
}

/**
 * Bind a Safe wallet to an ERC-8004 agent NFT via `setAgentWallet`.
 *
 * Single-owner Safe assumption: `safeAddress` has exactly one owner —
 * `agentEoaAccount` — with threshold = 1. For multi-owner Safes the
 * signature blob would need to be sorted+concatenated owner sigs; not
 * supported here (out of scope; bootstrap only deploys 1-of-1 Safes).
 */
export async function bindAgentWalletToSafe(
  args: BindAgentWalletArgs,
): Promise<BindAgentWalletOutcome> {
  const {
    identityRegistryAddress,
    agentId,
    safeAddress,
    agentEoaAccount,
    agentEoaWalletClient,
    publicClient,
    chainId,
  } = args;

  // 1. Pick a deadline within the contract's 5-minute window. Use chain time
  // rather than wall-clock time so forked/local chains that mine many blocks do
  // not reject otherwise-fresh signatures as expired.
  const latestBlock = await publicClient.getBlock();
  const nowSec = latestBlock.timestamp;
  const deadline = args.deadline ?? nowSec + BigInt(DEFAULT_DEADLINE_OFFSET_SEC);
  const maxDeadline = nowSec + BigInt(IDENTITY_MAX_DEADLINE_DELAY_SEC);
  if (deadline > maxDeadline) {
    throw new Error(
      `Deadline ${deadline} exceeds IdentityRegistry MAX_DEADLINE_DELAY ` +
      `(now=${nowSec}, max=${maxDeadline}). Pass a deadline ≤ now + 5 minutes.`,
    );
  }
  if (deadline < nowSec) {
    throw new Error(`Deadline ${deadline} is in the past (now=${nowSec})`);
  }

  // 2. Build the IdentityRegistry digest the contract will check against.
  const identityDigest = buildIdentityDigest({
    identityRegistryAddress,
    chainId,
    agentId,
    newWallet: safeAddress,
    owner: agentEoaAccount.address,
    deadline,
  });

  // 3. Wrap in SafeMessage typed-data — this is what the Safe's
  //    `isValidSignature` will recover signatures against.
  const safeMessageHash = buildSafeMessageHash({
    safeAddress,
    chainId,
    identityDigest,
  });

  // 4. Raw ECDSA-sign the SafeMessage hash with the agent EOA (sole owner).
  //    `account.sign({ hash })` produces a 65-byte sig with v ∈ {27,28} —
  //    no eth_sign prefix; the EIP-712 wrap above is the envelope.
  const rawSig = await agentEoaAccount.sign({ hash: safeMessageHash });
  const signature = packSafeOwnerSignature(rawSig);

  // 5. Submit `setAgentWallet` from the agent EOA (NFT owner).
  const data = encodeFunctionData({
    abi: IDENTITY_REGISTRY_ABI,
    functionName: 'setAgentWallet',
    args: [agentId, safeAddress, deadline, signature],
  }) as Hex;

  try {
    const txHash = await viemSendTransactionWithRetry(
      agentEoaWalletClient,
      publicClient,
      {
        account: agentEoaAccount,
        to: identityRegistryAddress,
        data,
      },
    );

    const receipt = await waitForTransactionReceiptWithRetry(publicClient, txHash);
    if (receipt.status !== 'success') {
      return {
        ok: false,
        error: {
          kind: 'safe_binding_failed',
          message: `IdentityRegistry.setAgentWallet() reverted (agentId=${agentId}, safe=${safeAddress}, tx=${txHash})`,
          shortMessage: `setAgentWallet reverted (tx=${txHash})`,
          revertReason: null,
        },
      };
    }

    return {
      ok: true,
      txHash,
      identityDigest,
      safeMessageHash,
      signature,
      deadline,
    };
  } catch (err) {
    const e = err instanceof BaseError ? err : new BaseError(String(err));
    const reverted = e.walk(
      (x): x is ContractFunctionRevertedError =>
        x instanceof ContractFunctionRevertedError,
    ) as ContractFunctionRevertedError | null;

    // Prefer `.reason` (set for `Error(string)` and Panic reverts by viem),
    // then fall back to `.data.errorName` for named custom errors, then the
    // BaseError shortMessage of the ContractFunctionRevertedError itself.
    const revertReason: string | null =
      reverted?.reason ??
      (reverted?.data
        ? reverted.data.errorName !== 'Error'
          ? reverted.data.errorName
          : (reverted.data.args?.[0] as string | undefined) ?? null
        : null) ??
      null;

    // Use the inner ContractFunctionRevertedError's shortMessage when
    // available — it contains the decoded reason ("reverted with reason: X")
    // which is more useful than the outer wrapper's shortMessage.
    const shortMessage = reverted?.shortMessage ?? e.shortMessage ?? e.message;

    return {
      ok: false,
      error: {
        kind: 'safe_binding_failed',
        message: e.message,
        shortMessage,
        revertReason,
      },
    };
  }
}
