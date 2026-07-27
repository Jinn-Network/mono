// SPDX-License-Identifier: Apache-2.0
import {
  createArtifactReference,
  createRecordReference,
  type EvidenceArtifactReference,
  type EvidenceRecordFamily,
  type EvidenceRecordReference,
  type EvidenceRepository,
  type EvidenceRepositoryCapabilities,
  type RepositoryOperationOptions,
  type RepositoryWriteReceipt,
} from "@jinn-network/evidence-repository";
import {
  InMemoryEvidenceRepository,
} from "@jinn-network/evidence-repository/testing";
import { describe, expect, test } from "vitest";

import { EvidencePublicationError } from "./errors.js";
import { publish } from "./publish.js";
import {
  InMemoryAnnouncementSink,
  InMemoryPublicationJournalStore,
} from "./testing.js";
import type {
  AnnouncementMember,
  AnnouncementPreparationContext,
  AnnouncementSink,
  PendingAnnouncement,
  PlaceResult,
  PreparedAnnouncement,
  PublicationJournalEntry,
  PublicationJournalStore,
  ReconcileResult,
  VersionedPublicationJournalEntry,
} from "./types.js";

type FaultMode = "crash" | "cancel";
type FaultPhase = "before" | "after";

interface FaultTarget {
  readonly label: string;
  readonly occurrence: number;
  readonly phase: FaultPhase;
}

class BoundaryController {
  readonly #seen = new Map<string, number>();
  fired = false;

  constructor(
    readonly target?: FaultTarget,
    readonly mode: FaultMode = "crash",
    readonly abortController?: AbortController,
  ) {}

  before(label: string): number {
    const occurrence = (this.#seen.get(label) ?? 0) + 1;
    this.#seen.set(label, occurrence);
    this.#fire(label, occurrence, "before");
    return occurrence;
  }

  after(label: string, occurrence: number): void {
    this.#fire(label, occurrence, "after");
  }

  #fire(
    label: string,
    occurrence: number,
    phase: FaultPhase,
  ): void {
    if (
      this.fired ||
      this.target?.label !== label ||
      this.target.occurrence !== occurrence ||
      this.target.phase !== phase
    ) {
      return;
    }
    this.fired = true;
    if (this.mode === "cancel") {
      this.abortController!.abort();
      return;
    }
    throw new EvidencePublicationError(
      "IO_FAILURE",
      `Synthetic crash ${phase} ${label} #${occurrence}.`,
    );
  }
}

interface RepositoryEffects {
  artifactsCreated: number;
  recordsCreated: number;
}

class ControlledRepository implements EvidenceRepository {
  readonly capabilities: EvidenceRepositoryCapabilities;

  constructor(
    readonly delegate: InMemoryEvidenceRepository,
    readonly controller: BoundaryController,
    readonly effects: RepositoryEffects,
  ) {
    this.capabilities = delegate.capabilities;
  }

  async putRecord(
    family: EvidenceRecordFamily,
    bytes: Uint8Array,
    options?: RepositoryOperationOptions,
  ): Promise<RepositoryWriteReceipt<EvidenceRecordReference>> {
    const occurrence = this.controller.before("repository.putRecord");
    const receipt = await this.delegate.putRecord(family, bytes, options);
    if (receipt.status === "created") this.effects.recordsCreated += 1;
    this.controller.after("repository.putRecord", occurrence);
    return receipt;
  }

  getRecord(
    reference: EvidenceRecordReference,
    options?: RepositoryOperationOptions,
  ): Promise<Uint8Array | null> {
    return this.delegate.getRecord(reference, options);
  }

  async putArtifact(
    bytes: Uint8Array,
    options?: RepositoryOperationOptions,
  ): Promise<RepositoryWriteReceipt<EvidenceArtifactReference>> {
    const occurrence = this.controller.before("repository.putArtifact");
    const receipt = await this.delegate.putArtifact(bytes, options);
    if (receipt.status === "created") this.effects.artifactsCreated += 1;
    this.controller.after("repository.putArtifact", occurrence);
    return receipt;
  }

  getArtifact(
    reference: EvidenceArtifactReference,
    options?: RepositoryOperationOptions,
  ): Promise<Uint8Array | null> {
    return this.delegate.getArtifact(reference, options);
  }
}

class ControlledJournal implements PublicationJournalStore {
  constructor(
    readonly delegate: InMemoryPublicationJournalStore,
    readonly controller: BoundaryController,
  ) {}

  async load(
    bundleKey: EvidenceRecordReference["digest"],
    options?: RepositoryOperationOptions,
  ): Promise<VersionedPublicationJournalEntry | null> {
    const occurrence = this.controller.before("journal.load");
    const result = await this.delegate.load(bundleKey, options);
    this.controller.after("journal.load", occurrence);
    return result;
  }

  async create(
    entry: PublicationJournalEntry,
    options?: RepositoryOperationOptions,
  ): Promise<VersionedPublicationJournalEntry> {
    const occurrence = this.controller.before("journal.create");
    const result = await this.delegate.create(entry, options);
    this.controller.after("journal.create", occurrence);
    return result;
  }

  async compareAndSwap(
    expected: VersionedPublicationJournalEntry,
    next: PublicationJournalEntry,
    options?: RepositoryOperationOptions,
  ): Promise<VersionedPublicationJournalEntry> {
    const occurrence = this.controller.before("journal.compareAndSwap");
    const result = await this.delegate.compareAndSwap(
      expected,
      next,
      options,
    );
    this.controller.after("journal.compareAndSwap", occurrence);
    return result;
  }
}

class ControlledSink implements AnnouncementSink {
  readonly medium: string;
  readonly profile: string;
  readonly capabilities;

  constructor(
    readonly delegate: AnnouncementSink,
    readonly controller: BoundaryController,
  ) {
    this.medium = delegate.medium;
    this.profile = delegate.profile;
    this.capabilities = delegate.capabilities;
  }

  async prepare(
    members: readonly AnnouncementMember[],
    context: AnnouncementPreparationContext,
    options?: RepositoryOperationOptions,
  ): Promise<PreparedAnnouncement> {
    const occurrence = this.controller.before("sink.prepare");
    const result = await this.delegate.prepare(members, context, options);
    this.controller.after("sink.prepare", occurrence);
    return result;
  }

  async place(
    prepared: PreparedAnnouncement,
    idempotencyKey: EvidenceRecordReference["digest"],
    options?: RepositoryOperationOptions,
  ): Promise<PlaceResult> {
    const occurrence = this.controller.before("sink.place");
    const result = await this.delegate.place(
      prepared,
      idempotencyKey,
      options,
    );
    this.controller.after("sink.place", occurrence);
    return result;
  }

  async reconcile(
    prepared: PreparedAnnouncement,
    pending: PendingAnnouncement,
    options?: RepositoryOperationOptions,
  ): Promise<ReconcileResult> {
    const occurrence = this.controller.before("sink.reconcile");
    const result = await this.delegate.reconcile(
      prepared,
      pending,
      options,
    );
    this.controller.after("sink.reconcile", occurrence);
    return result;
  }
}

function matrixInput(signal?: AbortSignal) {
  const artifactOne = Uint8Array.of(31);
  const artifactTwo = Uint8Array.of(41);
  const recordOne = Uint8Array.of(11);
  const recordTwo = Uint8Array.of(21);
  return {
    artifacts: [
      {
        reference: createArtifactReference(artifactOne),
        bytes: artifactOne,
      },
      {
        reference: createArtifactReference(artifactTwo),
        bytes: artifactTwo,
      },
    ],
    records: [
      {
        reference: createRecordReference("execution-evidence", recordOne),
        bytes: recordOne,
      },
      {
        reference: createRecordReference("result-evaluation", recordTwo),
        bytes: recordTwo,
      },
    ],
    destination: "urn:jinn:publication-destination:fault-matrix",
    signal,
  };
}

const pipelineBoundaries = [
  { label: "journal.load", occurrence: 1 },
  { label: "journal.create", occurrence: 1 },
  { label: "repository.putArtifact", occurrence: 1 },
  { label: "journal.compareAndSwap", occurrence: 1 },
  { label: "repository.putArtifact", occurrence: 2 },
  { label: "journal.compareAndSwap", occurrence: 2 },
  { label: "repository.putRecord", occurrence: 1 },
  { label: "journal.compareAndSwap", occurrence: 3 },
  { label: "repository.putRecord", occurrence: 2 },
  { label: "journal.compareAndSwap", occurrence: 4 },
  { label: "sink.prepare", occurrence: 1 },
  { label: "sink.prepare", occurrence: 2 },
  { label: "sink.prepare", occurrence: 3 },
  { label: "journal.compareAndSwap", occurrence: 5 },
  { label: "journal.compareAndSwap", occurrence: 6 },
  { label: "sink.place", occurrence: 1 },
  { label: "journal.compareAndSwap", occurrence: 7 },
  { label: "journal.compareAndSwap", occurrence: 8 },
  { label: "sink.place", occurrence: 2 },
  { label: "journal.compareAndSwap", occurrence: 9 },
  { label: "journal.compareAndSwap", occurrence: 10 },
] as const;

const pipelineCases = pipelineBoundaries.flatMap((boundary) =>
  (["before", "after"] as const).flatMap((phase) =>
    (["crash", "cancel"] as const).map((mode) => ({
      ...boundary,
      phase,
      mode,
    }))
  )
);

const pendingCheckpointCases = (["before", "after"] as const).flatMap(
  (phase) =>
    (["crash", "cancel"] as const).map((mode) => ({
      phase,
      mode,
    })),
);

type ReconcilePath = "pending" | "confirmed" | "not-found";

function reconciliationPathSink(
  delegate: InMemoryAnnouncementSink,
  path: ReconcilePath,
): AnnouncementSink {
  return {
    medium: delegate.medium,
    profile: delegate.profile,
    capabilities: delegate.capabilities,
    prepare: delegate.prepare.bind(delegate),
    place: delegate.place.bind(delegate),
    reconcile: async (prepared, pending, options) => {
      if (path === "pending") {
        return {
          status: "pending",
          pending: {
            idempotencyKey: pending.idempotencyKey,
            frameDigest: prepared.frameDigest,
            state: {
              format: "https://publication.test/pending-state/v2",
              bytes: Uint8Array.of(2),
            },
          },
        };
      }
      if (path === "not-found") return { status: "not-found" };
      return delegate.reconcile(prepared, pending, options);
    },
  };
}

function laterPartitionPendingSink(
  delegate: InMemoryAnnouncementSink,
): AnnouncementSink {
  let placementCallCount = 0;
  return {
    medium: delegate.medium,
    profile: delegate.profile,
    capabilities: delegate.capabilities,
    prepare: delegate.prepare.bind(delegate),
    place: async (prepared, idempotencyKey, options) => {
      placementCallCount += 1;
      const result = await delegate.place(
        prepared,
        idempotencyKey,
        options,
      );
      if (placementCallCount !== 2) return result;
      return {
        status: "pending",
        pending: {
          idempotencyKey,
          frameDigest: prepared.frameDigest,
          state: {
            format: "https://publication.test/pending-state/later/v1",
            bytes: Uint8Array.of(2),
          },
        },
      };
    },
    reconcile: delegate.reconcile.bind(delegate),
  };
}

function firstPartitionPendingSink(
  delegate: InMemoryAnnouncementSink,
): AnnouncementSink {
  let placementCallCount = 0;
  return {
    medium: delegate.medium,
    profile: delegate.profile,
    capabilities: delegate.capabilities,
    prepare: delegate.prepare.bind(delegate),
    place: async (prepared, idempotencyKey, options) => {
      placementCallCount += 1;
      const result = await delegate.place(
        prepared,
        idempotencyKey,
        options,
      );
      if (placementCallCount !== 1) return result;
      return {
        status: "pending",
        pending: {
          idempotencyKey,
          frameDigest: prepared.frameDigest,
          state: {
            format: "https://publication.test/pending-state/first/v1",
            bytes: Uint8Array.of(1),
          },
        },
      };
    },
    reconcile: delegate.reconcile.bind(delegate),
  };
}

const reconciliationCheckpointCases = (
  ["pending", "confirmed", "not-found"] as const
).flatMap((path) =>
  (["before", "after"] as const).flatMap((phase) =>
    (["crash", "cancel"] as const).map((mode) => ({
      path,
      phase,
      mode,
    }))
  )
);

describe("publication crash and cancellation matrix", () => {
  test.each(pipelineCases)(
    "$mode $phase $label #$occurrence recovers without duplicate effects",
    async ({ label, occurrence, phase, mode }) => {
      const repository = new InMemoryEvidenceRepository();
      const journal = new InMemoryPublicationJournalStore();
      const sink = new InMemoryAnnouncementSink({
        medium: "https://publication.test/medium",
        profile: "https://publication.test/profiles/fault-matrix/v1",
        maxMembersPerAnnouncement: 1,
      });
      const effects: RepositoryEffects = {
        artifactsCreated: 0,
        recordsCreated: 0,
      };
      const abortController =
        mode === "cancel" ? new AbortController() : undefined;
      const fault = new BoundaryController(
        { label, occurrence, phase },
        mode,
        abortController,
      );

      let failure: unknown;
      try {
        await publish(matrixInput(abortController?.signal), {
          repository: new ControlledRepository(
            repository,
            fault,
            effects,
          ),
          journal: new ControlledJournal(journal, fault),
          sink: new ControlledSink(sink, fault),
        });
      } catch (error) {
        failure = error;
      }
      expect(fault.fired).toBe(true);
      expect(failure).toMatchObject({
        code: mode === "cancel" ? "OPERATION_ABORTED" : "IO_FAILURE",
      });

      const preparedBeforeRecovery =
        journal.entries()[0]?.preparedPartitions;
      const prepareCallsBeforeRecovery = sink.prepareCallCount;
      const recovery = new BoundaryController();
      const dependencies = {
        repository: new ControlledRepository(
          repository,
          recovery,
          effects,
        ),
        journal: new ControlledJournal(journal, recovery),
        sink: new ControlledSink(sink, recovery),
      };
      const receipt = await publish(matrixInput(), dependencies);
      const repeated = await publish(matrixInput(), dependencies);

      expect(repeated).toEqual(receipt);
      expect(receipt.completed).toBe(true);
      expect(receipt.placements).toHaveLength(2);
      expect(sink.placementEffectCount).toBe(2);
      expect(effects).toEqual({
        artifactsCreated: 2,
        recordsCreated: 2,
      });
      if (preparedBeforeRecovery !== undefined) {
        expect(sink.prepareCallCount).toBe(prepareCallsBeforeRecovery);
        expect(
          journal.entries()[0]?.preparedPartitions?.map(
            ({ prepared }) => prepared.frameBytes,
          ),
        ).toEqual(
          preparedBeforeRecovery.map(({ prepared }) => prepared.frameBytes),
        );
      }
    },
  );

  test.each(pendingCheckpointCases)(
    "$mode $phase pending-result checkpoint recovers the uncertain effect",
    async ({ phase, mode }) => {
      const repository = new InMemoryEvidenceRepository();
      const journal = new InMemoryPublicationJournalStore();
      const sink = new InMemoryAnnouncementSink({
        medium: "https://publication.test/medium",
        profile: "https://publication.test/profiles/fault-matrix/v1",
        maxMembersPerAnnouncement: 1,
      });
      const abortController =
        mode === "cancel" ? new AbortController() : undefined;
      const fault = new BoundaryController(
        {
          label: "journal.compareAndSwap",
          occurrence: 7,
          phase,
        },
        mode,
        abortController,
      );

      await expect(
        publish(matrixInput(abortController?.signal), {
          repository: new ControlledRepository(
            repository,
            fault,
            { artifactsCreated: 0, recordsCreated: 0 },
          ),
          journal: new ControlledJournal(journal, fault),
          sink: new ControlledSink(
            firstPartitionPendingSink(sink),
            fault,
          ),
        }),
      ).rejects.toMatchObject({
        code: mode === "cancel" ? "OPERATION_ABORTED" : "IO_FAILURE",
      });
      expect(fault.fired).toBe(true);
      expect(sink.placementEffectCount).toBe(1);

      const receipt = await publish(matrixInput(), {
        repository,
        journal,
        sink,
      });
      expect(receipt.completed).toBe(true);
      expect(sink.reconcileCallCount).toBe(1);
      expect(receipt.placements).toHaveLength(2);
      expect(sink.placementEffectCount).toBe(2);
    },
  );

  test.each(reconciliationCheckpointCases)(
    "$mode $phase CAS after $path reconciliation recovers without duplication",
    async ({ path, phase, mode }) => {
      const repository = new InMemoryEvidenceRepository();
      const journal = new InMemoryPublicationJournalStore();
      const sink = new InMemoryAnnouncementSink({
        medium: "https://publication.test/medium",
        profile: "https://publication.test/profiles/fault-matrix/v1",
        maxMembersPerAnnouncement: 1,
      });
      await expect(
        publish(matrixInput(), {
          repository,
          journal,
          sink: firstPartitionPendingSink(sink),
        }),
      ).rejects.toMatchObject({ code: "PLACEMENT_UNCERTAIN" });
      expect(sink.placementEffectCount).toBe(1);

      const abortController =
        mode === "cancel" ? new AbortController() : undefined;
      const fault = new BoundaryController(
        {
          label: "journal.compareAndSwap",
          occurrence: 1,
          phase,
        },
        mode,
        abortController,
      );
      await expect(
        publish(matrixInput(abortController?.signal), {
          repository: new ControlledRepository(
            repository,
            fault,
            { artifactsCreated: 0, recordsCreated: 0 },
          ),
          journal: new ControlledJournal(journal, fault),
          sink: new ControlledSink(
            reconciliationPathSink(sink, path),
            fault,
          ),
        }),
      ).rejects.toMatchObject({
        code: mode === "cancel" ? "OPERATION_ABORTED" : "IO_FAILURE",
      });
      expect(fault.fired).toBe(true);

      const receipt = await publish(matrixInput(), {
        repository,
        journal,
        sink,
      });
      const repeated = await publish(matrixInput(), {
        repository,
        journal,
        sink,
      });
      expect(repeated).toEqual(receipt);
      expect(receipt.completed).toBe(true);
      expect(receipt.placements).toHaveLength(2);
      expect(sink.placementEffectCount).toBe(2);
    },
  );

  test.each(reconciliationCheckpointCases)(
    "$mode $phase later-ordinal CAS after $path reconciliation recovers without duplication",
    async ({ path, phase, mode }) => {
      const repository = new InMemoryEvidenceRepository();
      const journal = new InMemoryPublicationJournalStore();
      const sink = new InMemoryAnnouncementSink({
        medium: "https://publication.test/medium",
        profile: "https://publication.test/profiles/fault-matrix/v1",
        maxMembersPerAnnouncement: 1,
      });
      await expect(
        publish(matrixInput(), {
          repository,
          journal,
          sink: laterPartitionPendingSink(sink),
        }),
      ).rejects.toMatchObject({ code: "PLACEMENT_UNCERTAIN" });
      expect(
        journal.entries()[0]?.preparedPartitions?.map(
          ({ placement }) => placement.status,
        ),
      ).toEqual(["confirmed", "pending"]);
      expect(sink.placementEffectCount).toBe(2);

      const abortController =
        mode === "cancel" ? new AbortController() : undefined;
      const fault = new BoundaryController(
        {
          label: "journal.compareAndSwap",
          occurrence: 1,
          phase,
        },
        mode,
        abortController,
      );
      await expect(
        publish(matrixInput(abortController?.signal), {
          repository: new ControlledRepository(
            repository,
            fault,
            { artifactsCreated: 0, recordsCreated: 0 },
          ),
          journal: new ControlledJournal(journal, fault),
          sink: new ControlledSink(
            reconciliationPathSink(sink, path),
            fault,
          ),
        }),
      ).rejects.toMatchObject({
        code: mode === "cancel" ? "OPERATION_ABORTED" : "IO_FAILURE",
      });
      expect(fault.fired).toBe(true);

      const receipt = await publish(matrixInput(), {
        repository,
        journal,
        sink,
      });
      const repeated = await publish(matrixInput(), {
        repository,
        journal,
        sink,
      });
      expect(repeated).toEqual(receipt);
      expect(receipt.completed).toBe(true);
      expect(receipt.placements).toHaveLength(2);
      expect(sink.placementEffectCount).toBe(2);
    },
  );

  test("concurrent conflicting pending-state checkpoints have one durable winner", async () => {
    const repository = new InMemoryEvidenceRepository();
    const journal = new InMemoryPublicationJournalStore();
    const sink = new InMemoryAnnouncementSink({
      medium: "https://publication.test/medium",
      profile: "https://publication.test/profiles/fault-matrix/v1",
      maxMembersPerAnnouncement: 1,
    });
    await expect(
      publish(matrixInput(), {
        repository,
        journal,
        sink: firstPartitionPendingSink(sink),
      }),
    ).rejects.toMatchObject({ code: "PLACEMENT_UNCERTAIN" });
    const current = journal.entries()[0]!;
    const partition = current.preparedPartitions![0]!;
    if (partition.placement.status !== "pending") {
      throw new Error("fixture expected a pending placement");
    }
    const pendingPlacement = partition.placement.pending;
    const candidate = (stateByte: number): PublicationJournalEntry => ({
      ...current,
      preparedPartitions: current.preparedPartitions!.map(
        (candidatePartition) =>
          candidatePartition.ordinal === partition.ordinal
            ? {
              ...candidatePartition,
              placement: {
                status: "pending" as const,
                pending: {
                  ...pendingPlacement,
                  state: {
                    format: "https://publication.test/pending-state/v2",
                    bytes: Uint8Array.of(stateByte),
                  },
                },
              },
            }
            : candidatePartition,
      ),
    });

    const results = await Promise.allSettled([
      journal.compareAndSwap(current, candidate(2)),
      journal.compareAndSwap(current, candidate(3)),
    ]);
    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(
      1,
    );
    expect(results.filter(({ status }) => status === "rejected")).toMatchObject([
      { reason: { code: "JOURNAL_CONFLICT" } },
    ]);

    const receipt = await publish(matrixInput(), {
      repository,
      journal,
      sink,
    });
    expect(receipt.completed).toBe(true);
    expect(receipt.placements).toHaveLength(2);
    expect(sink.placementEffectCount).toBe(2);
  });

  test.each([
    ["crash", "before"],
    ["crash", "after"],
    ["cancel", "before"],
    ["cancel", "after"],
  ] as const)(
    "%s %s sink reconciliation remains recoverable",
    async (mode, phase) => {
      const repository = new InMemoryEvidenceRepository();
      const journal = new InMemoryPublicationJournalStore();
      const sink = new InMemoryAnnouncementSink({
        medium: "https://publication.test/medium",
        profile: "https://publication.test/profiles/fault-matrix/v1",
        maxMembersPerAnnouncement: 1,
      });
      await expect(
        publish(matrixInput(), {
          repository,
          journal,
          sink: firstPartitionPendingSink(sink),
        }),
      ).rejects.toMatchObject({ code: "PLACEMENT_UNCERTAIN" });
      expect(sink.placementEffectCount).toBe(1);

      const abortController =
        mode === "cancel" ? new AbortController() : undefined;
      const fault = new BoundaryController(
        {
          label: "sink.reconcile",
          occurrence: 1,
          phase,
        },
        mode,
        abortController,
      );
      await expect(
        publish(matrixInput(abortController?.signal), {
          repository: new ControlledRepository(
            repository,
            fault,
            { artifactsCreated: 0, recordsCreated: 0 },
          ),
          journal: new ControlledJournal(journal, fault),
          sink: new ControlledSink(sink, fault),
        }),
      ).rejects.toMatchObject({
        code: mode === "cancel" ? "OPERATION_ABORTED" : "IO_FAILURE",
      });
      expect(fault.fired).toBe(true);

      const receipt = await publish(matrixInput(), {
        repository,
        journal,
        sink,
      });
      expect(receipt.completed).toBe(true);
      expect(receipt.placements).toHaveLength(2);
      expect(sink.placementEffectCount).toBe(2);
    },
  );
});
