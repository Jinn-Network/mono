// SPDX-License-Identifier: MIT

// A small in-memory relayer proving the broadcast-profile driver's obligations are satisfiable
// (design §7 ruling 1, plan Task 4 Step 1). Not a production implementation: `venue-base`'s real
// Safe broadcaster is written independently against the same driver.
import type { Address, Hex } from "viem";
import type {
  BroadcastConformanceSubject,
  BroadcastScenarioChain,
} from "./venue-broadcast-conformance.js";
import type { VenueRevertClassification } from "./venue-fixtures.js";

const STALE_WINDOW_MS = 120_000;
const FEE_BUMP_NUMERATOR = 120n;
const FEE_BUMP_DENOMINATOR = 100n;
const MAX_ATTEMPTS = 10;

interface Fees {
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}

type MutableEntry = {
  chainId: number;
  from: Address;
  nonce: number;
  txHash?: Hex;
  logicalTx?: string;
  to?: Address;
  data?: Hex;
  value?: bigint;
  submittedAtMs: number;
  resolvedAtMs?: number;
  fees: Fees;
};

function classify(error: unknown): VenueRevertClassification {
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();
  if (lower.includes("gs013") || lower.includes("gs026")) return "permanent";
  if (lower.includes("insufficient funds") || lower.includes("user rejected")) return "permanent";
  if (lower.includes("nonce too low")) return "retryable";
  if (lower.includes("replacement") || lower.includes("underpriced")) return "retryable";
  if (lower.includes("socket hang up") || lower.includes("econnreset") || lower.includes("etimedout")) {
    return "retryable";
  }
  if (lower.includes("timed out") || lower.includes("fetch failed")) return "retryable";
  return "permanent";
}

export function buildReferenceBroadcaster(options: {
  readonly from: Address;
}): { subject: BroadcastConformanceSubject; chain: BroadcastScenarioChain } {
  const chainId = 1;
  const from = options.from;

  let cursor = 0;
  let confirmedNonce = 0;
  let simClockMs = 0;
  let pinnedSince = 0;
  let txCounter = 0;

  const failQueue: unknown[] = [];
  const attemptsByNonce = new Map<number, Hex[]>();
  const minedHashes: Hex[] = [];
  const ledger: MutableEntry[] = [];

  function nextTxHash(): Hex {
    txCounter += 1;
    return `0x${txCounter.toString(16).padStart(64, "0")}` as Hex;
  }

  /** The one place a submission touches the fake chain: records the attempt, then either
   * throws the next queued failure (bumping the confirmed nonce first when the failure models
   * an external actor consuming the assigned nonce) or mines the tx. */
  async function chainSubmit(nonce: number): Promise<Hex> {
    const hash = nextTxHash();
    const attempts = attemptsByNonce.get(nonce) ?? [];
    attempts.push(hash);
    attemptsByNonce.set(nonce, attempts);

    if (failQueue.length > 0) {
      const error = failQueue.shift();
      const message = error instanceof Error ? error.message : String(error);
      if (message.toLowerCase().includes("nonce too low")) {
        confirmedNonce += 1;
      }
      throw error;
    }

    minedHashes.push(hash);
    if (nonce >= confirmedNonce) confirmedNonce = nonce + 1;
    return hash;
  }

  function pushRow(fields: Omit<MutableEntry, "chainId" | "from" | "submittedAtMs">): MutableEntry {
    const row: MutableEntry = { chainId, from, submittedAtMs: Date.now(), ...fields };
    ledger.push(row);
    return row;
  }

  function initialFees(): Fees {
    return { maxFeePerGas: 1_000_000_000n, maxPriorityFeePerGas: 100_000_000n };
  }

  function bumpFees(fees: Fees): Fees {
    return {
      maxFeePerGas: (fees.maxFeePerGas * FEE_BUMP_NUMERATOR) / FEE_BUMP_DENOMINATOR,
      maxPriorityFeePerGas: (fees.maxPriorityFeePerGas * FEE_BUMP_NUMERATOR) / FEE_BUMP_DENOMINATOR,
    };
  }

  function findResolved(request: {
    readonly to: Address;
    readonly value: bigint;
    readonly data: Hex;
    readonly logicalTx: string;
  }): MutableEntry | undefined {
    return ledger.find(
      (entry) =>
        entry.resolvedAtMs !== undefined &&
        entry.logicalTx === request.logicalTx &&
        entry.to === request.to &&
        entry.data === request.data &&
        entry.value === request.value,
    );
  }

  /** Broadcasts one logical operation, following nonce-too-low refresh and fee-bump replacement
   * until it lands or a permanent classification aborts the loop. */
  async function broadcast(
    logicalTx: string | undefined,
    to: Address,
    data: Hex,
    value: bigint,
  ): Promise<Hex> {
    let nonce = cursor;
    cursor += 1;
    pinnedSince = simClockMs;
    let fees = initialFees();
    let row = pushRow({ nonce, to, data, value, logicalTx, fees });

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      try {
        const hash = await chainSubmit(nonce);
        row.txHash = hash;
        row.resolvedAtMs = Date.now();
        return hash;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const lower = message.toLowerCase();
        if (lower.includes("nonce too low")) {
          nonce = confirmedNonce;
          if (cursor <= nonce) cursor = nonce + 1;
          pinnedSince = simClockMs;
          row = pushRow({ nonce, to, data, value, logicalTx, fees });
          continue;
        }
        if (lower.includes("replacement") || lower.includes("underpriced")) {
          fees = bumpFees(fees);
          row = pushRow({ nonce, to, data, value, logicalTx, fees });
          continue;
        }
        if (classify(error) === "permanent") throw error;
        // Generic transient failure: retry the same (nonce, fees) pair.
        continue;
      }
    }
    throw new Error("retry budget exhausted");
  }

  /** Before pinning a nonce for real work, evict a nonce that has sat reserved-but-unused past
   * the stale window with a zero-value self-send (design §7 ruling 1's stuck-nonce eviction). */
  async function maybeEvictStuckNonce(): Promise<void> {
    if (simClockMs - pinnedSince < STALE_WINDOW_MS) return;
    await broadcast("stuck-nonce-recovery", from, "0x" as Hex, 0n);
  }

  const subject: BroadcastConformanceSubject = {
    async submissions() {
      return ledger.map((entry) => ({ ...entry }));
    },
    async execute(request) {
      await maybeEvictStuckNonce();
      const existing = findResolved(request);
      if (existing) return { txHash: existing.txHash! };
      const txHash = await broadcast(request.logicalTx, request.to, request.data, request.value);
      return { txHash };
    },
    classify,
  };

  const chain: BroadcastScenarioChain = {
    failNextSubmissionWith(error) {
      failQueue.push(error);
    },
    pendingNonce() {
      return cursor;
    },
    latestNonce() {
      return confirmedNonce;
    },
    advanceClock(ms) {
      simClockMs += ms;
    },
    minedTxHashes() {
      return [...minedHashes];
    },
    replacedAtNonce(nonce) {
      return [...(attemptsByNonce.get(nonce) ?? [])];
    },
  };

  return { subject, chain };
}
