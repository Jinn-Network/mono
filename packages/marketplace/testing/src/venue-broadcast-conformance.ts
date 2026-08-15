// SPDX-License-Identifier: MIT

// The named Defender-relayer profile as executable obligations (design §7 ruling 1): per-sender
// serialized nonce assignment, a persistent (chainId, from, nonce) submission ledger,
// fee-bumped replacement, stuck-nonce eviction, reconcile-on-nonce-too-low. Every scenario is
// derived from the legacy oracles `operator/src/tx-retry.ts` and
// `operator/src/adapters/mech/safe.ts` -- as cases, never as ported code (design §6.6).
import { describe, expect, test } from "vitest";
import type { Address, Hex } from "viem";
import type { VenueRevertClassification } from "./venue-fixtures.js";

export interface BroadcastLedgerEntry {
  readonly chainId: number;
  readonly from: Address;
  readonly nonce: number;
  readonly txHash?: Hex;
  readonly logicalTx?: string;
  readonly to?: Address;
  readonly data?: Hex;
  /** Native value carried by the submission. Populated by the stuck-nonce self-send eviction case. */
  readonly value?: bigint;
  readonly submittedAtMs: number;
  readonly resolvedAtMs?: number;
  readonly fees: {
    readonly maxFeePerGas?: bigint;
    readonly maxPriorityFeePerGas?: bigint;
    readonly gasPrice?: bigint;
  };
}

export interface BroadcastConformanceSubject {
  submissions(): Promise<readonly BroadcastLedgerEntry[]>;
  execute(request: {
    readonly to: Address;
    readonly value: bigint;
    readonly data: Hex;
    readonly logicalTx: string;
  }): Promise<{ readonly txHash: Hex }>;
  classify(error: unknown): VenueRevertClassification;
}

export interface BroadcastScenarioChain {
  failNextSubmissionWith(error: unknown): void;
  pendingNonce(): number;
  latestNonce(): number;
  advanceClock(ms: number): void;
  minedTxHashes(): readonly Hex[];
  replacedAtNonce(nonce: number): readonly Hex[];
}

const TO = "0x2222222222222222222222222222222222222222" as Address;
const DATA = "0xdeadbeef" as Hex;

export function describeBroadcastProfileConformance(
  build: () => Promise<{ subject: BroadcastConformanceSubject; chain: BroadcastScenarioChain }>,
): void {
  describe("Safe broadcast relayer-profile conformance", () => {
    test("records one durable ledger row keyed (chainId, from, nonce) before the tx resolves", async () => {
      const { subject } = await build();
      const receipt = await subject.execute({ to: TO, value: 0n, data: DATA, logicalTx: "claim" });
      const entries = await subject.submissions();
      expect(entries).toHaveLength(1);
      expect(entries[0]!.txHash).toBe(receipt.txHash);
      expect(entries[0]!.logicalTx).toBe("claim");
      expect(entries[0]!.to).toBe(TO);
      expect(entries[0]!.data).toBe(DATA);
      expect(entries[0]!.resolvedAtMs).toBeGreaterThan(0);
    });

    test("assigns strictly increasing nonces when two logical operations run concurrently", async () => {
      const { subject } = await build();
      await Promise.all([
        subject.execute({ to: TO, value: 0n, data: DATA, logicalTx: "claim" }),
        subject.execute({ to: TO, value: 0n, data: DATA, logicalTx: "settle" }),
      ]);
      const nonces = (await subject.submissions()).map((entry) => entry.nonce).sort((a, b) => a - b);
      expect(nonces).toEqual([nonces[0], nonces[0]! + 1]);
    });

    test("a `nonce too low` failure refreshes the pinned nonce instead of resubmitting the stale one", async () => {
      const { subject, chain } = await build();
      chain.failNextSubmissionWith(new Error("nonce too low"));
      await subject.execute({ to: TO, value: 0n, data: DATA, logicalTx: "claim" });
      const entries = await subject.submissions();
      const used = entries.map((entry) => entry.nonce);
      expect(new Set(used).size).toBe(used.length);
      expect(Math.max(...used)).toBe(chain.latestNonce() - 1);
    });

    test("`nonce too low` reconciles against this call's own already-mined ledger tx and does not re-sign", async () => {
      const { subject, chain } = await build();
      const first = await subject.execute({ to: TO, value: 0n, data: DATA, logicalTx: "settle" });
      chain.failNextSubmissionWith(new Error("nonce too low"));
      const replay = await subject.execute({ to: TO, value: 0n, data: DATA, logicalTx: "settle" });
      expect(replay.txHash).toBe(first.txHash);
      expect(chain.minedTxHashes().filter((hash) => hash === first.txHash)).toHaveLength(1);
    });

    test("`replacement transaction underpriced` re-submits at the same nonce with a bumped fee", async () => {
      const { subject, chain } = await build();
      chain.failNextSubmissionWith(new Error("replacement transaction underpriced"));
      await subject.execute({ to: TO, value: 0n, data: DATA, logicalTx: "claim" });
      const entries = await subject.submissions();
      const nonce = entries[0]!.nonce;
      const replacements = chain.replacedAtNonce(nonce);
      expect(replacements.length).toBeGreaterThanOrEqual(2);
      const bumped = entries.at(-1)!.fees.maxFeePerGas ?? entries.at(-1)!.fees.gasPrice ?? 0n;
      const original = entries[0]!.fees.maxFeePerGas ?? entries[0]!.fees.gasPrice ?? 0n;
      expect(bumped * 10000n).toBeGreaterThanOrEqual(original * 11500n);
    });

    test("a stuck nonce older than the stale window is evicted by a self-send before the next assignment", async () => {
      const { subject, chain } = await build();
      chain.failNextSubmissionWith(new Error("socket hang up"));
      chain.advanceClock(130_000);
      await subject.execute({ to: TO, value: 0n, data: DATA, logicalTx: "claim" });
      const recovery = (await subject.submissions()).find(
        (entry) => entry.logicalTx === "stuck-nonce-recovery",
      );
      expect(recovery).toBeDefined();
      expect(recovery!.value ?? 0n).toBe(0n);
      expect(recovery!.resolvedAtMs).toBeGreaterThan(0);
      expect(chain.pendingNonce()).toBe(chain.latestNonce());
    });

    test("a permanent inner revert fails fast without burning the retry budget", async () => {
      const { subject, chain } = await build();
      const permanent = new Error("execution reverted: GS013");
      chain.failNextSubmissionWith(permanent);
      await expect(
        subject.execute({ to: TO, value: 0n, data: DATA, logicalTx: "claim" }),
      ).rejects.toThrow(/GS013/u);
      expect(subject.classify(permanent)).toBe("permanent");
    });
  });
}
