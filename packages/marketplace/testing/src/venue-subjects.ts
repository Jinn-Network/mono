// SPDX-License-Identifier: MIT

// Adapts `createBaseVenue`'s real output (and the per-port factories underneath it) to the three
// kit subject interfaces (design §6.6, plan Task 17 Step 5). Every subject built here drives the
// REAL `@jinn-network/marketplace-venue-base` implementation -- never a stand-in -- so a kit
// failure means the fresh rewrite diverges from the legacy oracle, not that the fixture is wrong.
// The broadcast() and logSource() subjects wire the real Safe broadcaster / chain log source
// against a scripted, in-memory viem-client double (no network); fork() drives `createBaseVenue`
// itself against a live Anvil fork (`venue-fork.ts`). The well-known Anvil dev key here is the
// one private-key literal this plan allows anywhere in this component (it never appears in
// `venue-base`).
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createPublicClient, createWalletClient, http,
  type Address, type Hex, type Log, type PublicClient, type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { BASE_SEPOLIA_TODAY, keccakEvidenceHash } from "@jinn-network/marketplace-binding";
import {
  classifyBroadcastError,
  createBroadcastLock,
  createChainLogSource,
  createSafeBroadcaster,
  createSubmissionLedger,
  isNonceTooLow,
  isReplacementUnderpriced,
  openVenueState,
  type BaseVenue,
  type BaseVenueConfig,
} from "@jinn-network/marketplace-venue-base";
import type { BroadcastConformanceSubject, BroadcastScenarioChain } from "./venue-broadcast-conformance.js";
import type { LogSourceConformanceSubject, LogSourceScenarioChain } from "./venue-log-source-conformance.js";
import type { ForkVenueDeployment, ForkVenueSubject } from "./venue-fork.js";

// The well-known Anvil dev key (Anvil's default account 0). Test-only funds on an ephemeral fork.
const DEV_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as Hex;

const FROM = "0x1111111111111111111111111111111111111111" as Address;
const SAFE = "0x2222222222222222222222222222222222222222" as Address;
const FIXED_SIGNATURE = `0x${"ab".repeat(65)}` as Hex;

/**
 * A fresh on-disk state file. `openVenueState` requires WAL journaling (`state/database.ts`),
 * which SQLite refuses on a `:memory:` handle -- every subject needs a real (throwaway) file.
 */
function freshStateDbPath(): string {
  return join(mkdtempSync(join(tmpdir(), "venue-subjects-")), "venue.db");
}

// ---------------------------------------------------------------------------------------------
// broadcast(): the real Safe broadcaster against a scripted chain double.
// ---------------------------------------------------------------------------------------------

interface RecordedAttempt {
  readonly nonce: number;
  readonly txHash: Hex;
  logicalTx?: string;
  to?: Address;
  data?: Hex;
  value?: bigint;
  readonly submittedAtMs: number;
  resolvedAtMs?: number;
  readonly fees: { maxFeePerGas?: bigint; maxPriorityFeePerGas?: bigint; gasPrice?: bigint };
}

function buildBroadcastSubject(): { subject: BroadcastConformanceSubject; chain: BroadcastScenarioChain } {
  let clockMs = 1_000;
  let pendingCounter = 0;
  let latestCounter = 0;
  let pendingOverride: number | undefined;
  let safeNonceCounter = 0n;
  let hashCounter = 0;
  let currentLogicalTx: string | undefined;

  const attempts: RecordedAttempt[] = [];
  const attemptsByNonce = new Map<number, Hex[]>();
  const minedHashes: Hex[] = [];
  const receiptsByHash = new Map<Hex, { status: "success"; blockNumber: bigint; blockHash: Hex; logs: readonly Log[] }>();
  const failQueue: unknown[] = [];

  function nextHash(): Hex {
    hashCounter += 1;
    return `0x${hashCounter.toString(16).padStart(64, "0")}` as Hex;
  }

  let queue: Promise<unknown> = Promise.resolve();
  function serialize<T>(fn: () => Promise<T>): Promise<T> {
    const turn = queue.then(fn, fn);
    queue = turn.then(() => undefined, () => undefined);
    return turn;
  }

  function isGenericTransient(error: unknown): boolean {
    return classifyBroadcastError(error) === "retryable"
      && !isNonceTooLow(error) && !isReplacementUnderpriced(error);
  }

  const state = openVenueState(freshStateDbPath());
  const ledger = createSubmissionLedger(state);
  const lock = createBroadcastLock(state, { now: () => clockMs, sleep: async () => {} });

  const publicClient = {
    async readContract({ functionName }: { readonly functionName: string }) {
      if (functionName === "nonce") return safeNonceCounter;
      if (functionName === "getTransactionHash") {
        return `0x${(safeNonceCounter + 1n).toString(16).padStart(64, "0")}` as Hex;
      }
      if (functionName === "isOwner") return true;
      throw new Error(`venue-subjects broadcast chain: unexpected readContract "${functionName}"`);
    },
    async estimateFeesPerGas() {
      return { maxFeePerGas: 1_000_000_000n, maxPriorityFeePerGas: 100_000_000n };
    },
    async getTransactionCount({ blockTag }: { readonly blockTag: "pending" | "latest" }) {
      if (blockTag === "pending" && pendingOverride !== undefined) return pendingOverride;
      return blockTag === "pending" ? pendingCounter : latestCounter;
    },
    async waitForTransactionReceipt({ hash }: { readonly hash: Hex }) {
      const entry = receiptsByHash.get(hash);
      if (entry === undefined) throw new Error(`venue-subjects broadcast chain: no receipt for ${hash}`);
      return entry;
    },
    async getTransactionReceipt({ hash }: { readonly hash: Hex }) {
      const entry = receiptsByHash.get(hash);
      if (entry === undefined) throw new Error(`venue-subjects broadcast chain: no receipt for ${hash}`);
      return entry;
    },
    async call() {
      return { data: "0x" as Hex };
    },
  } as unknown as PublicClient;

  function mine(hash: Hex, nonce: number): void {
    minedHashes.push(hash);
    receiptsByHash.set(hash, { status: "success", blockNumber: 1n, blockHash: `0x${"9".repeat(64)}` as Hex, logs: [] });
    safeNonceCounter += 1n;
    latestCounter = Math.max(latestCounter, nonce + 1);
    pendingCounter = Math.max(pendingCounter, nonce + 1);
  }

  const walletClient = {
    account: { address: FROM },
    chain: undefined,
    async signMessage() {
      return FIXED_SIGNATURE;
    },
    async writeContract(request: {
      readonly nonce: number;
      readonly maxFeePerGas?: bigint;
      readonly maxPriorityFeePerGas?: bigint;
      readonly gasPrice?: bigint;
    }) {
      const nonce = request.nonce;
      const fees = {
        ...(request.maxFeePerGas === undefined ? {} : { maxFeePerGas: request.maxFeePerGas }),
        ...(request.maxPriorityFeePerGas === undefined ? {} : { maxPriorityFeePerGas: request.maxPriorityFeePerGas }),
        ...(request.gasPrice === undefined ? {} : { gasPrice: request.gasPrice }),
      };
      const attemptHash = nextHash();
      const list = attemptsByNonce.get(nonce) ?? [];
      list.push(attemptHash);
      attemptsByNonce.set(nonce, list);
      attempts.push({
        nonce, txHash: attemptHash, logicalTx: currentLogicalTx, submittedAtMs: clockMs, fees,
      });

      if (failQueue.length > 0) {
        const error = failQueue.shift();
        if (isNonceTooLow(error)) {
          // An external actor's transaction has already landed at (at least) this nonce.
          pendingCounter = Math.max(pendingCounter, nonce + 1);
          latestCounter = Math.max(latestCounter, nonce + 1);
        }
        throw error;
      }

      mine(attemptHash, nonce);
      const row = attempts.at(-1);
      if (row !== undefined) { row.resolvedAtMs = clockMs; }
      return attemptHash;
    },
    async sendTransaction(request: { readonly nonce: number; readonly to: Address; readonly value: bigint }) {
      // The stuck-nonce self-send (`stuck-nonce.ts`): tracked directly, WITHOUT touching
      // `currentLogicalTx` -- that variable belongs to the in-flight `writeContract` caller, and
      // eviction runs nested inside it (at the top of `executeInner`, before any write).
      const hash = nextHash();
      const list = attemptsByNonce.get(request.nonce) ?? [];
      list.push(hash);
      attemptsByNonce.set(request.nonce, list);
      mine(hash, request.nonce);
      attempts.push({
        nonce: request.nonce, txHash: hash, logicalTx: "stuck-nonce-recovery", to: request.to,
        value: request.value, submittedAtMs: clockMs, resolvedAtMs: clockMs, fees: {},
      });
      return hash;
    },
  } as unknown as WalletClient;

  const broadcaster = createSafeBroadcaster({
    chainId: 84532,
    safeAddress: SAFE,
    publicClient,
    walletClient,
    ledger,
    lock,
    options: { now: () => clockMs, sleep: async () => {} },
  });

  function resolvedMatch(logicalTx: string, data: Hex, value: bigint): RecordedAttempt | undefined {
    return attempts.find(
      (entry) => entry.resolvedAtMs !== undefined && entry.logicalTx === logicalTx
        && entry.data === data && entry.value === value,
    );
  }

  const subject: BroadcastConformanceSubject = {
    async submissions() {
      return attempts.map((entry) => ({
        chainId: 84532,
        from: FROM,
        nonce: entry.nonce,
        txHash: entry.txHash,
        ...(entry.logicalTx === undefined ? {} : { logicalTx: entry.logicalTx }),
        ...(entry.to === undefined ? {} : { to: entry.to }),
        ...(entry.data === undefined ? {} : { data: entry.data }),
        ...(entry.value === undefined ? {} : { value: entry.value }),
        submittedAtMs: entry.submittedAtMs,
        ...(entry.resolvedAtMs === undefined ? {} : { resolvedAtMs: entry.resolvedAtMs }),
        fees: entry.fees,
      }));
    },
    async execute(request) {
      // Serialized at the subject level: `currentLogicalTx`/`pendingOverride` are read inside
      // the broadcaster's own (also-serialized) retry loop, but set here, one JS tick earlier --
      // without this queue, two `execute()` calls awaited via `Promise.all` could interleave
      // their synchronous prefixes and clobber each other's closure state before either reaches
      // the broadcaster's internal lock.
      const turn = serialize(async () => {
        // Simulate a stale `pending` read for a byte-identical replay of an already-mined
        // operation: this is the exact real-world condition `reconcile()` exists to recover from.
        const priorMatch = resolvedMatch(request.logicalTx, request.data, request.value);
        pendingOverride = priorMatch?.nonce;
        currentLogicalTx = request.logicalTx;
        try {
          return await broadcaster.execute(request);
        } finally {
          pendingOverride = undefined;
        }
      });
      const receipt = await turn;
      const row = attempts.find((entry) => entry.txHash === receipt.txHash);
      if (row !== undefined) { row.to = request.to; row.data = request.data; row.value = request.value; }
      return { txHash: receipt.txHash };
    },
    classify: classifyBroadcastError,
  };

  const chain: BroadcastScenarioChain = {
    failNextSubmissionWith(error) {
      if (isGenericTransient(error)) {
        // A network-transient failure represents a submission that WAS broadcast (occupying a
        // mempool slot) even though its acknowledgment was lost -- an orphan that is already
        // stale by the time this test's `advanceClock` runs.
        const nonce = pendingCounter;
        pendingCounter += 1;
        const hash = nextHash();
        ledger.record({
          chainId: 84532, from: FROM, nonce, txHash: hash, logicalTx: "orphaned-network-failure",
          to: SAFE, value: 0n, data: "0x" as Hex, fees: { maxFeePerGas: 1_000_000_000n, maxPriorityFeePerGas: 100_000_000n },
          submittedAtMs: clockMs,
        });
        return;
      }
      failQueue.push(error);
    },
    pendingNonce: () => pendingCounter,
    latestNonce: () => latestCounter,
    advanceClock(ms) { clockMs += ms; },
    minedTxHashes: () => [...minedHashes],
    replacedAtNonce: (nonce) => [...(attemptsByNonce.get(nonce) ?? [])],
  };

  return { subject, chain };
}

// ---------------------------------------------------------------------------------------------
// logSource(): the real chunked log source against a scripted, block-mining chain double.
// ---------------------------------------------------------------------------------------------

const LOG_SOURCE_CHUNK_BLOCKS = 10n;

interface LogSourceFixture {
  readonly blocks: Hex[];
  finalizedOverride: bigint | undefined;
  hashSeed: number;
  readonly stateDbPath: string;
}

// The kit's own "resumable" obligation calls `build()` TWICE within one test -- once, closes the
// subject, then again, expecting the SECOND subject to pick up the persisted cursor over the SAME
// chain. `venue-conformance.test.ts` clears this between tests (`afterEach`) so every OTHER test
// still gets a fresh chain and a fresh state file.
let currentLogSourceFixture: LogSourceFixture | undefined;

export function resetLogSourceFixture(): void {
  currentLogSourceFixture = undefined;
}

function buildLogSourceSubject(): {
  subject: LogSourceConformanceSubject;
  chain: LogSourceScenarioChain;
  chunkBlocks: bigint;
} {
  const fixture: LogSourceFixture = currentLogSourceFixture ?? {
    blocks: [], finalizedOverride: undefined, hashSeed: 0, stateDbPath: freshStateDbPath(),
  };
  if (currentLogSourceFixture === undefined) currentLogSourceFixture = fixture;
  const { blocks } = fixture;
  const ranges: { fromBlock: bigint; toBlock: bigint }[] = [];

  function freshHash(): Hex {
    fixture.hashSeed += 1;
    return `0x${fixture.hashSeed.toString(16).padStart(64, "0")}` as Hex;
  }
  function mine(count: number): void {
    for (let index = 0; index < count; index += 1) blocks.push(freshHash());
  }
  if (blocks.length === 0) mine(1); // genesis (block 0), only for a brand-new fixture

  const publicClient = {
    async getBlock(args: { readonly blockTag?: "latest" | "finalized"; readonly blockNumber?: bigint } = {}) {
      if (args.blockNumber !== undefined) {
        const hash = blocks[Number(args.blockNumber)];
        if (hash === undefined) throw new Error(`venue-subjects log-source chain: no block ${args.blockNumber}`);
        return { number: args.blockNumber, hash };
      }
      if (args.blockTag === "finalized") {
        const number = fixture.finalizedOverride ?? BigInt(blocks.length - 1);
        return { number, hash: blocks[Number(number)]! };
      }
      const number = BigInt(blocks.length - 1);
      return { number, hash: blocks[Number(number)]! };
    },
    async getLogs(args: { readonly address: readonly Address[]; readonly fromBlock: bigint; readonly toBlock: bigint }) {
      ranges.push({ fromBlock: args.fromBlock, toBlock: args.toBlock });
      return [];
    },
  } as unknown as PublicClient;

  const state = openVenueState(fixture.stateDbPath);
  const logSource = createChainLogSource({
    chain: BASE_SEPOLIA_TODAY,
    publicClient,
    state,
    addresses: [BASE_SEPOLIA_TODAY.jinnRouter],
    options: { chunkBlocks: LOG_SOURCE_CHUNK_BLOCKS, startBlock: 0n },
  });

  const subject: LogSourceConformanceSubject = {
    async poll() {
      const batch = await logSource.poll();
      return {
        logs: batch.logs.map((log) => ({ blockNumber: log.blockNumber, blockHash: log.blockHash })),
        cursor: batch.cursor,
        finalizedCheckpoint: batch.finalizedCheckpoint,
        ...(batch.reorg === undefined ? {} : { reorg: batch.reorg }),
      };
    },
    close() { logSource.close(); state.close(); },
  };

  const chain: LogSourceScenarioChain = {
    requestedRanges: () => [...ranges],
    mine,
    setFinalized(blockNumber) { fixture.finalizedOverride = blockNumber; },
    reorgFrom(blockNumber) {
      for (let index = Number(blockNumber); index < blocks.length; index += 1) blocks[index] = freshHash();
    },
  };

  return { subject, chain, chunkBlocks: LOG_SOURCE_CHUNK_BLOCKS };
}

// ---------------------------------------------------------------------------------------------
// fork(): the real createBaseVenue against a live Anvil fork (venue-fork.ts's deployment).
// ---------------------------------------------------------------------------------------------

async function buildForkSubject(
  deployment: ForkVenueDeployment,
  createVenue: (config: BaseVenueConfig) => BaseVenue,
): Promise<ForkVenueSubject> {
  const account = privateKeyToAccount(DEV_KEY);
  const publicClient = createPublicClient({ transport: http(deployment.rpcUrl) });
  const walletClient = createWalletClient({ account, transport: http(deployment.rpcUrl) });

  const venue = createVenue({
    chain: deployment.chain,
    publicClient,
    walletClient,
    safeAddress: deployment.safe,
    stateDbPath: deployment.stateDbPath,
    priorityMech: deployment.mech,
    pin: async () => {},
    verifySettlementGrade: async () => {
      throw new Error("verifySettlementGrade is not exercised by the fork conformance subject");
    },
    isAuthorizedMechOrigin: (address) => address.toLowerCase() === deployment.mech.toLowerCase(),
    observations: async () => [],
  });

  return {
    async claim(taskId) {
      return venue.claim.claimTask({ taskId, priorityMech: deployment.mech });
    },
    async settle({ requestId, deliveryBytes }) {
      const solutionDigest = keccakEvidenceHash(deliveryBytes);
      const result = await venue.settlement.claimSolutionDelivery({ requestId, solutionDigest });
      return { settled: result.status === "settled" || result.status === "already-settled" };
    },
    close() { venue.close(); },
  };
}

export function buildVenueSubjects(): {
  broadcast(): Promise<{ subject: BroadcastConformanceSubject; chain: BroadcastScenarioChain }>;
  logSource(): Promise<{ subject: LogSourceConformanceSubject; chain: LogSourceScenarioChain; chunkBlocks: bigint }>;
  fork(
    deployment: ForkVenueDeployment,
    createVenue: (config: BaseVenueConfig) => BaseVenue,
  ): Promise<ForkVenueSubject>;
} {
  return {
    async broadcast() { return buildBroadcastSubject(); },
    async logSource() { return buildLogSourceSubject(); },
    async fork(deployment, createVenue) { return buildForkSubject(deployment, createVenue); },
  };
}

// Re-derives a fresh classifier bound to the real, exported `classifyBroadcastError` -- kept as a
// named factory (matching the plan's own call shape) even though the underlying function takes
// no construction-time state.
export function createBaseVenueClassifier(): (error: unknown) => ReturnType<typeof classifyBroadcastError> {
  return classifyBroadcastError;
}
