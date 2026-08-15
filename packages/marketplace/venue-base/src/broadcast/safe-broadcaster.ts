// SPDX-License-Identifier: MIT

// The single transaction path (design §6.1 single-broadcaster rule). Every venue writer -- claim,
// settlement, lifecycle, posting -- funnels through `execute`. Two independent nonce stacks
// against one Safe and one EOA is the #525/#562/#897 failure class; it is excluded here by
// construction: one lock, one ledger, one nonce assignment.
import {
  JINN_ROUTER_V3_ABI,
  SAFE_ABI,
  SafeInnerRevertError,
  decodeSafeInnerRevert,
  formatDecodedRevert,
  type PostingOutcome,
  type SafeBroadcastPort,
} from "@jinn-network/marketplace-binding";
import {
  decodeEventLog,
  type Account,
  type Address,
  type Hex,
  type Log,
  type PublicClient,
  type WalletClient,
} from "viem";
import {
  BROADCAST_DEFAULTS,
  classifyBroadcastError,
  flattenError,
  isNonceTooLow,
  isReplacementUnderpriced,
  type VenueRevertClassification,
} from "./classify.js";
import { bumpFees, type FeeSnapshot } from "./fees.js";
import type { BroadcastLock } from "./lock.js";
import type { SubmissionLedger } from "./ledger.js";
import { evictStuckNonce } from "./stuck-nonce.js";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as Address;

export interface SafeBroadcastRequest {
  readonly to: Address;
  readonly value: bigint;
  readonly data: Hex;
  /** Logical operation identity; stored in the ledger so reconciliation never adopts a foreign tx. */
  readonly logicalTx: string;
  /**
   * Safe `Enum.Operation`: `0` = CALL (default), `1` = DELEGATECALL. A batched request routed
   * through the MultiSend singleton MUST use `1`, otherwise every inner call executes with
   * `msg.sender == MultiSend` instead of the Safe and the venue's operator checks reject it.
   * A single-target call always uses `0`.
   */
  readonly operation?: 0 | 1;
}

export interface SafeBroadcastReceipt {
  readonly txHash: Hex;
  readonly blockNumber: bigint;
  readonly blockHash: Hex;
  readonly logs: readonly Log[];
  /** True when the inner call reverted because its effect is already on chain. */
  readonly alreadySettled: boolean;
}

export interface SafeBroadcastOptions {
  readonly maxAttempts?: number;
  readonly baseDelayMs?: number;
  readonly maxDelayMs?: number;
  readonly stuckNonceAfterMs?: number;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  /** Product-owned per-operation gas-cost cap, evaluated over the exact Safe calldata. */
  readonly maxCostWei?: (request: SafeBroadcastRequest) => bigint;
}

export interface BaseVenueSafeBroadcaster extends SafeBroadcastPort {
  execute(request: SafeBroadcastRequest): Promise<SafeBroadcastReceipt>;
  classify(error: unknown): VenueRevertClassification;
}

/**
 * Pre-validated (approved-hash) signature encoding: `r` = the signer address, `s` = 0, `v` = 1.
 * Safe contracts specification, `checkNSignatures`: `v == 1` means the signature is
 * pre-validated by `approvedHashes[owner][hash]` or by `owner == msg.sender`. Exported for the
 * callers that need the approved-hash form rather than the eth_sign form.
 */
export function encodePreValidatedSignature(signer: Address): Hex {
  const r = signer.toLowerCase().replace("0x", "").padStart(64, "0");
  return `0x${r}${"0".repeat(64)}01` as Hex;
}

/**
 * eth_sign `v` adjustment. Safe contracts specification, `checkNSignatures`: `v > 30` marks a
 * signature produced over the `"\x19Ethereum Signed Message:\n32"`-prefixed hash, so an EOA
 * `personal_sign` result must have 4 added to its recovery id before the Safe will accept it.
 */
function toSafeEthSignSignature(signature: Hex): Hex {
  const bytes = Buffer.from(signature.slice(2), "hex");
  if (bytes.length !== 65) {
    throw new Error(`expected a 65-byte signature, received ${bytes.length} bytes`);
  }
  bytes[64] = bytes[64]! + 4;
  return `0x${bytes.toString("hex")}` as Hex;
}

export function createSafeBroadcaster(input: {
  readonly chainId: number;
  readonly safeAddress: Address;
  readonly publicClient: PublicClient;
  readonly walletClient: WalletClient;
  readonly ledger: SubmissionLedger;
  readonly lock: BroadcastLock;
  readonly options?: SafeBroadcastOptions;
}): BaseVenueSafeBroadcaster {
  const options = input.options ?? {};
  const maxAttempts = options.maxAttempts ?? BROADCAST_DEFAULTS.maxAttempts;
  const baseDelayMs = options.baseDelayMs ?? BROADCAST_DEFAULTS.baseDelayMs;
  const maxDelayMs = options.maxDelayMs ?? BROADCAST_DEFAULTS.maxDelayMs;
  const stuckNonceAfterMs = options.stuckNonceAfterMs ?? BROADCAST_DEFAULTS.stuckNonceAfterMs;
  const now = options.now ?? (() => Date.now());
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  const account = input.walletClient.account;
  if (account === undefined) {
    throw new Error("venue-base requires an injected WalletClient account (signer-injection only)");
  }
  // Re-bound to a definitely-`Account`-typed const: TS does not carry the `undefined` guard's
  // narrowing of `account` into the nested `async function` closures below (`executeInner` et
  // al.), so the raw `account` capture still types as `Account | undefined` at their call sites.
  const signer: Account = account;
  const from = signer.address;

  async function estimateFees(previous: FeeSnapshot | undefined, attemptIndex: number): Promise<FeeSnapshot> {
    try {
      const estimate = await input.publicClient.estimateFeesPerGas();
      return bumpFees(
        {
          ...(estimate.maxFeePerGas === undefined ? {} : { maxFeePerGas: estimate.maxFeePerGas }),
          ...(estimate.maxPriorityFeePerGas === undefined
            ? {}
            : { maxPriorityFeePerGas: estimate.maxPriorityFeePerGas }),
        },
        previous,
        attemptIndex,
      );
    } catch {
      const gasPrice = await input.publicClient.getGasPrice();
      return bumpFees({ gasPrice }, previous, attemptIndex);
    }
  }

  async function decodeInner(request: SafeBroadcastRequest, txHash: Hex | null): Promise<SafeInnerRevertError | undefined> {
    const inner = await decodeSafeInnerRevert(input.publicClient, {
      safeAddress: input.safeAddress,
      to: request.to,
      value: request.value,
      data: request.data,
    });
    if (inner.decodedName !== null) {
      return new SafeInnerRevertError(
        `Safe execTransaction inner revert: ${formatDecodedRevert(inner.decodedName, inner.decodedArgs)}`,
        inner.innerSelector, inner.innerData, inner.decodedName, inner.decodedArgs, txHash,
      );
    }
    if (inner.innerSelector !== null) {
      return new SafeInnerRevertError(
        `Safe execTransaction inner revert (undecoded selector ${inner.innerSelector})`,
        inner.innerSelector, inner.innerData, null, null, txHash,
      );
    }
    return undefined;
  }

  async function assertSignerIsOwner(): Promise<void> {
    const isOwner = await input.publicClient.readContract({
      address: input.safeAddress, abi: SAFE_ABI, functionName: "isOwner", args: [from],
    });
    if (isOwner !== true) {
      throw new Error(
        "Safe execTransaction rejected (GS026: invalid owner — signing key is not a Safe owner). "
        + "Repair the Safe owner set or repoint the agent signing key to a current owner.",
      );
    }
  }

  /** The reconcile step: adopt the ledger's tx at this nonce only when it is provably ours. */
  async function reconcile(nonce: number, request: SafeBroadcastRequest): Promise<SafeBroadcastReceipt | undefined> {
    const existing = input.ledger.get({ chainId: input.chainId, from, nonce });
    if (existing?.txHash === undefined) return undefined;
    const ours = existing.logicalTx === request.logicalTx
      && existing.to?.toLowerCase() === input.safeAddress.toLowerCase()
      && existing.data?.toLowerCase() === request.data.toLowerCase();
    if (!ours) return undefined;
    try {
      const receipt = await input.publicClient.getTransactionReceipt({ hash: existing.txHash });
      if (receipt.status !== "success") return undefined;
      input.ledger.markResolved({ chainId: input.chainId, from, nonce }, now());
      return {
        txHash: existing.txHash, blockNumber: receipt.blockNumber, blockHash: receipt.blockHash,
        logs: receipt.logs, alreadySettled: false,
      };
    } catch {
      return undefined;
    }
  }

  async function executeInner(request: SafeBroadcastRequest): Promise<SafeBroadcastReceipt> {
    await evictStuckNonce({
      chainId: input.chainId, from, publicClient: input.publicClient,
      walletClient: input.walletClient, ledger: input.ledger,
      staleAfterMs: stuckNonceAfterMs, nowMs: now(),
    });
    let pinnedNonce = await input.publicClient.getTransactionCount({ address: from, blockTag: "pending" });
    let lastError: unknown;

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const previous = input.ledger.get({ chainId: input.chainId, from, nonce: pinnedNonce });
      const fees = await estimateFees(previous?.resolvedAtMs === undefined ? previous?.fees : undefined, attempt);
      const safeNonce = await input.publicClient.readContract({
        address: input.safeAddress, abi: SAFE_ABI, functionName: "nonce",
      });
      const safeTxHash = await input.publicClient.readContract({
        address: input.safeAddress, abi: SAFE_ABI, functionName: "getTransactionHash",
        args: [
          request.to, request.value, request.data, request.operation ?? 0,
          0n, 0n, 0n, ZERO_ADDRESS, ZERO_ADDRESS, safeNonce,
        ],
      });
      const signature = toSafeEthSignSignature(
        await input.walletClient.signMessage({ account: signer, message: { raw: safeTxHash as Hex } }) as Hex,
      );

      if (options.maxCostWei !== undefined) {
        const feePerGas = fees.maxFeePerGas ?? fees.gasPrice;
        if (feePerGas === undefined) throw new Error("Safe broadcast fee estimate is unavailable");
        const gas = await input.publicClient.estimateContractGas({
          address: input.safeAddress,
          abi: SAFE_ABI,
          functionName: "execTransaction",
          args: [
            request.to, request.value, request.data, request.operation ?? 0,
            0n, 0n, 0n, ZERO_ADDRESS, ZERO_ADDRESS, signature,
          ],
          account: from,
          value: request.value,
        });
        const exactMaximumWei = gas * feePerGas;
        const cap = options.maxCostWei(request);
        if (cap <= 0n || exactMaximumWei > cap) {
          throw new Error(`Safe broadcast exact gas maximum ${exactMaximumWei} exceeds configured cap ${cap}`);
        }
      }

      let txHash: Hex;
      try {
        // `fees` is a `FeeSnapshot` (`{maxFeePerGas?, maxPriorityFeePerGas?, gasPrice?}`);
        // `estimateFees` only ever actually populates the legacy OR EIP-1559 shape, never both,
        // but `WriteContractParameters` is a discriminated union over exactly that split, which
        // the spread's wider static type can't satisfy without this assertion.
        txHash = await input.walletClient.writeContract({
          address: input.safeAddress, abi: SAFE_ABI, functionName: "execTransaction",
          args: [
            request.to, request.value, request.data, request.operation ?? 0,
            0n, 0n, 0n, ZERO_ADDRESS, ZERO_ADDRESS, signature,
          ],
          account: signer, chain: input.walletClient.chain, value: request.value, nonce: pinnedNonce, ...fees,
        } as unknown as Parameters<typeof input.walletClient.writeContract>[0]);
      } catch (writeError) {
        lastError = writeError;
        const message = flattenError(writeError);
        if (message.includes("GS026")) await assertSignerIsOwner();
        if (message.includes("GS013") || message.includes("GS026")) {
          const inner = await decodeInner(request, null);
          if (inner !== undefined) {
            if (classifyBroadcastError(inner) === "already-settled") {
              return { txHash: "0x" as Hex, blockNumber: 0n, blockHash: "0x" as Hex, logs: [], alreadySettled: true };
            }
            throw inner;
          }
        }
        if (isNonceTooLow(writeError) || isReplacementUnderpriced(writeError)) {
          // The ledger lookup MUST use the ORIGINAL pinned nonce, before it is refreshed: the
          // tx already submitted at that nonce may have mined mid-retry, and re-signing a NEW
          // Safe execTransaction at the advanced Safe nonce is NOT idempotent.
          const reconciled = await reconcile(pinnedNonce, request);
          if (reconciled !== undefined) return reconciled;
          pinnedNonce = await input.publicClient.getTransactionCount({ address: from, blockTag: "pending" });
        }
        if (classifyBroadcastError(writeError) !== "retryable" || attempt === maxAttempts - 1) throw writeError;
        await sleep(Math.min(maxDelayMs, baseDelayMs * 2 ** attempt));
        continue;
      }

      input.ledger.record({
        chainId: input.chainId, from, nonce: pinnedNonce, txHash, logicalTx: request.logicalTx,
        to: input.safeAddress, value: request.value, data: request.data, fees, submittedAtMs: now(),
      });

      const receipt = await input.publicClient.waitForTransactionReceipt({ hash: txHash });
      if (receipt.status === "success") {
        input.ledger.markResolved({ chainId: input.chainId, from, nonce: pinnedNonce }, now());
        return {
          txHash, blockNumber: receipt.blockNumber, blockHash: receipt.blockHash,
          logs: receipt.logs, alreadySettled: false,
        };
      }

      await assertSignerIsOwner();
      const inner = await decodeInner(request, txHash);
      if (inner !== undefined) {
        if (classifyBroadcastError(inner) === "already-settled") {
          input.ledger.markResolved({ chainId: input.chainId, from, nonce: pinnedNonce }, now());
          return {
            txHash, blockNumber: receipt.blockNumber, blockHash: receipt.blockHash,
            logs: receipt.logs, alreadySettled: true,
          };
        }
        throw inner;
      }
      // Re-simulation found no inner revert: a stale Safe nonce or signature race. Re-read and
      // re-sign inside the retry loop; it self-heals.
      lastError = new Error(`Safe execTransaction reverted with no inner revert (txHash=${txHash})`);
      if (attempt === maxAttempts - 1) throw lastError;
      pinnedNonce = await input.publicClient.getTransactionCount({ address: from, blockTag: "pending" });
      await sleep(Math.min(maxDelayMs, baseDelayMs * 2 ** attempt));
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  return {
    classify: classifyBroadcastError,

    async execute(request) {
      return input.lock.withSender(input.chainId, from, () => executeInner(request));
    },

    async broadcastCreateTask(createTask): Promise<PostingOutcome> {
      const receipt = await this.execute({
        to: createTask.to, value: createTask.value, data: createTask.data, logicalTx: "posting.createTask",
      });
      for (const log of receipt.logs) {
        try {
          const decoded = decodeEventLog({
            abi: JINN_ROUTER_V3_ABI, data: log.data, topics: log.topics as [Hex, ...Hex[]], strict: true,
          });
          if (decoded.eventName === "TaskCreated") {
            const args = decoded.args as unknown as { taskId: bigint };
            return { taskId: args.taskId, txHash: receipt.txHash };
          }
        } catch {
          // Not a router event; the Safe receipt carries unrelated logs too.
        }
      }
      throw new Error(`no TaskCreated event in the posting receipt (txHash=${receipt.txHash})`);
    },
  };
}
