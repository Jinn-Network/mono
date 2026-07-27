// SPDX-License-Identifier: Apache-2.0
import type {
  RepositoryOperationOptions,
  Sha256Digest,
} from "@jinn-network/evidence-repository";
import { expect } from "vitest";

import {
  describeAnnouncementSinkContract,
  describePublicationJournalStoreContract,
  InMemoryAnnouncementSink,
  InMemoryPublicationJournalStore,
  type AnnouncementSinkContractContext,
  type PublicationJournalStoreContractContext,
} from "./testing.js";
import type {
  AnnouncementSink,
  PendingAnnouncement,
  PlaceResult,
  PreparedAnnouncement,
} from "./types.js";

const authorityMarkers = [
  new TextEncoder().encode(
    "printable-publication-authority-marker-0001",
  ),
  Uint8Array.from([
    0xff, 0xfe, 0x80, 0x00, 0x01, 0x02, 0x03, 0x04,
    0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c,
    0x0d, 0x0e, 0x0f, 0x10, 0x11, 0x12, 0x13, 0x14,
    0x15, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x1b, 0x1c,
  ]),
] as const;

const noPreparationEffects = () => ({
  network: 0,
  repository: 0,
  durableFilesystem: 0,
  clock: 0,
  randomness: 0,
  otherAmbientIo: 0,
});

const pendingContractKey =
  "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const revertedContractKey =
  "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";

describeAnnouncementSinkContract((testName) => {
  let effectObservations = 0;
  let extensionGetterCalls = 0;
  let requiredPendingReconciliations = 0;
  let requiredRevertedReconciliations = 0;
  const delegate = new InMemoryAnnouncementSink({
    medium: "https://publication.test/medium",
    profile: "https://publication.test/profiles/canonical-json/v1",
    maxMembersPerAnnouncement: 100,
    maxFrameBytes: 100_000,
    firstPlacementPending: true,
  });
  const sink: AnnouncementSink = {
    medium: delegate.medium,
    profile: delegate.profile,
    capabilities: delegate.capabilities,
    prepare: async (members, context, options) => {
      // Synthetic authority is closed over, never passed to sink operations.
      void authorityMarkers[0].byteLength;
      void authorityMarkers[1].byteLength;
      return delegate.prepare(members, context, options);
    },
    place: async (
      prepared: PreparedAnnouncement,
      idempotencyKey: Sha256Digest,
      options?: RepositoryOperationOptions,
    ): Promise<PlaceResult> => {
      await delegate.place(prepared, idempotencyKey, options);
      return {
        status: "pending",
        pending: {
          idempotencyKey,
          frameDigest: prepared.frameDigest,
          state: {
            format: "https://publication.test/pending-state/v6",
            bytes: Uint8Array.of(6, 0, 255),
          },
        },
      };
    },
    reconcile: async (
      prepared: PreparedAnnouncement,
      pending: PendingAnnouncement,
      options?: RepositoryOperationOptions,
    ) => {
      if (pending.idempotencyKey === revertedContractKey) {
        requiredRevertedReconciliations += 1;
        return {
          status: "reverted" as const,
          externalId: "urn:jinn:placement:contract-reverted",
          reason: "synthetic contract reversion",
        };
      }
      const result = await delegate.reconcile(prepared, pending, options);
      if (result.status === "not-found") {
        const notFound = { status: "not-found" } as Record<string, unknown>;
        Object.defineProperty(notFound, "futureExtension", {
          configurable: false,
          enumerable: true,
          get: () => {
            extensionGetterCalls += 1;
            throw new Error("must not evaluate not-found extensions");
          },
        });
        return notFound as unknown as typeof result;
      }
      if (pending.idempotencyKey === pendingContractKey) {
        requiredPendingReconciliations += 1;
      }
      return {
        status: "pending" as const,
        pending: {
          idempotencyKey: pending.idempotencyKey,
          frameDigest: prepared.frameDigest,
          state: {
            format: "https://publication.test/pending-state/v7",
            bytes: Uint8Array.of(9, 0, 255),
          },
        },
      };
    },
  };
  return {
    sink,
    authorityMarkers,
    pendingPlacementIdempotencyKey: pendingContractKey,
    revertedReconciliationPending: (prepared: PreparedAnnouncement) => ({
      idempotencyKey: revertedContractKey,
      frameDigest: prepared.frameDigest,
    }),
    prepareEffectCounts: noPreparationEffects,
    effectCount: () => {
      effectObservations += 1;
      return delegate.placementEffectCount;
    },
    cleanup: () => {
      if (testName.includes("places idempotently")) {
        expect(effectObservations).toBeGreaterThanOrEqual(3);
      }
      if (testName.includes("exercises required pending and reverted")) {
        expect(requiredPendingReconciliations).toBe(1);
        expect(requiredRevertedReconciliations).toBe(1);
      }
      expect(extensionGetterCalls).toBe(0);
    },
  };
});

describeAnnouncementSinkContract(() => {
  const delegate = new InMemoryAnnouncementSink({
    medium: "https://publication.test/ordinal-neutral-medium",
    profile: "https://publication.test/profiles/ordinal-neutral/v1",
    maxMembersPerAnnouncement: 100,
    maxFrameBytes: 100_000,
  });
  const ordinalNeutral: AnnouncementSink = {
    medium: delegate.medium,
    profile: delegate.profile,
    capabilities: delegate.capabilities,
    prepare: (members, context, options) =>
      delegate.prepare(
        members,
        { ...context, partitionOrdinal: 0 },
        options,
      ),
    place: async (prepared, idempotencyKey, options) => {
      const result = await delegate.place(
        prepared,
        idempotencyKey,
        options,
      );
      if (idempotencyKey !== pendingContractKey) return result;
      return {
        status: "pending",
        pending: {
          idempotencyKey,
          frameDigest: prepared.frameDigest,
          state: {
            format: "https://publication.test/pending-state/v6",
            bytes: Uint8Array.of(6, 0, 255),
          },
        },
      };
    },
    reconcile: (prepared, pending, options) =>
      pending.idempotencyKey === revertedContractKey
        ? Promise.resolve({
          status: "reverted" as const,
          externalId: "urn:jinn:placement:contract-reverted",
          reason: "synthetic contract reversion",
        })
        : delegate.reconcile(prepared, pending, options),
  };
  return {
    sink: ordinalNeutral,
    authorityMarkers,
    pendingPlacementIdempotencyKey: pendingContractKey,
    revertedReconciliationPending: (prepared: PreparedAnnouncement) => ({
      idempotencyKey: revertedContractKey,
      frameDigest: prepared.frameDigest,
    }),
    prepareEffectCounts: noPreparationEffects,
    effectCount: () => delegate.placementEffectCount,
  };
});

const typeOnlySink = {} as AnnouncementSink;

// @ts-expect-error Sink contexts must provide required pending/reverted scenarios.
const missingSinkScenarioHooks: AnnouncementSinkContractContext = {
  sink: typeOnlySink,
  effectCount: () => 0,
  prepareEffectCounts: noPreparationEffects,
  authorityMarkers,
};
void missingSinkScenarioHooks;

// @ts-expect-error Contract contexts must make effect observation mandatory.
const missingEffectObservation: AnnouncementSinkContractContext = {
  sink: typeOnlySink,
};
void missingEffectObservation;

// @ts-expect-error Contract contexts must provide authority-marker fixtures.
const missingSinkAuthorityMarkers: AnnouncementSinkContractContext = {
  sink: typeOnlySink,
  effectCount: () => 0,
};
void missingSinkAuthorityMarkers;

// @ts-expect-error Sink contexts must observe preparation ambient effects.
const missingPreparationEffectObservation: AnnouncementSinkContractContext = {
  sink: typeOnlySink,
  effectCount: () => 0,
  authorityMarkers,
};
void missingPreparationEffectObservation;

// @ts-expect-error Journal contexts must provide authority-marker fixtures.
const missingJournalAuthorityMarkers: PublicationJournalStoreContractContext = {
  store: new InMemoryPublicationJournalStore(),
};
void missingJournalAuthorityMarkers;

// @ts-expect-error Journal contexts must inject corruption for reporting.
const missingJournalCorruptionInjection: PublicationJournalStoreContractContext = {
  store: new InMemoryPublicationJournalStore(),
  authorityMarkers,
};
void missingJournalCorruptionInjection;

describePublicationJournalStoreContract(
  () => {
    const store = new InMemoryPublicationJournalStore();
    return {
      store,
      authorityMarkers,
      injectCorruption: (entry) => {
        store.injectCorruptionForTesting(entry.bundleKey);
      },
    };
  },
);
