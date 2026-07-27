// SPDX-License-Identifier: Apache-2.0
import { isProxy } from "node:util/types";

import {
  createRecordReference,
  type RepositoryOperationOptions,
  type Sha256Digest,
} from "@jinn-network/evidence-repository";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "vitest";

import {
  assertPublicationOperationActive,
  EvidencePublicationError,
} from "./errors.js";
import {
  assertNoAuthorityMarkerLeaks,
  type AuthorityMarkerPatterns,
  validateAuthorityMarkers,
} from "./authority.js";
import {
  cloneVersionedPublicationJournalEntry,
  encodeVersionedPublicationJournalEntry,
  snapshotInitialPublicationJournalEntry,
  validateJournalTransition,
} from "./journal.js";
import {
  derivePublicationIdentities,
  hashExactBytes,
  snapshotPreparedAnnouncement,
} from "./identities.js";
import type {
  AnnouncementMember,
  AnnouncementPreparationContext,
  AnnouncementSink,
  AnnouncementSinkCapabilities,
  OpaqueSinkState,
  PendingAnnouncement,
  PlaceResult,
  PreparedAnnouncement,
  PublicationJournalEntry,
  PublicationJournalStore,
  ReconcileResult,
  VersionedPublicationJournalEntry,
} from "./types.js";
import {
  assertAbsoluteIri,
  parsePublicationDigest,
} from "./validation.js";

const encoder = new TextEncoder();

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  return left.every((value, index) => value === right[index]);
}

function canonicalTestFrame(
  medium: string,
  profile: string,
  members: readonly AnnouncementMember[],
  context: AnnouncementPreparationContext,
): Uint8Array {
  return encoder.encode(JSON.stringify({
    format: "jinn-evidence-publication-test-frame",
    version: 1,
    medium,
    profile,
    destination: context.destination,
    partitionOrdinal: context.partitionOrdinal,
    members: members.map(({ reference }) => ({
      family: reference.family,
      digest: reference.digest,
    })),
  }));
}

export interface InMemoryAnnouncementSinkOptions {
  readonly medium: string;
  readonly profile: string;
  readonly maxMembersPerAnnouncement?: number;
  readonly maxFrameBytes?: number;
  readonly firstPlacementPending?: boolean;
}

interface InMemoryPlacement {
  readonly prepared: PreparedAnnouncement;
  readonly placement: {
    readonly externalId: string;
  };
}

export class InMemoryAnnouncementSink implements AnnouncementSink {
  readonly medium: string;
  readonly profile: string;
  readonly capabilities: AnnouncementSinkCapabilities;
  readonly #placements = new Map<Sha256Digest, InMemoryPlacement>();
  readonly #firstPlacementPending: boolean;

  prepareCallCount = 0;
  reconcileCallCount = 0;
  placementEffectCount = 0;
  beforePrepare?: (
    members: readonly AnnouncementMember[],
    context: AnnouncementPreparationContext,
  ) => Promise<void> | void;
  beforePlace?: (
    prepared: PreparedAnnouncement,
    idempotencyKey: Sha256Digest,
  ) => Promise<void> | void;

  constructor(options: InMemoryAnnouncementSinkOptions) {
    this.medium = assertAbsoluteIri(options.medium, "Sink medium");
    this.profile = assertAbsoluteIri(options.profile, "Sink profile");
    for (
      const [name, value] of [
        ["maxMembersPerAnnouncement", options.maxMembersPerAnnouncement],
        ["maxFrameBytes", options.maxFrameBytes],
      ] as const
    ) {
      if (
        value !== undefined &&
        (!Number.isSafeInteger(value) || value < 1)
      ) {
        throw new EvidencePublicationError(
          "INVALID_INPUT",
          `${name} must be a positive safe integer.`,
        );
      }
    }
    this.capabilities = Object.freeze({
      ...(options.maxMembersPerAnnouncement === undefined
        ? {}
        : {
            maxMembersPerAnnouncement: options.maxMembersPerAnnouncement,
          }),
      ...(options.maxFrameBytes === undefined
        ? {}
        : { maxFrameBytes: options.maxFrameBytes }),
    });
    this.#firstPlacementPending = options.firstPlacementPending ?? false;
  }

  async prepare(
    members: readonly AnnouncementMember[],
    context: AnnouncementPreparationContext,
    options?: RepositoryOperationOptions,
  ): Promise<PreparedAnnouncement> {
    assertPublicationOperationActive(options);
    this.prepareCallCount += 1;
    await this.beforePrepare?.(members, context);
    assertPublicationOperationActive(options);
    assertAbsoluteIri(context.destination, "Preparation destination");
    if (
      !Number.isSafeInteger(context.partitionOrdinal) ||
      context.partitionOrdinal < 0
    ) {
      throw new EvidencePublicationError(
        "INVALID_INPUT",
        "Preparation partition ordinal must be non-negative.",
      );
    }
    const clonedMembers = structuredClone(members);
    const frameBytes = canonicalTestFrame(
      this.medium,
      this.profile,
      clonedMembers,
      context,
    );
    return {
      medium: this.medium,
      profile: this.profile,
      members: clonedMembers,
      frameBytes,
      frameDigest: hashExactBytes(frameBytes),
      frameSize: frameBytes.byteLength,
    };
  }

  async place(
    untrustedPrepared: PreparedAnnouncement,
    untrustedIdempotencyKey: Sha256Digest,
    options?: RepositoryOperationOptions,
  ): Promise<PlaceResult> {
    assertPublicationOperationActive(options);
    const prepared = snapshotPreparedAnnouncement(
      untrustedPrepared,
      untrustedPrepared.members,
      this.medium,
      this.profile,
    );
    const idempotencyKey = parsePublicationDigest(
      untrustedIdempotencyKey,
      "Placement idempotency key",
    );
    await this.beforePlace?.(prepared, idempotencyKey);
    assertPublicationOperationActive(options);
    const existing = this.#placements.get(idempotencyKey);
    if (existing !== undefined) {
      if (
        existing.prepared.frameDigest !== prepared.frameDigest ||
        !bytesEqual(
          existing.prepared.frameBytes,
          prepared.frameBytes,
        )
      ) {
        throw new EvidencePublicationError(
          "IDEMPOTENCY_CONFLICT",
          "The placement key is already bound to another prepared frame.",
        );
      }
      return {
        status: "existing",
        placement: structuredClone(existing.placement),
      };
    }
    const maxMembers = this.capabilities.maxMembersPerAnnouncement;
    const maxBytes = this.capabilities.maxFrameBytes;
    if (
      (maxMembers !== undefined && prepared.members.length > maxMembers) ||
      (maxBytes !== undefined && prepared.frameSize > maxBytes)
    ) {
      throw new EvidencePublicationError(
        "FRAME_TOO_LARGE",
        "The prepared frame exceeds declared sink capabilities.",
      );
    }
    const placement = {
      externalId: `urn:jinn:test-placement:${idempotencyKey.slice(7)}`,
    };
    this.#placements.set(idempotencyKey, {
      prepared,
      placement,
    });
    this.placementEffectCount += 1;
    if (this.#firstPlacementPending) {
      return {
        status: "pending",
        pending: {
          idempotencyKey,
          frameDigest: prepared.frameDigest,
          state: {
            format: `${this.profile}/pending-state/v1`,
            bytes: Uint8Array.of(1),
          },
        },
      };
    }
    return { status: "placed", placement: structuredClone(placement) };
  }

  async reconcile(
    untrustedPrepared: PreparedAnnouncement,
    pending: PendingAnnouncement,
    options?: RepositoryOperationOptions,
  ): Promise<ReconcileResult> {
    assertPublicationOperationActive(options);
    this.reconcileCallCount += 1;
    const prepared = snapshotPreparedAnnouncement(
      untrustedPrepared,
      untrustedPrepared.members,
      this.medium,
      this.profile,
    );
    const idempotencyKey = parsePublicationDigest(
      pending.idempotencyKey,
      "Pending idempotency key",
    );
    if (pending.frameDigest !== prepared.frameDigest) {
      throw new EvidencePublicationError(
        "IDEMPOTENCY_CONFLICT",
        "Pending state is bound to another prepared frame.",
      );
    }
    await Promise.resolve();
    assertPublicationOperationActive(options);
    const existing = this.#placements.get(idempotencyKey);
    if (existing === undefined) return { status: "not-found" };
    if (
      existing.prepared.frameDigest !== prepared.frameDigest ||
      !bytesEqual(existing.prepared.frameBytes, prepared.frameBytes)
    ) {
      throw new EvidencePublicationError(
        "IDEMPOTENCY_CONFLICT",
        "The pending key resolves to another prepared frame.",
      );
    }
    return {
      status: "existing",
      placement: structuredClone(existing.placement),
    };
  }
}

function sameVersionedEntry(
  left: VersionedPublicationJournalEntry,
  right: VersionedPublicationJournalEntry,
): boolean {
  return bytesEqual(
    encodeVersionedPublicationJournalEntry(left),
    encodeVersionedPublicationJournalEntry(right),
  );
}

export class InMemoryPublicationJournalStore
  implements PublicationJournalStore {
  readonly #entries = new Map<Sha256Digest, VersionedPublicationJournalEntry>();
  readonly #corrupted = new Set<Sha256Digest>();

  get entryCount(): number {
    return this.#entries.size;
  }

  entries(): readonly VersionedPublicationJournalEntry[] {
    return [...this.#entries.values()].map(
      cloneVersionedPublicationJournalEntry,
    );
  }

  async load(
    bundleKey: Sha256Digest,
    options?: RepositoryOperationOptions,
  ): Promise<VersionedPublicationJournalEntry | null> {
    assertPublicationOperationActive(options);
    const key = parsePublicationDigest(bundleKey, "Bundle key");
    await Promise.resolve();
    assertPublicationOperationActive(options);
    if (this.#corrupted.has(key)) {
      throw new EvidencePublicationError(
        "JOURNAL_CORRUPT",
        "The in-memory publication journal was fault-injected as corrupt.",
      );
    }
    const entry = this.#entries.get(key);
    return entry === undefined
      ? null
      : cloneVersionedPublicationJournalEntry(entry);
  }

  async create(
    input: PublicationJournalEntry,
    options?: RepositoryOperationOptions,
  ): Promise<VersionedPublicationJournalEntry> {
    assertPublicationOperationActive(options);
    const snapshot = snapshotInitialPublicationJournalEntry(input);
    await Promise.resolve();
    assertPublicationOperationActive(options);
    if (this.#entries.has(snapshot.bundleKey)) {
      throw new EvidencePublicationError(
        "JOURNAL_CONFLICT",
        "The publication journal entry already exists.",
      );
    }
    const created = { ...snapshot, revision: 0 } as const;
    this.#entries.set(
      created.bundleKey,
      cloneVersionedPublicationJournalEntry(created),
    );
    return cloneVersionedPublicationJournalEntry(created);
  }

  async compareAndSwap(
    expected: VersionedPublicationJournalEntry,
    input: PublicationJournalEntry,
    options?: RepositoryOperationOptions,
  ): Promise<VersionedPublicationJournalEntry> {
    assertPublicationOperationActive(options);
    const key = parsePublicationDigest(expected.bundleKey, "Bundle key");
    const current = this.#entries.get(key);
    if (current === undefined || !sameVersionedEntry(current, expected)) {
      throw new EvidencePublicationError(
        "JOURNAL_CONFLICT",
        "The publication journal advanced in another writer.",
      );
    }
    const next = validateJournalTransition(current, input);
    await Promise.resolve();
    assertPublicationOperationActive(options);
    const refreshed = this.#entries.get(key);
    if (refreshed === undefined || !sameVersionedEntry(refreshed, current)) {
      throw new EvidencePublicationError(
        "JOURNAL_CONFLICT",
        "The publication journal advanced in another writer.",
      );
    }
    const versioned = {
      ...next,
      revision: current.revision + 1,
    } as const;
    this.#entries.set(key, cloneVersionedPublicationJournalEntry(versioned));
    return cloneVersionedPublicationJournalEntry(versioned);
  }

  async replaceForTesting(
    bundleKey: Sha256Digest,
    input: VersionedPublicationJournalEntry,
  ): Promise<void> {
    const key = parsePublicationDigest(bundleKey, "Bundle key");
    this.#entries.set(
      key,
      cloneVersionedPublicationJournalEntry({
        ...input,
        revision: input.revision + 1,
      }),
    );
  }

  injectCorruptionForTesting(bundleKey: Sha256Digest): void {
    const key = parsePublicationDigest(bundleKey, "Bundle key");
    this.#corrupted.add(key);
  }
}

export interface AnnouncementSinkContractContext {
  readonly sink: AnnouncementSink;
  readonly effectCount: () => number;
  readonly prepareEffectCounts: () => AnnouncementPreparationEffectCounts;
  readonly authorityMarkers: readonly Uint8Array[];
  /**
   * A fixture key for which `sink.place()` must return `pending` with
   * non-empty opaque state bytes. The contract kit always reconciles the
   * returned pending state and proves that the sink does not mutate it.
   */
  readonly pendingPlacementIdempotencyKey: Sha256Digest;
  /**
   * Supplies a synthetic pending input for which `sink.reconcile()` must
   * return `reverted` with non-empty `externalId` and `reason` data fields.
   */
  readonly revertedReconciliationPending: (
    prepared: PreparedAnnouncement,
  ) => PendingAnnouncement;
  /**
   * Optional bounded fixture strategy for media whose frame size is not
   * controllable by padding the contract destination. It must prepare the
   * contract kit's canonical single-member candidate at exactly this size.
   */
  readonly prepareFrameAtSize?: (
    exactFrameBytes: number,
  ) => Promise<PreparedAnnouncement>;
  readonly cleanup?: () => Promise<void> | void;
}

export interface AnnouncementPreparationEffectCounts {
  readonly network: number;
  readonly repository: number;
  readonly durableFilesystem: number;
  readonly clock: number;
  readonly randomness: number;
  readonly otherAmbientIo: number;
}

export type AnnouncementSinkContractFactory = (
  name: string,
) =>
  | AnnouncementSinkContractContext
  | Promise<AnnouncementSinkContractContext>;

function contractMembers(): readonly AnnouncementMember[] {
  return [
    {
      reference: createRecordReference(
        "execution-evidence",
        new Uint8Array([1]),
      ),
    },
  ];
}

function snapshotPreparationEffectCounts(
  context: AnnouncementSinkContractContext,
): AnnouncementPreparationEffectCounts {
  const value = context.prepareEffectCounts();
  const fields = [
    "network",
    "repository",
    "durableFilesystem",
    "clock",
    "randomness",
    "otherAmbientIo",
  ] as const;
  const snapshot = {} as Record<(typeof fields)[number], number>;
  for (const field of fields) {
    const count = value[field];
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new TypeError(
        `Preparation effect count ${field} must be a non-negative safe integer.`,
      );
    }
    snapshot[field] = count;
  }
  return Object.freeze(snapshot) as AnnouncementPreparationEffectCounts;
}

export function describeAnnouncementSinkContract(
  createContext: AnnouncementSinkContractFactory,
): void {
  const maximumAutomaticMemberFixture = 4_096;
  const maximumAutomaticFrameFixtureBytes = 1_048_576;

  describe("AnnouncementSink contract", () => {
    let context: AnnouncementSinkContractContext | undefined;
    let authorityPatterns: AuthorityMarkerPatterns | undefined;
    let configuredSink: {
      readonly medium: string;
      readonly profile: string;
      readonly maxMembersPerAnnouncement?: number;
      readonly maxFrameBytes?: number;
    } | undefined;

    beforeEach(async (testContext) => {
      context = await createContext(testContext.task.name);
      const medium = assertAbsoluteIri(context.sink.medium, "Sink medium");
      const profile = assertAbsoluteIri(context.sink.profile, "Sink profile");
      const {
        maxMembersPerAnnouncement,
        maxFrameBytes,
      } = context.sink.capabilities;
      for (
        const [name, limit] of [
          ["maxMembersPerAnnouncement", maxMembersPerAnnouncement],
          ["maxFrameBytes", maxFrameBytes],
        ] as const
      ) {
        if (
          limit !== undefined &&
          (!Number.isSafeInteger(limit) || limit < 1)
        ) {
          throw new TypeError(
            `Announcement sink ${name} must be a positive safe integer.`,
          );
        }
      }
      configuredSink = Object.freeze({
        medium,
        profile,
        ...(maxMembersPerAnnouncement === undefined
          ? {}
          : { maxMembersPerAnnouncement }),
        ...(maxFrameBytes === undefined ? {} : { maxFrameBytes }),
      });
      if (typeof context.effectCount !== "function") {
        throw new TypeError(
          "Announcement sink contract contexts must provide effectCount().",
        );
      }
      if (
        typeof context.revertedReconciliationPending !== "function"
      ) {
        throw new TypeError(
          "Announcement sink contract contexts must provide a reverted reconciliation fixture.",
        );
      }
      parsePublicationDigest(
        context.pendingPlacementIdempotencyKey,
        "Pending placement fixture key",
      );
      authorityPatterns = validateAuthorityMarkers(
        context.authorityMarkers,
      );
    });

    afterEach(async () => {
      try {
        if (context !== undefined && configuredSink !== undefined) {
          expect(context.sink.medium).toBe(configuredSink.medium);
          expect(context.sink.profile).toBe(configuredSink.profile);
          expect(
            context.sink.capabilities.maxMembersPerAnnouncement,
          ).toBe(configuredSink.maxMembersPerAnnouncement);
          expect(context.sink.capabilities.maxFrameBytes).toBe(
            configuredSink.maxFrameBytes,
          );
        }
      } finally {
        await context?.cleanup?.();
        context = undefined;
        authorityPatterns = undefined;
        configuredSink = undefined;
      }
    });

    function scanAuthority(...values: readonly unknown[]): void {
      assertNoAuthorityMarkerLeaks(authorityPatterns!, values);
    }

    async function expectScannedRejection(
      operation: Promise<unknown>,
      code: string,
    ): Promise<void> {
      let caught: unknown;
      try {
        await operation;
      } catch (error) {
        caught = error;
      }
      expect(caught).toMatchObject({ code });
      scanAuthority(caught);
    }

    function assertOpaqueState(
      state: OpaqueSinkState | undefined,
    ): void {
      if (state === undefined) return;
      expect(() =>
        assertAbsoluteIri(state.format, "Opaque state format")
      ).not.toThrow();
      expect(state.bytes).toBeInstanceOf(Uint8Array);
    }

    function contractResultStatus(value: unknown, role: string): string {
      if (
        typeof value !== "object" ||
        value === null ||
        isProxy(value)
      ) {
        throw new TypeError(`${role} must be a non-proxy object.`);
      }
      const descriptor = Reflect.getOwnPropertyDescriptor(value, "status");
      if (
        descriptor === undefined ||
        !Object.hasOwn(descriptor, "value") ||
        typeof descriptor.value !== "string"
      ) {
        throw new TypeError(`${role}.status must be an own data property.`);
      }
      return descriptor.value;
    }

    function assertPlacementOutcome(
      outcome: PlaceResult | ReconcileResult,
      prepared: PreparedAnnouncement,
      idempotencyKey: Sha256Digest,
      allowedStatuses: readonly string[],
    ): void {
      scanAuthority(prepared, outcome);
      const status = contractResultStatus(outcome, "Sink result");
      expect(allowedStatuses).toContain(status);
      if (status === "pending" && outcome.status === "pending") {
        expect(outcome.pending.idempotencyKey).toBe(idempotencyKey);
        expect(outcome.pending.frameDigest).toBe(prepared.frameDigest);
        assertOpaqueState(outcome.pending.state);
        return;
      }
      if (
        (status === "placed" || status === "existing") &&
        (outcome.status === "placed" || outcome.status === "existing")
      ) {
        expect(outcome.placement.externalId.length).toBeGreaterThan(0);
        assertOpaqueState(outcome.placement.state);
      }
    }

    async function prepareFrameAtExactSize(
      exactFrameBytes: number,
    ): Promise<PreparedAnnouncement> {
      const members = contractMembers();
      const supplied = context!.prepareFrameAtSize === undefined
        ? undefined
        : await context!.prepareFrameAtSize(exactFrameBytes);
      if (supplied !== undefined) {
        scanAuthority(supplied);
        const snapshot = snapshotPreparedAnnouncement(
          supplied,
          members,
          configuredSink!.medium,
          configuredSink!.profile,
        );
        if (snapshot.frameSize !== exactFrameBytes) {
          throw new Error(
            "prepareFrameAtSize() did not return the requested exact frame size.",
          );
        }
        return snapshot;
      }
      const destinationPrefix = "https://publication.test/";
      const baselineOutput = await context!.sink.prepare(members, {
        destination: destinationPrefix,
        partitionOrdinal: 0,
      });
      scanAuthority(baselineOutput);
      const baseline = snapshotPreparedAnnouncement(
        baselineOutput,
        members,
        configuredSink!.medium,
        configuredSink!.profile,
      );
      if (baseline.frameSize > exactFrameBytes) {
        throw new Error(
          "The sink contract fixture cannot prepare a frame at its declared " +
          "maxFrameBytes; provide prepareFrameAtSize().",
        );
      }
      const preparedOutput = await context!.sink.prepare(members, {
          destination:
            `${destinationPrefix}${"x".repeat(
              exactFrameBytes - baseline.frameSize,
            )}`,
          partitionOrdinal: 0,
        });
      scanAuthority(preparedOutput);
      const prepared = snapshotPreparedAnnouncement(
        preparedOutput,
        members,
        configuredSink!.medium,
        configuredSink!.profile,
      );
      if (prepared.frameSize !== exactFrameBytes) {
        throw new Error(
          "Automatic exact-frame construction is not valid for this sink; " +
          "provide prepareFrameAtSize().",
        );
      }
      return prepared;
    }

    test("prepares deterministic exact frames without placement effects", async () => {
      const members = contractMembers();
      const preparationContext = {
        destination: "urn:jinn:publication-destination:sink-contract",
        partitionOrdinal: 0,
      } as const;
      const before = context!.effectCount();
      const effectsBeforeFirst = snapshotPreparationEffectCounts(context!);
      const first = await context!.sink.prepare(members, preparationContext);
      expect(snapshotPreparationEffectCounts(context!)).toEqual(
        effectsBeforeFirst,
      );
      const effectsBeforeSecond = snapshotPreparationEffectCounts(context!);
      const second = await context!.sink.prepare(members, preparationContext);
      expect(snapshotPreparationEffectCounts(context!)).toEqual(
        effectsBeforeSecond,
      );
      scanAuthority(first, second);
      const firstSnapshot = snapshotPreparedAnnouncement(
        first,
        members,
        configuredSink!.medium,
        configuredSink!.profile,
      );
      const secondSnapshot = snapshotPreparedAnnouncement(
        second,
        members,
        configuredSink!.medium,
        configuredSink!.profile,
      );
      expect(() =>
        assertAbsoluteIri(configuredSink!.medium, "Sink medium")
      ).not.toThrow();
      expect(() =>
        assertAbsoluteIri(configuredSink!.profile, "Sink profile")
      ).not.toThrow();
      expect(firstSnapshot.medium).toBe(configuredSink!.medium);
      expect(secondSnapshot.medium).toBe(firstSnapshot.medium);
      expect(secondSnapshot.profile).toBe(firstSnapshot.profile);
      expect(secondSnapshot.members).toEqual(firstSnapshot.members);
      expect(
        bytesEqual(secondSnapshot.frameBytes, firstSnapshot.frameBytes),
      ).toBe(true);
      expect(secondSnapshot.frameDigest).toBe(firstSnapshot.frameDigest);
      expect(secondSnapshot.frameSize).toBe(firstSnapshot.frameSize);
      expect(firstSnapshot.members).not.toBe(members);
      expect(context!.effectCount()).toBe(before);
    });

    test("preserves caller-owned members, context, frame, and pending state", async () => {
      const memberInput = structuredClone(contractMembers());
      const expectedMembers = structuredClone(memberInput);
      const contextInput = {
        destination: "urn:jinn:publication-destination:sink-mutation-contract",
        partitionOrdinal: 0,
      };
      const expectedContext = { ...contextInput };
      const preparedOutput = await context!.sink.prepare(
        memberInput,
        contextInput,
      );
      expect(memberInput).toEqual(expectedMembers);
      expect(contextInput).toEqual(expectedContext);
      const prepared = snapshotPreparedAnnouncement(
        preparedOutput,
        expectedMembers,
        configuredSink!.medium,
        configuredSink!.profile,
      );

      const placeInput = structuredClone(prepared);
      const expectedPlaceInput = structuredClone(placeInput);
      const pendingResult = await context!.sink.place(
        placeInput,
        context!.pendingPlacementIdempotencyKey,
      );
      expect(placeInput).toEqual(expectedPlaceInput);
      if (pendingResult.status !== "pending") {
        throw new TypeError(
          "The required mutation fixture did not return pending.",
        );
      }
      if (
        pendingResult.pending.state === undefined ||
        pendingResult.pending.state.bytes.byteLength === 0
      ) {
        throw new TypeError(
          "The required mutation fixture must return non-empty opaque pending state.",
        );
      }

      const reconcilePreparedInput = structuredClone(prepared);
      const expectedReconcilePrepared = structuredClone(
        reconcilePreparedInput,
      );
      const reconcilePendingInput = structuredClone(
        pendingResult.pending,
      );
      const expectedReconcilePending = structuredClone(
        reconcilePendingInput,
      );
      const reconciled = await context!.sink.reconcile(
        reconcilePreparedInput,
        reconcilePendingInput,
      );
      expect(reconcilePreparedInput).toEqual(expectedReconcilePrepared);
      expect(reconcilePendingInput).toEqual(expectedReconcilePending);
      scanAuthority(prepared, pendingResult, reconciled);
    });

    test("places idempotently and rejects a changed frame for one key", async () => {
      const members = contractMembers();
      const prepared = await context!.sink.prepare(members, {
        destination: "urn:jinn:publication-destination:sink-contract",
        partitionOrdinal: 0,
      });
      const key =
        "sha256:1111111111111111111111111111111111111111111111111111111111111111";
      const effectsBeforePlacement = context!.effectCount();
      const first = await context!.sink.place(prepared, key);
      const effectsAfterFirstPlacement = context!.effectCount();
      const second = await context!.sink.place(prepared, key);
      const effectsAfterSecondPlacement = context!.effectCount();
      expect([
        effectsBeforePlacement,
        effectsBeforePlacement + 1,
      ]).toContain(effectsAfterFirstPlacement);
      expect(effectsAfterSecondPlacement).toBe(
        effectsAfterFirstPlacement,
      );
      assertPlacementOutcome(
        first,
        prepared,
        key,
        ["placed", "pending", "existing"],
      );
      assertPlacementOutcome(
        second,
        prepared,
        key,
        ["pending", "existing"],
      );
      for (const placement of [first, second]) {
        if (placement.status !== "pending") continue;
        const reconciled = await context!.sink.reconcile(
          prepared,
          placement.pending,
        );
        assertPlacementOutcome(
          reconciled,
          prepared,
          key,
          ["placed", "pending", "existing"],
        );
        if (reconciled.status === "pending") {
          const stable = await context!.sink.reconcile(
            prepared,
            reconciled.pending,
          );
          assertPlacementOutcome(
            stable,
            prepared,
            key,
            ["placed", "pending", "existing"],
          );
        }
      }

      const changedMembers = [{
        reference: createRecordReference(
          "execution-evidence",
          encoder.encode("changed-contract-member"),
        ),
      }];
      const changed = await context!.sink.prepare(changedMembers, {
        destination: "urn:jinn:publication-destination:sink-contract",
        partitionOrdinal: 0,
      });
      scanAuthority(changed);
      const changedSnapshot = snapshotPreparedAnnouncement(
        changed,
        changedMembers,
        configuredSink!.medium,
        configuredSink!.profile,
      );
      expect(changedSnapshot.members).not.toEqual(prepared.members);
      expect(bytesEqual(changedSnapshot.frameBytes, prepared.frameBytes))
        .toBe(false);
      expect(changedSnapshot.frameDigest).not.toBe(prepared.frameDigest);
      await expectScannedRejection(
        context!.sink.place(changedSnapshot, key),
        "IDEMPOTENCY_CONFLICT",
      );
    });

    test("enforces declared member and exact frame byte limits", async () => {
      const maxMembers = configuredSink!.maxMembersPerAnnouncement;
      if (maxMembers !== undefined) {
        if (maxMembers > maximumAutomaticMemberFixture) {
          throw new Error(
            "The sink contract fixture must declare a representative " +
            `maxMembersPerAnnouncement no greater than ${maximumAutomaticMemberFixture}.`,
          );
        }
        const exactMembers = Array.from(
          { length: maxMembers },
          (_unused, index) => ({
            reference: createRecordReference(
              "execution-evidence",
              encoder.encode(String(index)),
            ),
          }),
        );
        const exactPrepared = await context!.sink.prepare(exactMembers, {
          destination: "urn:jinn:publication-destination:sink-contract",
          partitionOrdinal: 0,
        });
        const exactKey =
          "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
        const accepted = await context!.sink.place(exactPrepared, exactKey);
        assertPlacementOutcome(
          accepted,
          exactPrepared,
          exactKey,
          ["placed", "pending", "existing"],
        );

        const tooMany = Array.from(
          { length: maxMembers + 1 },
          (_unused, index) => ({
            reference: createRecordReference(
              "execution-evidence",
              encoder.encode(String(index)),
            ),
          }),
        );
        const prepared = await context!.sink.prepare(tooMany, {
          destination: "urn:jinn:publication-destination:sink-contract",
          partitionOrdinal: 0,
        });
        scanAuthority(prepared);
        await expectScannedRejection(
          context!.sink.place(
            prepared,
            "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          ),
          "FRAME_TOO_LARGE",
        );
      }

      const maxBytes = configuredSink!.maxFrameBytes;
      if (maxBytes !== undefined) {
        if (maxBytes > maximumAutomaticFrameFixtureBytes) {
          throw new Error(
            "The sink contract fixture must declare a representative " +
            `maxFrameBytes no greater than ${maximumAutomaticFrameFixtureBytes}.`,
          );
        }
        const exactPrepared = await prepareFrameAtExactSize(maxBytes);
        const exactKey =
          "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";
        const accepted = await context!.sink.place(exactPrepared, exactKey);
        assertPlacementOutcome(
          accepted,
          exactPrepared,
          exactKey,
          ["placed", "pending", "existing"],
        );
        const prepared = await prepareFrameAtExactSize(maxBytes + 1);
        await expectScannedRejection(
          context!.sink.place(
            prepared,
            "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          ),
          "FRAME_TOO_LARGE",
        );
      }
    });

    test("exercises required pending and reverted reconciliation outcomes", async () => {
      const prepared = await context!.sink.prepare(contractMembers(), {
        destination: "urn:jinn:publication-destination:sink-contract",
        partitionOrdinal: 0,
      });
      const pendingResult = await context!.sink.place(
        prepared,
        context!.pendingPlacementIdempotencyKey,
      );
      scanAuthority(prepared, pendingResult);
      expect(
        contractResultStatus(pendingResult, "Pending place result"),
      ).toBe("pending");
      if (pendingResult.status !== "pending") {
        throw new TypeError(
          "The required pending placement fixture did not return pending.",
        );
      }
      assertPlacementOutcome(
        pendingResult,
        prepared,
        context!.pendingPlacementIdempotencyKey,
        ["pending"],
      );
      const reconciled = await context!.sink.reconcile(
        prepared,
        pendingResult.pending,
      );
      assertPlacementOutcome(
        reconciled,
        prepared,
        context!.pendingPlacementIdempotencyKey,
        ["placed", "pending", "existing"],
      );

      const revertedPending =
        context!.revertedReconciliationPending(prepared);
      expect(revertedPending.frameDigest).toBe(prepared.frameDigest);
      parsePublicationDigest(
        revertedPending.idempotencyKey,
        "Reverted reconciliation fixture key",
      );
      const reverted = await context!.sink.reconcile(
        prepared,
        revertedPending,
      );
      scanAuthority(reverted);
      expect(
        contractResultStatus(reverted, "Reverted reconcile result"),
      ).toBe("reverted");
      if (reverted.status !== "reverted") {
        throw new TypeError(
          "The required reverted reconciliation fixture did not return reverted.",
        );
      }
      for (const field of ["externalId", "reason"] as const) {
        const descriptor = Reflect.getOwnPropertyDescriptor(
          reverted,
          field,
        );
        expect(descriptor).toBeDefined();
        expect(descriptor !== undefined && Object.hasOwn(descriptor, "value"))
          .toBe(true);
        expect(
          descriptor !== undefined &&
            Object.hasOwn(descriptor, "value") &&
            typeof descriptor.value === "string"
            ? descriptor.value.length
            : 0,
        ).toBeGreaterThan(0);
      }
    });

    test("reconciles state-less intent and authoritatively reports absence", async () => {
      const prepared = await context!.sink.prepare(contractMembers(), {
        destination: "urn:jinn:publication-destination:sink-contract",
        partitionOrdinal: 0,
      });
      const existingKey =
        "sha256:2222222222222222222222222222222222222222222222222222222222222222";
      await context!.sink.place(prepared, existingKey);
      const reconciled = await context!.sink.reconcile(prepared, {
        idempotencyKey: existingKey,
        frameDigest: prepared.frameDigest,
      });
      assertPlacementOutcome(
        reconciled,
        prepared,
        existingKey,
        ["placed", "pending", "existing"],
      );

      const absent = await context!.sink.reconcile(prepared, {
        idempotencyKey:
          "sha256:3333333333333333333333333333333333333333333333333333333333333333",
        frameDigest: prepared.frameDigest,
      });
      scanAuthority(absent);
      expect(
        contractResultStatus(absent, "Not-found reconcile result"),
      ).toBe("not-found");
    });

    test("honors an already-aborted signal", async () => {
      const controller = new AbortController();
      controller.abort();
      await expectScannedRejection(
        context!.sink.prepare(
          contractMembers(),
          {
            destination: "urn:jinn:publication-destination:sink-contract",
            partitionOrdinal: 0,
          },
          { signal: controller.signal },
        ),
        "OPERATION_ABORTED",
      );

      const activePrepared = await context!.sink.prepare(
        contractMembers(),
        {
          destination: "urn:jinn:publication-destination:sink-contract",
          partitionOrdinal: 0,
        },
      );
      scanAuthority(activePrepared);
      await expectScannedRejection(
        context!.sink.place(
          activePrepared,
          "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
          { signal: controller.signal },
        ),
        "OPERATION_ABORTED",
      );
      await expectScannedRejection(
        context!.sink.reconcile(
          activePrepared,
          {
            idempotencyKey:
              "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
            frameDigest: activePrepared.frameDigest,
          },
          { signal: controller.signal },
        ),
        "OPERATION_ABORTED",
      );
    });
  });
}

export interface PublicationJournalStoreContractContext {
  readonly store: PublicationJournalStore;
  readonly authorityMarkers: readonly Uint8Array[];
  readonly injectCorruption: (
    entry: VersionedPublicationJournalEntry,
  ) => Promise<void> | void;
  readonly cleanup?: () => Promise<void> | void;
}

export type PublicationJournalStoreContractFactory = (
  name: string,
) =>
  | PublicationJournalStoreContractContext
  | Promise<PublicationJournalStoreContractContext>;

function journalContractEntry(): PublicationJournalEntry {
  const destination = "urn:jinn:publication-destination:journal-contract";
  const records = [
    createRecordReference("execution-evidence", new Uint8Array([1])),
  ];
  return {
    schemaVersion: 1,
    ...derivePublicationIdentities(records, [], destination),
    destination,
    repositoryCapabilities: {},
    artifacts: [],
    records,
    storedArtifacts: [],
    storedRecords: [],
    completed: false,
  };
}

function inFlightCancellationSignal(): AbortSignal {
  let scheduled = false;
  let aborted = false;
  return {
    get aborted(): boolean {
      if (!scheduled) {
        scheduled = true;
        queueMicrotask(() => {
          aborted = true;
        });
      }
      return aborted;
    },
  } as AbortSignal;
}

export function describePublicationJournalStoreContract(
  createContext: PublicationJournalStoreContractFactory,
): void {
  describe("PublicationJournalStore contract", () => {
    let context: PublicationJournalStoreContractContext | undefined;
    let authorityPatterns: AuthorityMarkerPatterns | undefined;

    beforeEach(async (testContext) => {
      context = await createContext(testContext.task.name);
      authorityPatterns = validateAuthorityMarkers(
        context.authorityMarkers,
      );
    });

    afterEach(async () => {
      await context?.cleanup?.();
      context = undefined;
      authorityPatterns = undefined;
    });

    function scanAuthority(...values: readonly unknown[]): void {
      assertNoAuthorityMarkerLeaks(authorityPatterns!, values);
    }

    async function expectScannedRejection(
      operation: Promise<unknown>,
      code: string,
    ): Promise<void> {
      let caught: unknown;
      try {
        await operation;
      } catch (error) {
        caught = error;
      }
      expect(caught).toMatchObject({ code });
      scanAuthority(caught);
    }

    test("loads absent, creates revision zero, and round-trips exactly", async () => {
      const input = journalContractEntry();
      expect(await context!.store.load(input.bundleKey)).toBeNull();
      const created = await context!.store.create(input);
      expect(created.revision).toBe(0);
      const loaded = await context!.store.load(input.bundleKey);
      expect(loaded).toEqual(created);
      scanAuthority(created, loaded);
    });

    test("advances monotonically and rejects a stale writer", async () => {
      const created = await context!.store.create(journalContractEntry());
      const next = await context!.store.compareAndSwap(created, {
        ...created,
        storedRecords: [{
          reference: created.records[0]!,
          size: 1,
        }],
      });
      expect(next.revision).toBe(1);
      scanAuthority(next);
      await expectScannedRejection(
        context!.store.compareAndSwap(created, journalContractEntry()),
        "JOURNAL_CONFLICT",
      );
    });

    test("round-trips exact prepared bytes and opaque pending state", async () => {
      const created = await context!.store.create(journalContractEntry());
      const stored = await context!.store.compareAndSwap(created, {
        ...created,
        storedRecords: [{
          reference: created.records[0]!,
          size: 1,
        }],
      });
      const frameBytes = Uint8Array.of(7, 8, 9);
      const planned = await context!.store.compareAndSwap(stored, {
        ...stored,
        preparedPartitions: [{
          ordinal: 0,
          prepared: {
            medium: "https://publication.test/medium",
            profile: "https://publication.test/profile/v1",
            members: [{ reference: stored.records[0]! }],
            frameBytes,
            frameDigest: hashExactBytes(frameBytes),
            frameSize: frameBytes.byteLength,
          },
          placement: { status: "unplaced" },
        }],
      });
      const intent = await context!.store.compareAndSwap(planned, {
        ...planned,
        preparedPartitions: [{
          ...planned.preparedPartitions![0]!,
          placement: {
            status: "pending",
            pending: {
              idempotencyKey:
                "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
              frameDigest:
                planned.preparedPartitions![0]!.prepared.frameDigest,
            },
          },
        }],
      });
      const pending = await context!.store.compareAndSwap(intent, {
        ...intent,
        preparedPartitions: [{
          ...intent.preparedPartitions![0]!,
          placement: {
            status: "pending",
            pending: {
              idempotencyKey:
                "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
              frameDigest:
                intent.preparedPartitions![0]!.prepared.frameDigest,
              state: {
                format: "https://publication.test/pending-state/v1",
                bytes: Uint8Array.of(0, 255, 1),
              },
            },
          },
        }],
      });
      const confirmedState = Uint8Array.of(0xff, 0xfe, 0x00, 0x80);
      const confirmed = await context!.store.compareAndSwap(pending, {
        ...pending,
        preparedPartitions: [{
          ...pending.preparedPartitions![0]!,
          placement: {
            status: "confirmed",
            result: "existing",
            placement: {
              externalId: "urn:jinn:publication-placement:contract",
              state: {
                format:
                  "https://publication.test/confirmed-state/v1",
                bytes: confirmedState,
              },
            },
          },
        }],
      });
      const replayed = await context!.store.load(created.bundleKey);
      expect(replayed).toEqual(confirmed);
      expect(
        replayed?.preparedPartitions?.[0]?.placement,
      ).toMatchObject({
        status: "confirmed",
        placement: {
          state: {
            format: "https://publication.test/confirmed-state/v1",
            bytes: confirmedState,
          },
        },
      });
      scanAuthority(
        planned,
        intent,
        pending,
        confirmed,
        replayed,
        encodeVersionedPublicationJournalEntry(confirmed),
      );
    });

    test("honors already-aborted load, create, and compare-and-swap", async () => {
      const controller = new AbortController();
      controller.abort();
      const input = journalContractEntry();
      await expectScannedRejection(
        context!.store.load(input.bundleKey, {
          signal: controller.signal,
        }),
        "OPERATION_ABORTED",
      );
      await expectScannedRejection(
        context!.store.create(input, { signal: controller.signal }),
        "OPERATION_ABORTED",
      );
      expect(await context!.store.load(input.bundleKey)).toBeNull();
      const created = await context!.store.create(input);
      await expectScannedRejection(
        context!.store.compareAndSwap(
          created,
          {
            ...created,
            storedRecords: [{
              reference: created.records[0]!,
              size: 1,
            }],
          },
          { signal: controller.signal },
        ),
        "OPERATION_ABORTED",
      );
      expect(await context!.store.load(input.bundleKey)).toEqual(created);
    });

    test("reports injected durable corruption with the journal error contract", async () => {
      const created = await context!.store.create(journalContractEntry());
      await context!.injectCorruption(created);
      await expectScannedRejection(
        context!.store.load(created.bundleKey),
        "JOURNAL_CORRUPT",
      );
    });

    test("observes in-flight cancellation during create without durable state", async () => {
      const input = journalContractEntry();
      await expectScannedRejection(
        context!.store.create(input, {
          signal: inFlightCancellationSignal(),
        }),
        "OPERATION_ABORTED",
      );
      expect(await context!.store.load(input.bundleKey)).toBeNull();
    });

    test("observes in-flight cancellation after load and CAS await boundaries", async () => {
      const input = journalContractEntry();
      const created = await context!.store.create(input);
      await expectScannedRejection(
        context!.store.load(input.bundleKey, {
          signal: inFlightCancellationSignal(),
        }),
        "OPERATION_ABORTED",
      );
      await expectScannedRejection(
        context!.store.compareAndSwap(
          created,
          {
            ...created,
            storedRecords: [{
              reference: created.records[0]!,
              size: 1,
            }],
          },
          { signal: inFlightCancellationSignal() },
        ),
        "OPERATION_ABORTED",
      );
      expect(await context!.store.load(input.bundleKey)).toEqual(created);
    });
  });
}
