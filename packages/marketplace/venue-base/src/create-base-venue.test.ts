// SPDX-License-Identifier: MIT

// The facade's own wiring invariants (design §6, program §5): one broadcaster, one state file,
// signer-injection enforcement, and generation-conditional port shapes. Each underlying port's
// own behavior is already unit-tested (Tasks 6-16); this file never re-proves it.
import { mkdtempSync, rmSync } from "node:fs";
import Database from "better-sqlite3";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Address, Hex, WalletClient } from "viem";
import { BASE_SEPOLIA_TODAY, type MarketplaceChainConfig } from "@jinn-network/marketplace-binding";
import type {
  ClaimPorts, DeliveryWaitPort, FinalityPort, MarketplaceLifecyclePorts, MarketplaceObservePort,
  PostingIntentStore, ReleaseAttemptPort, SettlementPorts,
} from "@jinn-network/marketplace-binding";
import type { SafeBroadcastPort } from "@jinn-network/marketplace-binding";
import { buildScriptedChain } from "./broadcast/scripted-chain.fixture.js";
import { createBaseVenue, type BaseVenue } from "./create-base-venue.js";
import type { BaseVenueConfig } from "./config.js";

const SAFE = "0x5afe000000000000000000000000000000000000" as Address;

const REVISED: MarketplaceChainConfig = { ...BASE_SEPOLIA_TODAY, generation: "revised" };

let root: string;
let dbPath: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "venue-facade-"));
  dbPath = join(root, "venue.db");
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function baseConfig(
  chain: MarketplaceChainConfig,
  chainInstance: ReturnType<typeof buildScriptedChain>,
  overrides: Partial<BaseVenueConfig> = {},
): BaseVenueConfig {
  return {
    chain,
    publicClient: chainInstance.publicClient,
    walletClient: chainInstance.walletClient,
    safeAddress: SAFE,
    stateDbPath: dbPath,
    priorityMech: "0x3333333333333333333333333333333333333333" as Address,
    pin: async () => {},
    verifySettlementGrade: async () => {
      throw new Error("not exercised by the facade wiring test");
    },
    isAuthorizedMechOrigin: () => true,
    observations: async () => [],
    broadcast: { now: chainInstance.now, sleep: chainInstance.sleep },
    ...overrides,
  };
}

describe("createBaseVenue (Task 17 -- the composition surface program §5 pins)", () => {
  test("returns all eleven named members plus close, including the feature-disabled verdict port", () => {
    const chainInstance = buildScriptedChain();
    const venue = createBaseVenue(baseConfig(BASE_SEPOLIA_TODAY, chainInstance));
    try {
      const claim: ClaimPorts = venue.claim;
      const settlement: SettlementPorts = venue.settlement;
      const lifecycle: MarketplaceLifecyclePorts = venue.lifecycle;
      const finality: FinalityPort = venue.finality;
      const deliveryWait: DeliveryWaitPort = venue.deliveryWait;
      const release: ReleaseAttemptPort = venue.release;
      const observe: MarketplaceObservePort = venue.observe;
      const safe: SafeBroadcastPort = venue.safe;
      const intents: PostingIntentStore = venue.intents;
      const verdict = venue.verdict;
      expect(claim).toBeDefined();
      expect(settlement).toBeDefined();
      expect(lifecycle).toBeDefined();
      expect(finality).toBeDefined();
      expect(deliveryWait).toBeDefined();
      expect(release).toBeDefined();
      expect(observe).toBeDefined();
      expect(safe).toBeDefined();
      expect(venue.logSource).toBeDefined();
      expect(intents).toBeDefined();
      expect(verdict).toBeDefined();
      expect(typeof venue.close).toBe("function");
    } finally {
      venue.close();
    }
  });

  test("one broadcaster instance backs claim, settlement, lifecycle and posting", async () => {
    const chainInstance = buildScriptedChain();
    const venue = createBaseVenue(baseConfig(BASE_SEPOLIA_TODAY, chainInstance));
    try {
      const spy = vi.spyOn(venue.safe, "execute");

      await venue.claim.claimTask({ taskId: 1n, priorityMech: venue.claim.priorityMech }).catch(() => {});

      const wrappedPublicClient = chainInstance.publicClient as unknown as {
        readContract: (args: { readonly functionName: string }) => Promise<unknown>;
      };
      const originalReadContract = wrappedPublicClient.readContract.bind(wrappedPublicClient);
      wrappedPublicClient.readContract = async (args) =>
        args.functionName === "claimed" ? false : originalReadContract(args);
      await venue.settlement
        .claimSolutionDelivery({ requestId: `0x${"1".repeat(64)}` as Hex, solutionDigest: `0x${"2".repeat(64)}` as Hex })
        .catch(() => {});
      wrappedPublicClient.readContract = originalReadContract;

      await (venue.lifecycle as { refundUnusedTaskBudget?: (input: { taskId: bigint }) => Promise<void> })
        .refundUnusedTaskBudget?.({ taskId: 1n })
        .catch(() => {});

      chainInstance.emitTaskCreated(2n);
      await venue.safe
        .broadcastCreateTask({ safeAddress: SAFE, to: BASE_SEPOLIA_TODAY.jinnRouter, value: 0n, data: "0xdeadbeef" as Hex })
        .catch(() => {});

      expect(spy).toHaveBeenCalledTimes(4);
    } finally {
      venue.close();
    }
  });

  test("one state database backs the ledger, cursors, intents, cancel signals and observe store", async () => {
    const chainInstance = buildScriptedChain();
    // `buildScriptedChain` mocks only the Safe-broadcast surface (Task 8's own unit-test double);
    // extend it with the minimal block/log surface `ChainLogSource.poll()` needs, exactly like
    // `chain-log-source.test.ts`'s own scripted chain, so a single `poll()` call writes a cursor.
    const publicClientWithBlocks = {
      ...chainInstance.publicClient,
      async getBlock() {
        return { number: 1n, hash: `0x${"7".repeat(64)}` as Hex };
      },
      async getLogs() {
        return [];
      },
    } as unknown as typeof chainInstance.publicClient;
    const venue = createBaseVenue(
      baseConfig(BASE_SEPOLIA_TODAY, chainInstance, { publicClient: publicClientWithBlocks }),
    );
    try {
      await (venue.lifecycle as { refundUnusedTaskBudget?: (input: { taskId: bigint }) => Promise<void> })
        .refundUnusedTaskBudget?.({ taskId: 1n })
        .catch(() => {});
      await venue.logSource.poll().catch(() => {});
      await venue.intents.claim({
        creatorSafe: SAFE, taskCidDigest: `sha256:${"a".repeat(64)}` as `sha256:${string}`,
        submissionDigest: `sha256:${"b".repeat(64)}` as `sha256:${string}`,
        idempotencyKey: "idem-1", createdAt: new Date().toISOString(),
      });
      await venue.lifecycle.requestCancel({
        attempt: "urn:uuid:00000000-0000-0000-0000-000000000001" as `urn:uuid:${string}`,
        taskId: 1n, attemptIndex: 0, reason: "test",
      });
      await venue.observe.claimSubmissionScope({
        requester: "0x9999999999999999999999999999999999999999",
        idempotencyKey: "idem-scope-1",
        submissionUri: "urn:uuid:00000000-0000-0000-0000-000000000002" as `urn:uuid:${string}`,
        digest: `sha256:${"c".repeat(64)}` as `sha256:${string}`,
        submissionBytes: new Uint8Array([1, 2, 3]),
        taskDigest: `sha256:${"a".repeat(64)}` as `sha256:${string}`,
        creatorSafe: SAFE,
        venueNamespace: "test:venue",
        commandDigest: `sha256:${"d".repeat(64)}`,
        postingIntentKey: `${SAFE.toLowerCase()}|sha256:${"a".repeat(64)}|sha256:${"c".repeat(64)}`,
      });
    } finally {
      venue.close();
    }
    const db = new Database(dbPath, { readonly: true });
    try {
      const count = (table: string): number =>
        (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
      expect(count("tx_submissions")).toBeGreaterThan(0);
      expect(count("log_cursors")).toBeGreaterThan(0);
      expect(count("posting_intents")).toBeGreaterThan(0);
      expect(count("cancel_signals")).toBeGreaterThan(0);
      expect(count("submission_scopes")).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });

  test("close() closes the database and further use throws", async () => {
    const chainInstance = buildScriptedChain();
    const venue = createBaseVenue(baseConfig(BASE_SEPOLIA_TODAY, chainInstance));
    venue.close();
    await expect(venue.logSource.poll()).rejects.toThrow();
  });

  test("constructing with a walletClient that has no account throws, naming signer injection", () => {
    const chainInstance = buildScriptedChain();
    const noAccountWallet = { ...chainInstance.walletClient, account: undefined } as unknown as WalletClient;
    expect(() =>
      createBaseVenue(baseConfig(BASE_SEPOLIA_TODAY, chainInstance, { walletClient: noAccountWallet })),
    ).toThrow(/signer-injection/);
  });

  test("settlement.settleRevisedSolutionDelivery is undefined for today-generation and defined for revised", () => {
    const today = createBaseVenue(baseConfig(BASE_SEPOLIA_TODAY, buildScriptedChain()));
    const revised = createBaseVenue(baseConfig(REVISED, buildScriptedChain(), { stateDbPath: join(root, "revised.db") }));
    try {
      expect(today.settlement.settleRevisedSolutionDelivery).toBeUndefined();
      expect(revised.settlement.settleRevisedSolutionDelivery).toBeDefined();
    } finally {
      today.close();
      revised.close();
    }
  });

  test("today-only V3 verdict ports are unavailable on revised-generation venues", () => {
    const today = createBaseVenue(baseConfig(BASE_SEPOLIA_TODAY, buildScriptedChain()));
    const revised = createBaseVenue(baseConfig(REVISED, buildScriptedChain(), { stateDbPath: join(root, "revised-verdict.db") }));
    try {
      expect(today.verdict).toBeDefined();
      expect(revised.verdict).toBeUndefined();
    } finally {
      today.close();
      revised.close();
    }
  });

  test("lifecycle.closeTask / lifecycle.releaseAttempt follow the same generation conditionality", () => {
    const today = createBaseVenue(baseConfig(BASE_SEPOLIA_TODAY, buildScriptedChain()));
    const revised = createBaseVenue(baseConfig(REVISED, buildScriptedChain(), { stateDbPath: join(root, "revised2.db") }));
    try {
      const todayLifecycle = today.lifecycle as { closeTask?: unknown };
      const revisedLifecycle = revised.lifecycle as { closeTask?: unknown };
      expect(todayLifecycle.closeTask).toBeUndefined();
      expect(revisedLifecycle.closeTask).toBeDefined();
      expect(today.release.forfeitDeliveredReservation).toBeUndefined();
      expect(revised.release.forfeitDeliveredReservation).toBeDefined();
    } finally {
      today.close();
      revised.close();
    }
  });

  test("refuses a second BaseVenue owner for an active state path, then releases it on close", () => {
    const chainA = buildScriptedChain();
    const chainB = buildScriptedChain();
    const venueA = createBaseVenue(baseConfig(BASE_SEPOLIA_TODAY, chainA));
    try {
      expect(() =>
        createBaseVenue(baseConfig(BASE_SEPOLIA_TODAY, chainB, { stateDbPath: dbPath })),
      ).toThrow(/already owned/i);
    } finally {
      venueA.close();
    }
    const replacement = createBaseVenue(baseConfig(BASE_SEPOLIA_TODAY, chainB, { stateDbPath: dbPath }));
    replacement.close();
  });
});
