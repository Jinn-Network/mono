// SPDX-License-Identifier: MIT

// A deterministic, in-memory viem-client double for the Safe broadcaster's own unit suite
// (`safe-broadcaster.test.ts`). It never touches the network and never holds a private key --
// `signMessage` returns a fixed 65-byte hex string, never a real ECDSA signature (this file is
// exempt from nothing: the signer-injection-only guard scans it like any other production file
// and it carries no key material).
import {
  encodeAbiParameters,
  encodeEventTopics,
  parseAbiParameters,
  type Address,
  type Hex,
  type Log,
  type PublicClient,
  type WalletClient,
} from "viem";
import { JINN_ROUTER_V3_ABI } from "@jinn-network/marketplace-binding";

const FROM = "0x1111111111111111111111111111111111111111" as Address;
const FIXED_SIGNATURE = `0x${"ab".repeat(65)}` as Hex;

interface ReceiptLike {
  readonly status: "success" | "reverted";
  readonly blockNumber: bigint;
  readonly blockHash: Hex;
  readonly logs: readonly Log[];
}

export interface ScriptedWrite {
  readonly address: Address;
  readonly functionName: string;
  readonly args: readonly unknown[];
  readonly value: bigint;
  readonly nonce: number;
  readonly maxFeePerGas?: bigint;
  readonly maxPriorityFeePerGas?: bigint;
  readonly gasPrice?: bigint;
}

interface FailureConfig {
  readonly error: unknown;
  readonly persistent: boolean;
}

export interface ScriptedChain {
  readonly from: Address;
  readonly publicClient: PublicClient;
  readonly walletClient: WalletClient;
  now(): number;
  sleep(ms: number): Promise<void>;
  minedTxHashes(): readonly Hex[];
  submittedNonces(): readonly number[];
  submittedFees(): readonly { maxFeePerGas?: bigint; maxPriorityFeePerGas?: bigint; gasPrice?: bigint }[];
  lastSignature(): Hex | undefined;
  lastWrite(): ScriptedWrite | undefined;
  writeCount(): number;
  failNextWriteWith(error: unknown): void;
  failEveryWriteWith(error: unknown): void;
  setPendingNonce(nonce: number): void;
  seedMinedTx(hash: Hex, nonce: number): void;
  setInnerRevert(selector: Hex): void;
  revertNextReceipt(): void;
  emitTaskCreated(taskId: bigint): void;
}

function buildTaskCreatedLog(taskId: bigint): Log {
  const manifestDigest = `0x${"0".repeat(64)}` as Hex;
  const topics = encodeEventTopics({
    abi: JINN_ROUTER_V3_ABI,
    eventName: "TaskCreated",
    args: { creator: FROM, taskId, manifestDigest },
  });
  const data = encodeAbiParameters(
    parseAbiParameters("bytes32 taskCidDigest, uint32 maxClaims, uint256 solutionBudget, uint256 verdictBudget"),
    [`0x${"1".repeat(64)}` as Hex, 1, 0n, 0n],
  );
  return {
    address: FROM,
    topics,
    data,
    blockHash: `0x${"2".repeat(64)}` as Hex,
    blockNumber: 1n,
    logIndex: 0,
    transactionHash: `0x${"3".repeat(64)}` as Hex,
    transactionIndex: 0,
    removed: false,
  } as Log;
}

/** Builds a scripted, in-memory chain double: no network, no real signatures, fully deterministic. */
export function buildScriptedChain(options: { readonly signerIsOwner?: boolean } = {}): ScriptedChain {
  const signerIsOwner = options.signerIsOwner ?? true;

  let txNonceCounter = 0;
  let pendingOverride: number | undefined;
  let safeNonceCounter = 0n;
  let hashCounter = 0;

  const writes: ScriptedWrite[] = [];
  const signatures: Hex[] = [];
  const minedHashes: Hex[] = [];
  const receiptsByHash = new Map<Hex, ReceiptLike>();

  let nextFailure: FailureConfig | undefined;
  let innerRevertSelector: Hex | undefined;
  let revertNextReceiptFlag = false;
  let pendingTaskCreatedId: bigint | undefined;

  function nextHash(): Hex {
    hashCounter += 1;
    return `0x${hashCounter.toString(16).padStart(64, "0")}` as Hex;
  }

  const publicClient = {
    async readContract({ functionName }: { readonly functionName: string }) {
      if (functionName === "nonce") return safeNonceCounter;
      if (functionName === "getTransactionHash") {
        return `0x${(safeNonceCounter + 1n).toString(16).padStart(64, "0")}` as Hex;
      }
      if (functionName === "isOwner") return signerIsOwner;
      throw new Error(`scripted chain: unexpected readContract "${functionName}"`);
    },
    async estimateFeesPerGas() {
      return { maxFeePerGas: 1_000_000_000n, maxPriorityFeePerGas: 100_000_000n };
    },
    async estimateContractGas() {
      return 21_000n;
    },
    async getTransactionCount({ blockTag }: { readonly blockTag: "pending" | "latest" }) {
      if (blockTag === "pending") return pendingOverride ?? txNonceCounter;
      return txNonceCounter;
    },
    async waitForTransactionReceipt({ hash }: { readonly hash: Hex }) {
      const entry = receiptsByHash.get(hash);
      if (entry === undefined) throw new Error(`scripted chain: no receipt registered for ${hash}`);
      minedHashes.push(hash);
      txNonceCounter += 1;
      return { status: entry.status, blockNumber: entry.blockNumber, blockHash: entry.blockHash, logs: entry.logs };
    },
    async getTransactionReceipt({ hash }: { readonly hash: Hex }) {
      const entry = receiptsByHash.get(hash);
      if (entry === undefined || entry.status !== "success") {
        throw new Error(`scripted chain: no successful receipt for ${hash}`);
      }
      return { status: entry.status, blockNumber: entry.blockNumber, blockHash: entry.blockHash, logs: entry.logs };
    },
    async call() {
      if (innerRevertSelector !== undefined) {
        const error = new Error("scripted chain: simulated inner revert") as Error & { data?: Hex };
        error.data = innerRevertSelector;
        throw error;
      }
      return { data: "0x" as Hex };
    },
  } as unknown as PublicClient;

  const walletClient = {
    account: { address: FROM },
    chain: undefined,
    async signMessage() {
      return FIXED_SIGNATURE;
    },
    async writeContract(request: {
      readonly address: Address;
      readonly functionName: string;
      readonly args: readonly unknown[];
      readonly value: bigint;
      readonly nonce: number;
      readonly maxFeePerGas?: bigint;
      readonly maxPriorityFeePerGas?: bigint;
      readonly gasPrice?: bigint;
    }) {
      writes.push({
        address: request.address,
        functionName: request.functionName,
        args: request.args,
        value: request.value,
        nonce: request.nonce,
        ...(request.maxFeePerGas === undefined ? {} : { maxFeePerGas: request.maxFeePerGas }),
        ...(request.maxPriorityFeePerGas === undefined ? {} : { maxPriorityFeePerGas: request.maxPriorityFeePerGas }),
        ...(request.gasPrice === undefined ? {} : { gasPrice: request.gasPrice }),
      });
      signatures.push(request.args[9] as Hex);

      if (nextFailure !== undefined) {
        const { error, persistent } = nextFailure;
        if (!persistent) nextFailure = undefined;
        throw error;
      }

      const hash = nextHash();
      const status: "success" | "reverted" = revertNextReceiptFlag ? "reverted" : "success";
      revertNextReceiptFlag = false;
      const logs = pendingTaskCreatedId === undefined ? [] : [buildTaskCreatedLog(pendingTaskCreatedId)];
      pendingTaskCreatedId = undefined;
      if (status === "success") safeNonceCounter += 1n;
      receiptsByHash.set(hash, { status, blockNumber: 1n, blockHash: `0x${"9".repeat(64)}` as Hex, logs });
      return hash;
    },
    async sendTransaction() {
      throw new Error("scripted chain: sendTransaction is not exercised by the broadcaster unit suite");
    },
  } as unknown as WalletClient;

  return {
    from: FROM,
    publicClient,
    walletClient,
    now: () => 1_000,
    sleep: async () => {},
    minedTxHashes: () => [...minedHashes],
    submittedNonces: () => writes.map((write) => write.nonce),
    submittedFees: () => writes.map((write) => ({
      ...(write.maxFeePerGas === undefined ? {} : { maxFeePerGas: write.maxFeePerGas }),
      ...(write.maxPriorityFeePerGas === undefined ? {} : { maxPriorityFeePerGas: write.maxPriorityFeePerGas }),
      ...(write.gasPrice === undefined ? {} : { gasPrice: write.gasPrice }),
    })),
    lastSignature: () => signatures.at(-1),
    lastWrite: () => writes.at(-1),
    writeCount: () => writes.length,
    failNextWriteWith(error) {
      nextFailure = { error, persistent: false };
    },
    failEveryWriteWith(error) {
      nextFailure = { error, persistent: true };
    },
    setPendingNonce(nonce) {
      pendingOverride = nonce;
    },
    seedMinedTx(hash) {
      receiptsByHash.set(hash, { status: "success", blockNumber: 1n, blockHash: `0x${"8".repeat(64)}` as Hex, logs: [] });
    },
    setInnerRevert(selector) {
      innerRevertSelector = selector;
    },
    revertNextReceipt() {
      revertNextReceiptFlag = true;
    },
    emitTaskCreated(taskId) {
      pendingTaskCreatedId = taskId;
    },
  };
}
