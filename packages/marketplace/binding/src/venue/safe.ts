// SPDX-License-Identifier: MIT

// A minimal, standalone Safe `execTransaction` helper, adapted from
// `client/src/adapters/mech/safe.ts` (design §14 "declared impact"; design §3 "all
// state-changing calls Safe-routed"). Deliberately simpler than the client's production
// version: no shared nonce-ledger, no cross-process lock, no eviction-recovery retry loop --
// those are daemon-concurrency concerns that belong to the pipeline (Milestone M6) wiring this
// into a running daemon with multiple concurrent loops sharing one Safe. For a single-shot
// binding call (posting one Task, per M2 scope) a straight read-sign-broadcast-wait sequence is
// the minimum code that solves the problem (Rule 2); it still classifies inner reverts via
// `safe-revert.ts` so a caller gets a decoded reason, not just "reverted".
import type { Address, Hex, PublicClient, WalletClient } from "viem";
import { SafeInnerRevertError, decodeSafeInnerRevert, formatDecodedRevert } from "./safe-revert.js";

export const SAFE_ABI = [
  {
    name: "execTransaction",
    type: "function",
    stateMutability: "payable",
    inputs: [
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "data", type: "bytes" },
      { name: "operation", type: "uint8" },
      { name: "safeTxGas", type: "uint256" },
      { name: "baseGas", type: "uint256" },
      { name: "gasPrice", type: "uint256" },
      { name: "gasToken", type: "address" },
      { name: "refundReceiver", type: "address" },
      { name: "signatures", type: "bytes" },
    ],
    outputs: [{ name: "success", type: "bool" }],
  },
  {
    name: "nonce",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "getTransactionHash",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "data", type: "bytes" },
      { name: "operation", type: "uint8" },
      { name: "safeTxGas", type: "uint256" },
      { name: "baseGas", type: "uint256" },
      { name: "gasPrice", type: "uint256" },
      { name: "gasToken", type: "address" },
      { name: "refundReceiver", type: "address" },
      { name: "_nonce", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bytes32" }],
  },
  {
    name: "isOwner",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;

/** An approved-hash signature (r = signer address, s = 0, v = 1) -- valid when the signer separately calls `approveHash` or is the `msg.sender`; here it accompanies an EOA `eth_sign`-style signature per Safe's contract-signature convention (ported verbatim). */
export function buildSafeSignature(signerAddress: string): Hex {
  const r = signerAddress.toLowerCase().replace("0x", "").padStart(64, "0");
  const s = "0".repeat(64);
  const v = "01";
  return `0x${r}${s}${v}` as Hex;
}

export interface SafeTransactionParams {
  safeAddress: Address;
  to: Address;
  value: bigint;
  data: Hex;
}

/**
 * Executes one Safe `execTransaction`: reads the current nonce, computes and signs the Safe
 * transaction hash, submits, and waits for the receipt. On revert, decodes the inner reason via
 * `safe-revert.ts` and throws `SafeInnerRevertError` when a known selector is found.
 */
export async function executeSafeTransaction(
  publicClient: PublicClient,
  walletClient: WalletClient,
  params: SafeTransactionParams,
): Promise<Hex> {
  const { safeAddress, to, value, data } = params;
  const account = walletClient.account;
  if (!account) throw new Error("wallet client has no account");
  const from = account.address;

  const nonce = await publicClient.readContract({
    address: safeAddress,
    abi: SAFE_ABI,
    functionName: "nonce",
  });

  const safeTxHash = await publicClient.readContract({
    address: safeAddress,
    abi: SAFE_ABI,
    functionName: "getTransactionHash",
    args: [to, value, data, 0, 0n, 0n, 0n, ZERO_ADDRESS, ZERO_ADDRESS, nonce],
  });

  const ethSignature = await walletClient.signMessage({ account, message: { raw: safeTxHash as Hex } });
  const sigBytes = Buffer.from((ethSignature as string).slice(2), "hex");
  sigBytes[64] = sigBytes[64]! + 4; // Safe's contract-signature `v` offset convention
  const safeSignature = `0x${sigBytes.toString("hex")}` as Hex;

  let hash: Hex;
  try {
    hash = await walletClient.writeContract({
      address: safeAddress,
      abi: SAFE_ABI,
      functionName: "execTransaction",
      args: [to, value, data, 0, 0n, 0n, 0n, ZERO_ADDRESS, ZERO_ADDRESS, safeSignature],
      account,
      chain: walletClient.chain,
      value,
    });
  } catch (writeErr) {
    const inner = await decodeSafeInnerRevert(publicClient, params);
    if (inner.decodedName) {
      throw new SafeInnerRevertError(
        `Safe execTransaction inner revert (estimate): ${formatDecodedRevert(inner.decodedName, inner.decodedArgs)}`,
        inner.innerSelector,
        inner.innerData,
        inner.decodedName,
        inner.decodedArgs,
        null,
      );
    }
    throw writeErr;
  }

  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") {
    const inner = await decodeSafeInnerRevert(publicClient, params);
    if (inner.decodedName) {
      throw new SafeInnerRevertError(
        `Safe execTransaction inner revert: ${formatDecodedRevert(inner.decodedName, inner.decodedArgs)} (txHash=${hash})`,
        inner.innerSelector,
        inner.innerData,
        inner.decodedName,
        inner.decodedArgs,
        hash,
      );
    }
    throw new Error(`Safe execTransaction reverted (txHash=${hash})`);
  }
  return hash;
}
