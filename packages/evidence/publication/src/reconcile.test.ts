// SPDX-License-Identifier: Apache-2.0
import {
  createRecordReference,
  type Sha256Digest,
} from "@jinn-network/evidence-repository";
import {
  InMemoryEvidenceRepository,
} from "@jinn-network/evidence-repository/testing";
import { describe, expect, test } from "vitest";

import {
  EvidencePublicationError,
} from "./errors.js";
import {
  derivePublicationIdentities,
  normalizePublishInput,
} from "./identities.js";
import { publish } from "./publish.js";
import { reconcile } from "./reconcile.js";
import {
  InMemoryAnnouncementSink,
  InMemoryPublicationJournalStore,
} from "./testing.js";
import type {
  AnnouncementSink,
  PendingAnnouncement,
  PlaceResult,
  PublicationJournalEntry,
  PublicationJournalStore,
  PublishInput,
  ReconcileResult,
  VersionedPublicationJournalEntry,
} from "./types.js";

function input(): PublishInput {
  const bytes = new Uint8Array([1]);
  return {
    records: [{
      reference: createRecordReference("execution-evidence", bytes),
      bytes,
    }],
    destination: "urn:jinn:publication-destination:reconcile-test",
  };
}

function sink(): InMemoryAnnouncementSink {
  return new InMemoryAnnouncementSink({
    medium: "https://publication.test/medium",
    profile: "https://publication.test/profiles/canonical-json/v1",
  });
}

describe("publication placement recovery", () => {
  test("accepts safe own sink result fields on null-prototype and class instances", async () => {
    const repository = new InMemoryEvidenceRepository();
    const journal = new InMemoryPublicationJournalStore();
    const delegate = sink();
    let extensionGetterCalls = 0;
    const placement = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(placement, "externalId", {
      configurable: false,
      enumerable: false,
      writable: false,
      value: "urn:jinn:placement:class-result",
    });
    Object.defineProperty(placement, "futureExtension", {
      configurable: false,
      enumerable: false,
      get: () => {
        extensionGetterCalls += 1;
        throw new Error("must not evaluate extension");
      },
    });
    Object.freeze(placement);
    class Result {
      readonly status = "placed" as const;
      readonly placement = placement;

      get futureExtension(): never {
        extensionGetterCalls += 1;
        throw new Error("must not evaluate extension");
      }
    }
    const announcementSink: AnnouncementSink = {
      medium: delegate.medium,
      profile: delegate.profile,
      capabilities: delegate.capabilities,
      prepare: delegate.prepare.bind(delegate),
      place: async () =>
        Object.freeze(new Result()) as unknown as PlaceResult,
      reconcile: delegate.reconcile.bind(delegate),
    };

    const receipt = await publish(input(), {
      repository,
      journal,
      sink: announcementSink,
    });

    expect(receipt.placements[0]?.placement.externalId).toBe(
      "urn:jinn:placement:class-result",
    );
    expect(extensionGetterCalls).toBe(0);
  });

  test("accepts safe own reconciliation fields without enumerability restrictions", async () => {
    const repository = new InMemoryEvidenceRepository();
    const journal = new InMemoryPublicationJournalStore();
    const delegate = sink();
    let interrupt = true;
    delegate.beforePlace = () => {
      if (!interrupt) return;
      interrupt = false;
      throw new EvidencePublicationError(
        "OPERATION_ABORTED",
        "fixture interruption",
      );
    };
    await expect(
      publish(input(), { repository, journal, sink: delegate }),
    ).rejects.toMatchObject({ code: "OPERATION_ABORTED" });

    const result = Object.create(null) as Record<string, unknown>;
    Object.defineProperties(result, {
      status: {
        configurable: false,
        enumerable: false,
        writable: false,
        value: "existing",
      },
      placement: {
        configurable: false,
        enumerable: false,
        writable: false,
        value: Object.freeze({ externalId: "urn:jinn:placement:reconciled" }),
      },
    });
    Object.preventExtensions(result);
    const announcementSink: AnnouncementSink = {
      medium: delegate.medium,
      profile: delegate.profile,
      capabilities: delegate.capabilities,
      prepare: delegate.prepare.bind(delegate),
      place: delegate.place.bind(delegate),
      reconcile: async () => result as unknown as ReconcileResult,
    };

    const receipt = await publish(input(), {
      repository,
      journal,
      sink: announcementSink,
    });

    expect(receipt.placements[0]?.placement.externalId).toBe(
      "urn:jinn:placement:reconciled",
    );
  });

  test.each(["status", "placement", "externalId"] as const)(
    "rejects accessor-backed required sink field %s without evaluating it",
    async (field) => {
      const repository = new InMemoryEvidenceRepository();
      const journal = new InMemoryPublicationJournalStore();
      const delegate = sink();
      let getterCalls = 0;
      const placement = { externalId: "urn:jinn:placement:fixture" };
      const result: Record<string, unknown> = {
        status: "placed",
        placement,
      };
      const target = field === "externalId" ? placement : result;
      Object.defineProperty(target, field, {
        configurable: true,
        get: () => {
          getterCalls += 1;
          return field === "status"
            ? "placed"
            : field === "placement"
            ? placement
            : "urn:jinn:placement:fixture";
        },
      });
      const announcementSink: AnnouncementSink = {
        medium: delegate.medium,
        profile: delegate.profile,
        capabilities: delegate.capabilities,
        prepare: delegate.prepare.bind(delegate),
        place: async () => result as unknown as PlaceResult,
        reconcile: delegate.reconcile.bind(delegate),
      };

      await expect(
        publish(input(), {
          repository,
          journal,
          sink: announcementSink,
        }),
      ).rejects.toMatchObject({ code: "SINK_PROTOCOL_VIOLATION" });
      expect(getterCalls).toBe(0);
    },
  );

  test("rejects a proxied sink result before invoking reflection traps", async () => {
    const repository = new InMemoryEvidenceRepository();
    const journal = new InMemoryPublicationJournalStore();
    const delegate = sink();
    let trapCalls = 0;
    const result = new Proxy(
      {
        status: "placed" as const,
        placement: { externalId: "urn:jinn:placement:proxy" },
      },
      {
        get: (target, key, receiver) => {
          trapCalls += 1;
          return Reflect.get(target, key, receiver);
        },
        getOwnPropertyDescriptor: (target, key) => {
          trapCalls += 1;
          return Reflect.getOwnPropertyDescriptor(target, key);
        },
        ownKeys: (target) => {
          trapCalls += 1;
          return Reflect.ownKeys(target);
        },
      },
    );
    const promisedResult = Promise.resolve(result);
    const promiseAssimilationTrapCalls = trapCalls;
    const announcementSink: AnnouncementSink = {
      medium: delegate.medium,
      profile: delegate.profile,
      capabilities: delegate.capabilities,
      prepare: delegate.prepare.bind(delegate),
      place: () => promisedResult,
      reconcile: delegate.reconcile.bind(delegate),
    };

    await expect(
      publish(input(), {
        repository,
        journal,
        sink: announcementSink,
      }),
    ).rejects.toMatchObject({ code: "SINK_PROTOCOL_VIOLATION" });
    expect(trapCalls).toBe(promiseAssimilationTrapCalls);
  });

  test("rejects proxied opaque pending bytes without invoking traps", async () => {
    const repository = new InMemoryEvidenceRepository();
    const journal = new InMemoryPublicationJournalStore();
    const delegate = sink();
    let trapCalls = 0;
    const bytes = new Proxy(Uint8Array.of(0, 255, 7), {
      get: (target, key, receiver) => {
        trapCalls += 1;
        return Reflect.get(target, key, receiver);
      },
      getOwnPropertyDescriptor: (target, key) => {
        trapCalls += 1;
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    });
    const announcementSink: AnnouncementSink = {
      medium: delegate.medium,
      profile: delegate.profile,
      capabilities: delegate.capabilities,
      prepare: delegate.prepare.bind(delegate),
      place: async (prepared, idempotencyKey) => ({
        status: "pending",
        pending: {
          idempotencyKey,
          frameDigest: prepared.frameDigest,
          state: {
            format: "https://publication.test/pending-state/v1",
            bytes,
          },
        },
      }),
      reconcile: delegate.reconcile.bind(delegate),
    };

    await expect(
      publish(input(), {
        repository,
        journal,
        sink: announcementSink,
      }),
    ).rejects.toMatchObject({ code: "SINK_PROTOCOL_VIOLATION" });
    expect(trapCalls).toBe(0);
  });

  test("rejects accessor-backed opaque pending bytes without invoking them", async () => {
    const repository = new InMemoryEvidenceRepository();
    const journal = new InMemoryPublicationJournalStore();
    const delegate = sink();
    let getterCalls = 0;
    const state = {
      format: "https://publication.test/pending-state/v1",
      bytes: Uint8Array.of(0, 255, 7),
    };
    Object.defineProperty(state, "bytes", {
      configurable: true,
      get: () => {
        getterCalls += 1;
        return Uint8Array.of(0, 255, 7);
      },
    });
    const announcementSink: AnnouncementSink = {
      medium: delegate.medium,
      profile: delegate.profile,
      capabilities: delegate.capabilities,
      prepare: delegate.prepare.bind(delegate),
      place: async (prepared, idempotencyKey) => ({
        status: "pending",
        pending: {
          idempotencyKey,
          frameDigest: prepared.frameDigest,
          state,
        },
      }),
      reconcile: delegate.reconcile.bind(delegate),
    };

    await expect(
      publish(input(), {
        repository,
        journal,
        sink: announcementSink,
      }),
    ).rejects.toMatchObject({ code: "SINK_PROTOCOL_VIOLATION" });
    expect(getterCalls).toBe(0);
  });

  test("reconciles a lost placement response before any retry", async () => {
    const repository = new InMemoryEvidenceRepository();
    const journal = new InMemoryPublicationJournalStore();
    const delegate = sink();
    let loseResponse = true;
    const uncertain: AnnouncementSink = {
      medium: delegate.medium,
      profile: delegate.profile,
      capabilities: delegate.capabilities,
      prepare: delegate.prepare.bind(delegate),
      reconcile: delegate.reconcile.bind(delegate),
      place: async (prepared, idempotencyKey, options) => {
        const result = await delegate.place(
          prepared,
          idempotencyKey,
          options,
        );
        if (loseResponse) {
          loseResponse = false;
          throw new EvidencePublicationError(
            "PLACEMENT_UNCERTAIN",
            "fixture lost response",
          );
        }
        return result;
      },
    };

    await expect(
      publish(input(), { repository, journal, sink: uncertain }),
    ).rejects.toMatchObject({ code: "PLACEMENT_UNCERTAIN" });
    expect(delegate.placementEffectCount).toBe(1);

    const receipt = await publish(input(), {
      repository,
      journal,
      sink: uncertain,
    });

    expect(receipt.completed).toBe(true);
    expect(delegate.placementEffectCount).toBe(1);
    expect(delegate.reconcileCallCount).toBe(1);
  });

  test("keeps durable prepared state isolated from sink.place mutation", async () => {
    const repository = new InMemoryEvidenceRepository();
    const journal = new InMemoryPublicationJournalStore();
    const delegate = sink();
    let placeCalls = 0;
    let reconcileCalls = 0;
    const mutating: AnnouncementSink = {
      medium: delegate.medium,
      profile: delegate.profile,
      capabilities: delegate.capabilities,
      prepare: delegate.prepare.bind(delegate),
      place: async (prepared, idempotencyKey, options) => {
        placeCalls += 1;
        const safePrepared = structuredClone(prepared);
        if (placeCalls === 1) {
          prepared.frameBytes[0] = (prepared.frameBytes[0] ?? 0) ^ 0xff;
          (
            prepared.members[0]!.reference as {
              digest: string;
            }
          ).digest =
            "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
        }
        return delegate.place(safePrepared, idempotencyKey, options);
      },
      reconcile: async (prepared, pending, options) => {
        reconcileCalls += 1;
        return delegate.reconcile(prepared, pending, options);
      },
    };

    const receipt = await publish(input(), {
      repository,
      journal,
      sink: mutating,
    });

    expect(receipt.completed).toBe(true);
    expect(placeCalls).toBe(1);
    expect(reconcileCalls).toBe(0);
    expect(delegate.placementEffectCount).toBe(1);
  });

  test("keeps durable prepared and pending state isolated from sink.reconcile mutation", async () => {
    const repository = new InMemoryEvidenceRepository();
    const journal = new InMemoryPublicationJournalStore();
    const delegate = sink();
    const pendingSink: AnnouncementSink = {
      medium: delegate.medium,
      profile: delegate.profile,
      capabilities: delegate.capabilities,
      prepare: delegate.prepare.bind(delegate),
      place: async (prepared, idempotencyKey, options) => {
        await delegate.place(prepared, idempotencyKey, options);
        return {
          status: "pending",
          pending: {
            idempotencyKey,
            frameDigest: prepared.frameDigest,
            state: {
              format: "https://publication.test/pending-state/v1",
              bytes: Uint8Array.of(7, 8, 9),
            },
          },
        };
      },
      reconcile: delegate.reconcile.bind(delegate),
    };
    await expect(
      publish(input(), { repository, journal, sink: pendingSink }),
    ).rejects.toMatchObject({ code: "PLACEMENT_UNCERTAIN" });

    let reconcileCalls = 0;
    const mutating: AnnouncementSink = {
      ...pendingSink,
      reconcile: async (prepared, pending, options) => {
        reconcileCalls += 1;
        const safePrepared = structuredClone(prepared);
        const safePending = structuredClone(pending);
        if (reconcileCalls === 1) {
          prepared.frameBytes[0] = (prepared.frameBytes[0] ?? 0) ^ 0xff;
          (
            prepared.members[0]!.reference as {
              digest: string;
            }
          ).digest =
            "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
          pending.state!.bytes[0] = 99;
        }
        return delegate.reconcile(safePrepared, safePending, options);
      },
    };

    const receipt = await publish(input(), {
      repository,
      journal,
      sink: mutating,
    });

    expect(receipt.completed).toBe(true);
    expect(reconcileCalls).toBe(1);
    expect(delegate.placementEffectCount).toBe(1);
  });

  test("calls place only after reconciliation reports authoritative absence", async () => {
    const repository = new InMemoryEvidenceRepository();
    const journal = new InMemoryPublicationJournalStore();
    const delegate = sink();
    let interrupt = true;
    delegate.beforePlace = () => {
      if (!interrupt) return;
      interrupt = false;
      throw new EvidencePublicationError(
        "OPERATION_ABORTED",
        "fixture interruption",
      );
    };

    await expect(
      publish(input(), { repository, journal, sink: delegate }),
    ).rejects.toMatchObject({ code: "OPERATION_ABORTED" });
    expect(delegate.placementEffectCount).toBe(0);

    const receipt = await publish(input(), {
      repository,
      journal,
      sink: delegate,
    });
    expect(receipt.completed).toBe(true);
    expect(delegate.reconcileCallCount).toBe(1);
    expect(delegate.placementEffectCount).toBe(1);
  });

  test("checkpoints opaque pending state and preserves exact bytes", async () => {
    const repository = new InMemoryEvidenceRepository();
    const journal = new InMemoryPublicationJournalStore();
    const delegate = sink();
    const stateBytes = new Uint8Array([0, 255, 7]);
    let pendingReturned = false;
    const pendingSink: AnnouncementSink = {
      medium: delegate.medium,
      profile: delegate.profile,
      capabilities: delegate.capabilities,
      prepare: delegate.prepare.bind(delegate),
      place: async (prepared, idempotencyKey, options) => {
        await delegate.place(prepared, idempotencyKey, options);
        pendingReturned = true;
        return {
          status: "pending",
          pending: {
            idempotencyKey,
            frameDigest: prepared.frameDigest,
            state: {
              format: "https://publication.test/pending-state/v1",
              bytes: stateBytes,
            },
          },
        };
      },
      reconcile: delegate.reconcile.bind(delegate),
    };

    await expect(
      publish(input(), { repository, journal, sink: pendingSink }),
    ).rejects.toMatchObject({ code: "PLACEMENT_UNCERTAIN" });
    expect(pendingReturned).toBe(true);

    const current = journal.entries()[0]!;
    const pending = current.preparedPartitions?.[0]?.placement;
    expect(pending).toEqual({
      status: "pending",
      pending: {
        idempotencyKey: expect.stringMatching(/^sha256:/u),
        frameDigest:
          current.preparedPartitions?.[0]?.prepared.frameDigest,
        state: {
          format: "https://publication.test/pending-state/v1",
          bytes: stateBytes,
        },
      },
    });
  });

  test("converges when a competing pending checkpoint winner is confirmed", async () => {
    const repository = new InMemoryEvidenceRepository();
    const journal = new InMemoryPublicationJournalStore();
    const delegate = sink();
    const pendingSink: AnnouncementSink = {
      medium: delegate.medium,
      profile: delegate.profile,
      capabilities: delegate.capabilities,
      prepare: delegate.prepare.bind(delegate),
      place: async (prepared, idempotencyKey, options) => {
        await delegate.place(prepared, idempotencyKey, options);
        return {
          status: "pending",
          pending: {
            idempotencyKey,
            frameDigest: prepared.frameDigest,
            state: {
              format: "https://publication.test/pending-state/v1",
              bytes: Uint8Array.of(1),
            },
          },
        };
      },
      reconcile: async (prepared, pending) => ({
        status: "pending",
        pending: {
          idempotencyKey: pending.idempotencyKey,
          frameDigest: prepared.frameDigest,
          state: {
            format: "https://publication.test/pending-state/v2",
            bytes: Uint8Array.of(2),
          },
        },
      }),
    };
    await expect(
      publish(input(), { repository, journal, sink: pendingSink }),
    ).rejects.toMatchObject({ code: "PLACEMENT_UNCERTAIN" });

    let winnerInjected = false;
    const racingJournal: PublicationJournalStore = {
      load: journal.load.bind(journal),
      create: journal.create.bind(journal),
      compareAndSwap: async (
        expected: VersionedPublicationJournalEntry,
        next: PublicationJournalEntry,
        options,
      ) => {
        const currentPlacement =
          expected.preparedPartitions?.[0]?.placement;
        const proposedPlacement =
          next.preparedPartitions?.[0]?.placement;
        if (
          !winnerInjected &&
          currentPlacement?.status === "pending" &&
          proposedPlacement?.status === "pending"
        ) {
          winnerInjected = true;
          await journal.compareAndSwap(expected, {
            ...expected,
            preparedPartitions: expected.preparedPartitions!.map(
              (partition) =>
                partition.ordinal === 0
                  ? {
                    ...partition,
                    placement: {
                      status: "confirmed" as const,
                      result: "existing" as const,
                      placement: {
                        externalId:
                          "urn:jinn:placement:concurrent-winner",
                      },
                    },
                  }
                  : partition,
            ),
          });
          throw new EvidencePublicationError(
            "JOURNAL_CONFLICT",
            "A concurrent writer confirmed the placement.",
          );
        }
        return journal.compareAndSwap(expected, next, options);
      },
    };

    const receipt = await publish(input(), {
      repository,
      journal: racingJournal,
      sink: pendingSink,
    });

    expect(winnerInjected).toBe(true);
    expect(receipt.completed).toBe(true);
    expect(receipt.placements[0]?.placement.externalId).toBe(
      "urn:jinn:placement:concurrent-winner",
    );
    expect(delegate.placementEffectCount).toBe(1);
  });

  test("surfaces unchanged state-less place pending without a no-op CAS", async () => {
    const repository = new InMemoryEvidenceRepository();
    const journal = new InMemoryPublicationJournalStore();
    const delegate = sink();
    const pendingSink: AnnouncementSink = {
      medium: delegate.medium,
      profile: delegate.profile,
      capabilities: delegate.capabilities,
      prepare: delegate.prepare.bind(delegate),
      place: async (prepared, idempotencyKey, options) => {
        await delegate.place(prepared, idempotencyKey, options);
        return {
          status: "pending",
          pending: {
            idempotencyKey,
            frameDigest: prepared.frameDigest,
          },
        };
      },
      reconcile: delegate.reconcile.bind(delegate),
    };

    await expect(
      publish(input(), {
        repository,
        journal,
        sink: pendingSink,
      }),
    ).rejects.toMatchObject({ code: "PLACEMENT_UNCERTAIN" });
    const afterPending = journal.entries()[0]!;
    expect(afterPending.preparedPartitions?.[0]?.placement).toEqual({
      status: "pending",
      pending: {
        idempotencyKey: expect.stringMatching(/^sha256:/u),
        frameDigest:
          afterPending.preparedPartitions?.[0]?.prepared.frameDigest,
      },
    });
    expect(delegate.placementEffectCount).toBe(1);

    const receipt = await publish(input(), {
      repository,
      journal,
      sink: pendingSink,
    });
    expect(receipt.completed).toBe(true);
    expect(delegate.reconcileCallCount).toBe(1);
    expect(delegate.placementEffectCount).toBe(1);
  });

  test("surfaces unchanged state-less reconcile pending without a no-op CAS", async () => {
    const repository = new InMemoryEvidenceRepository();
    const journal = new InMemoryPublicationJournalStore();
    const delegate = sink();
    let interrupt = true;
    delegate.beforePlace = () => {
      if (!interrupt) return;
      interrupt = false;
      throw new EvidencePublicationError(
        "OPERATION_ABORTED",
        "fixture interruption",
      );
    };
    await expect(
      publish(input(), { repository, journal, sink: delegate }),
    ).rejects.toMatchObject({ code: "OPERATION_ABORTED" });
    const intent = journal.entries()[0]!;
    const intentRevision = intent.revision;
    const pendingPlacement = intent.preparedPartitions?.[0]?.placement;
    if (pendingPlacement?.status !== "pending") {
      throw new Error("fixture expected a durable state-less intent");
    }
    let remainPending = true;
    const pendingSink: AnnouncementSink = {
      medium: delegate.medium,
      profile: delegate.profile,
      capabilities: delegate.capabilities,
      prepare: delegate.prepare.bind(delegate),
      place: delegate.place.bind(delegate),
      reconcile: async (prepared, pending, options) => {
        if (remainPending) {
          return {
            status: "pending",
            pending: {
              idempotencyKey: pending.idempotencyKey,
              frameDigest: prepared.frameDigest,
            },
          };
        }
        return delegate.reconcile(prepared, pending, options);
      },
    };

    await expect(
      publish(input(), {
        repository,
        journal,
        sink: pendingSink,
      }),
    ).rejects.toMatchObject({ code: "PLACEMENT_UNCERTAIN" });
    expect(journal.entries()[0]?.revision).toBe(intentRevision);
    expect(
      journal.entries()[0]?.preparedPartitions?.[0]?.placement,
    ).toEqual(pendingPlacement);
    expect(delegate.placementEffectCount).toBe(0);

    remainPending = false;
    const receipt = await publish(input(), {
      repository,
      journal,
      sink: pendingSink,
    });
    expect(receipt.completed).toBe(true);
    expect(delegate.placementEffectCount).toBe(1);
  });

  test("maps a confirmed reversion to a permanent publication failure", async () => {
    const repository = new InMemoryEvidenceRepository();
    const journal = new InMemoryPublicationJournalStore();
    const delegate = sink();
    let interrupted = true;
    delegate.beforePlace = () => {
      if (!interrupted) return;
      interrupted = false;
      throw new EvidencePublicationError(
        "OPERATION_ABORTED",
        "fixture interruption",
      );
    };
    await expect(
      publish(input(), { repository, journal, sink: delegate }),
    ).rejects.toMatchObject({ code: "OPERATION_ABORTED" });

    const reverted: AnnouncementSink = {
      medium: delegate.medium,
      profile: delegate.profile,
      capabilities: delegate.capabilities,
      prepare: delegate.prepare.bind(delegate),
      place: delegate.place.bind(delegate),
      reconcile: async () => ({
        status: "reverted",
        externalId: "urn:jinn:placement:reverted",
        reason: "fixture",
      }),
    };
    await expect(
      publish(input(), { repository, journal, sink: reverted }),
    ).rejects.toMatchObject({ code: "PLACEMENT_REVERTED" });
    expect(delegate.placementEffectCount).toBe(0);
  });

  test("rejects a frozen prepared profile mismatch before sink effects", async () => {
    const repository = new InMemoryEvidenceRepository();
    const journal = new InMemoryPublicationJournalStore();
    const original = sink();
    let interrupt = true;
    original.beforePlace = () => {
      if (!interrupt) return;
      interrupt = false;
      throw new EvidencePublicationError(
        "OPERATION_ABORTED",
        "fixture interruption",
      );
    };
    await expect(
      publish(input(), { repository, journal, sink: original }),
    ).rejects.toMatchObject({ code: "OPERATION_ABORTED" });

    const changed = new InMemoryAnnouncementSink({
      medium: original.medium,
      profile: "https://publication.test/profiles/changed/v2",
    });
    const bundleKey = normalizePublishInput(input()).bundleKey;
    await expect(
      reconcile(bundleKey, {
        repository,
        journal,
        sink: changed,
      }),
    ).rejects.toMatchObject({ code: "SINK_PROTOCOL_VIOLATION" });
    expect(changed.placementEffectCount).toBe(0);
    expect(changed.reconcileCallCount).toBe(0);
  });

  test("rejects a frozen prepared medium mismatch before sink effects", async () => {
    const repository = new InMemoryEvidenceRepository();
    const journal = new InMemoryPublicationJournalStore();
    const original = sink();
    let interrupt = true;
    original.beforePlace = () => {
      if (!interrupt) return;
      interrupt = false;
      throw new EvidencePublicationError(
        "OPERATION_ABORTED",
        "fixture interruption",
      );
    };
    await expect(
      publish(input(), { repository, journal, sink: original }),
    ).rejects.toMatchObject({ code: "OPERATION_ABORTED" });

    const changed = new InMemoryAnnouncementSink({
      medium: "https://publication.test/changed-medium",
      profile: original.profile,
    });
    const bundleKey = normalizePublishInput(input()).bundleKey;
    await expect(
      reconcile(bundleKey, {
        repository,
        journal,
        sink: changed,
      }),
    ).rejects.toMatchObject({ code: "SINK_PROTOCOL_VIOLATION" });
    expect(changed.placementEffectCount).toBe(0);
    expect(changed.reconcileCallCount).toBe(0);
  });

  test("allows concurrent identical publishers to converge on one receipt", async () => {
    const repository = new InMemoryEvidenceRepository();
    const journal = new InMemoryPublicationJournalStore();
    const announcementSink = sink();

    const [first, second] = await Promise.all([
      publish(input(), { repository, journal, sink: announcementSink }),
      publish(input(), { repository, journal, sink: announcementSink }),
    ]);

    expect(second).toEqual(first);
    expect(announcementSink.placementEffectCount).toBe(1);
  });

  test("rejects an existing bundle with a conflicting payload fingerprint", async () => {
    const repository = new InMemoryEvidenceRepository();
    const normalized = normalizePublishInput(input());
    const conflicting = {
      schemaVersion: 1,
      bundleKey: normalized.bundleKey,
      payloadFingerprint:
        "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
      destination: normalized.destination,
      repositoryCapabilities: {},
      records: normalized.records.map(({ reference }) => reference),
      artifacts: [],
      storedRecords: [],
      storedArtifacts: [],
      completed: false,
      revision: 0,
    } as const;
    const journal: PublicationJournalStore = {
      load: async () => conflicting,
      create: async () => {
        throw new Error("unexpected create");
      },
      compareAndSwap: async () => {
        throw new Error("unexpected compareAndSwap");
      },
    };

    await expect(
      publish(input(), { repository, journal, sink: sink() }),
    ).rejects.toMatchObject({ code: "BUNDLE_CONFLICT" });
  });

  test("rejects a tampered journal identity before reconciliation effects", async () => {
    const repository = new InMemoryEvidenceRepository();
    const durable = new InMemoryPublicationJournalStore();
    const delegate = sink();
    await publish(input(), {
      repository,
      journal: durable,
      sink: delegate,
    });
    const current = durable.entries()[0]!;
    const destination = `${current.destination}:tampered`;
    const tampered = {
      ...current,
      destination,
      payloadFingerprint: derivePublicationIdentities(
        current.records,
        current.artifacts,
        destination,
      ).payloadFingerprint,
    };
    const journal: PublicationJournalStore = {
      load: async () => tampered,
      create: async () => {
        throw new Error("unexpected create");
      },
      compareAndSwap: async () => {
        throw new Error("unexpected compareAndSwap");
      },
    };

    await expect(
      reconcile(current.bundleKey, {
        repository,
        journal,
        sink: delegate,
      }),
    ).rejects.toMatchObject({ code: "JOURNAL_CORRUPT" });
    expect(delegate.reconcileCallCount).toBe(0);
    expect(delegate.placementEffectCount).toBe(1);
  });

  test("rejects malformed pending identity before reconciliation", async () => {
    const repository = new InMemoryEvidenceRepository();
    const journal = new InMemoryPublicationJournalStore();
    const delegate = sink();
    let interrupt = true;
    delegate.beforePlace = () => {
      if (!interrupt) return;
      interrupt = false;
      throw new EvidencePublicationError(
        "OPERATION_ABORTED",
        "fixture interruption",
      );
    };
    await expect(
      publish(input(), { repository, journal, sink: delegate }),
    ).rejects.toMatchObject({ code: "OPERATION_ABORTED" });
    const current = journal.entries()[0]!;
    const partition = current.preparedPartitions![0]!;
    const wrong: PendingAnnouncement = {
      idempotencyKey:
        "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" as Sha256Digest,
      frameDigest: partition.prepared.frameDigest,
    };
    await journal.replaceForTesting(current.bundleKey, {
      ...current,
      preparedPartitions: [{
        ...partition,
        placement: { status: "pending", pending: wrong },
      }],
    });

    await expect(
      reconcile(current.bundleKey, {
        repository,
        journal,
        sink: delegate,
      }),
    ).rejects.toMatchObject({ code: "JOURNAL_CORRUPT" });
    expect(delegate.reconcileCallCount).toBe(0);
  });
});
