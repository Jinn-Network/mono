// SPDX-License-Identifier: Apache-2.0
import { getEventListeners } from "node:events";

import {
  createArtifactReference,
  createRecordReference,
  EvidenceRepositoryError,
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

import { publish } from "./publish.js";
import {
  InMemoryAnnouncementSink,
  InMemoryPublicationJournalStore,
} from "./testing.js";
import type {
  AnnouncementSink,
  PreparedAnnouncement,
  PublicationJournalStore,
  PublishInput,
} from "./types.js";

const abortSignalAbortedGetter = Object.getOwnPropertyDescriptor(
  AbortSignal.prototype,
  "aborted",
)?.get;

function abortAndShadowSignal(
  controller: AbortController,
  signal: AbortSignal,
): void {
  controller.abort();
  Object.defineProperties(signal, {
    aborted: {
      configurable: true,
      value: false,
    },
    addEventListener: {
      configurable: true,
      value: () => {
        throw new Error("shadowed addEventListener must not be used");
      },
    },
    removeEventListener: {
      configurable: true,
      value: () => {
        throw new Error("shadowed removeEventListener must not be used");
      },
    },
  });
  expect(
    Reflect.apply(abortSignalAbortedGetter!, signal, []),
  ).toBe(true);
  expect(signal.aborted).toBe(false);
}

function immutableCapabilities(
  maxObjectBytes?: number,
  future = false,
): EvidenceRepositoryCapabilities {
  const capabilities = Object.create(null) as Record<string, unknown>;
  if (maxObjectBytes !== undefined) {
    Object.defineProperty(capabilities, "maxObjectBytes", {
      enumerable: true,
      configurable: false,
      writable: false,
      value: maxObjectBytes,
    });
  }
  if (future) {
    Object.defineProperty(capabilities, "futureCapability", {
      enumerable: true,
      configurable: false,
      writable: false,
      value: "ignored",
    });
  }
  return Object.preventExtensions(capabilities);
}

class RecordingRepository implements EvidenceRepository {
  readonly capabilities: EvidenceRepositoryCapabilities;
  readonly events: string[] = [];
  readonly delegate: InMemoryEvidenceRepository;

  constructor(
    capabilities = immutableCapabilities(),
    delegate = new InMemoryEvidenceRepository(),
  ) {
    this.capabilities = capabilities;
    this.delegate = delegate;
  }

  async putRecord(
    family: EvidenceRecordFamily,
    bytes: Uint8Array,
    options?: RepositoryOperationOptions,
  ): Promise<RepositoryWriteReceipt<EvidenceRecordReference>> {
    this.events.push(`record:${family}:${bytes[0]}`);
    return this.delegate.putRecord(family, bytes, options);
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
    this.events.push(`artifact:${bytes[0]}`);
    return this.delegate.putArtifact(bytes, options);
  }

  getArtifact(
    reference: EvidenceArtifactReference,
    options?: RepositoryOperationOptions,
  ): Promise<Uint8Array | null> {
    return this.delegate.getArtifact(reference, options);
  }
}

function sink(): InMemoryAnnouncementSink {
  return new InMemoryAnnouncementSink({
    medium: "https://publication.test/medium",
    profile: "https://publication.test/profiles/canonical-json/v1",
    maxMembersPerAnnouncement: 2,
    maxFrameBytes: 4_096,
  });
}

function input(): PublishInput {
  const recordOne = new Uint8Array([20, 21]);
  const recordTwo = new Uint8Array([10]);
  const artifactOne = new Uint8Array([40]);
  const artifactTwo = new Uint8Array([30]);
  return {
    records: [
      {
        reference: createRecordReference("result-evaluation", recordOne),
        bytes: recordOne,
      },
      {
        reference: createRecordReference("execution-evidence", recordTwo),
        bytes: recordTwo,
      },
    ],
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
    destination: "urn:jinn:publication-destination:pipeline-test",
  };
}

describe("publish", () => {
  test("preflights every object before journal, repository, or sink effects", async () => {
    const repository = new RecordingRepository(immutableCapabilities(1, true));
    const journal = new InMemoryPublicationJournalStore();
    const announcementSink = sink();

    await expect(
      publish(input(), {
        repository,
        sink: announcementSink,
        journal,
      }),
    ).rejects.toMatchObject({ code: "REPOSITORY_CAPABILITY_EXCEEDED" });

    expect(repository.events).toEqual([]);
    expect(journal.entryCount).toBe(0);
    expect(announcementSink.prepareCallCount).toBe(0);
    expect(announcementSink.placementEffectCount).toBe(0);
  });

  test.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "rejects non-positive or non-safe repository limit %s before effects",
    async (limit) => {
      const repository = new RecordingRepository(
        immutableCapabilities(limit),
      );
      const journal = new InMemoryPublicationJournalStore();
      const announcementSink = sink();

      await expect(
        publish(input(), {
          repository,
          sink: announcementSink,
          journal,
        }),
      ).rejects.toMatchObject({ code: "INVALID_INPUT" });
      expect(repository.events).toEqual([]);
      expect(journal.entryCount).toBe(0);
      expect(announcementSink.prepareCallCount).toBe(0);
    },
  );

  test("rejects inherited maxObjectBytes without invoking its getter", async () => {
    let getterCalls = 0;
    Object.defineProperty(Object.prototype, "maxObjectBytes", {
      configurable: true,
      get: () => {
        getterCalls += 1;
        return 1;
      },
    });
    try {
      const capabilities = Object.preventExtensions({});
      await expect(
        publish(input(), {
          repository: new RecordingRepository(capabilities),
          sink: sink(),
          journal: new InMemoryPublicationJournalStore(),
        }),
      ).rejects.toMatchObject({ code: "INVALID_INPUT" });
      expect(getterCalls).toBe(0);
    } finally {
      Reflect.deleteProperty(Object.prototype, "maxObjectBytes");
    }
  });

  test("rejects accessor-backed limits and future fields without evaluating them", async () => {
    for (const name of ["maxObjectBytes", "futureCapability"]) {
      let getterCalls = 0;
      const capabilities = Object.create(null) as Record<string, unknown>;
      Object.defineProperty(capabilities, name, {
        configurable: false,
        enumerable: false,
        get: () => {
          getterCalls += 1;
          return 1;
        },
      });
      Object.preventExtensions(capabilities);

      await expect(
        publish(input(), {
          repository: new RecordingRepository(capabilities),
          sink: sink(),
          journal: new InMemoryPublicationJournalStore(),
        }),
      ).rejects.toMatchObject({ code: "INVALID_INPUT" });
      expect(getterCalls).toBe(0);
    }
  });

  test("treats no finite limit as unbounded and ignores future capabilities", async () => {
    const repository = new RecordingRepository(
      immutableCapabilities(undefined, true),
    );
    const receipt = await publish(input(), {
      repository,
      sink: sink(),
      journal: new InMemoryPublicationJournalStore(),
    });

    expect(receipt.completed).toBe(true);
  });

  test("stores sorted artifacts, then sorted records, before preparation", async () => {
    const repository = new RecordingRepository();
    const journal = new InMemoryPublicationJournalStore();
    const announcementSink = sink();
    announcementSink.beforePrepare = () => {
      repository.events.push("prepare");
    };

    await publish(input(), {
      repository,
      sink: announcementSink,
      journal,
    });

    const artifactEvents = repository.events.filter((event) =>
      event.startsWith("artifact:")
    );
    const recordEvents = repository.events.filter((event) =>
      event.startsWith("record:")
    );
    const firstPreparation = repository.events.indexOf("prepare");
    expect(repository.events.slice(0, firstPreparation)).toEqual([
      ...artifactEvents,
      ...recordEvents,
    ]);
    expect(
      repository.events.slice(firstPreparation).every(
        (event) => event === "prepare",
      ),
    ).toBe(true);
    expect(artifactEvents).toHaveLength(2);
    expect(recordEvents).toHaveLength(2);
  });

  test("propagates a repository error as the same object", async () => {
    const repository = new RecordingRepository();
    const controller = new AbortController();
    const expected = new EvidenceRepositoryError(
      "DEPENDENCY_UNAVAILABLE",
      "fixture unavailable",
      { cause: new Error("root cause") },
    );
    repository.putArtifact = async (_bytes, options) => {
      expect(
        getEventListeners(options!.signal!, "abort"),
      ).toHaveLength(1);
      throw expected;
    };

    let caught: unknown;
    try {
      await publish({ ...input(), signal: controller.signal }, {
        repository,
        sink: sink(),
        journal: new InMemoryPublicationJournalStore(),
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(expected);
    expect((caught as EvidenceRepositoryError).cause).toBe(expected.cause);
    expect(
      getEventListeners(controller.signal, "abort"),
    ).toHaveLength(0);
  });

  test("rejects a mismatched repository receipt with a repository error", async () => {
    const repository = new RecordingRepository();
    const actual = repository.putArtifact.bind(repository);
    repository.putArtifact = async (bytes, options) => {
      const receipt = await actual(bytes, options);
      return { ...receipt, size: receipt.size + 1 };
    };

    await expect(
      publish(input(), {
        repository,
        sink: sink(),
        journal: new InMemoryPublicationJournalStore(),
      }),
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof EvidenceRepositoryError &&
        error.code === "REFERENCE_CONFLICT",
    );
  });

  test("reuses checkpointed content-addressed writes after interruption", async () => {
    const repository = new RecordingRepository();
    const journal = new InMemoryPublicationJournalStore();
    const announcementSink = sink();
    const actual = repository.putRecord.bind(repository);
    let failOnce = true;
    repository.putRecord = async (family, bytes, options) => {
      if (failOnce) {
        failOnce = false;
        throw new EvidenceRepositoryError(
          "DEPENDENCY_UNAVAILABLE",
          "transient fixture failure",
        );
      }
      return actual(family, bytes, options);
    };

    await expect(
      publish(input(), {
        repository,
        sink: announcementSink,
        journal,
      }),
    ).rejects.toMatchObject({ code: "DEPENDENCY_UNAVAILABLE" });
    const firstArtifactEvents = repository.events.filter((event) =>
      event.startsWith("artifact:")
    );

    const receipt = await publish(input(), {
      repository,
      sink: announcementSink,
      journal,
    });

    expect(receipt.completed).toBe(true);
    expect(
      repository.events.filter((event) => event.startsWith("artifact:")),
    ).toEqual(firstArtifactEvents);
  });

  test("rechecks only uncheckpointed bytes against current repository capabilities", async () => {
    const delegate = new InMemoryEvidenceRepository();
    const initialRepository = new RecordingRepository(
      immutableCapabilities(),
      delegate,
    );
    const journal = new InMemoryPublicationJournalStore();
    const announcementSink = sink();
    initialRepository.putRecord = async () => {
      throw new EvidenceRepositoryError(
        "DEPENDENCY_UNAVAILABLE",
        "fixture interruption before the first record",
      );
    };

    await expect(
      publish(input(), {
        repository: initialRepository,
        sink: announcementSink,
        journal,
      }),
    ).rejects.toMatchObject({ code: "DEPENDENCY_UNAVAILABLE" });
    expect(journal.entries()[0]?.storedArtifacts).toHaveLength(2);
    expect(journal.entries()[0]?.storedRecords).toHaveLength(0);

    const narrowed = new RecordingRepository(
      immutableCapabilities(1),
      delegate,
    );
    await expect(
      publish(input(), {
        repository: narrowed,
        sink: announcementSink,
        journal,
      }),
    ).rejects.toMatchObject({
      code: "REPOSITORY_CAPABILITY_EXCEEDED",
    });
    expect(narrowed.events).toEqual([]);
  });

  test("checkpoints the complete prepared plan before the first placement", async () => {
    const repository = new RecordingRepository();
    const journal = new InMemoryPublicationJournalStore();
    const announcementSink = sink();
    announcementSink.beforePlace = async (_prepared, idempotencyKey) => {
      const entries = journal.entries();
      expect(entries).toHaveLength(1);
      const current = entries[0]!;
      expect(current.preparedPartitions).toHaveLength(1);
      const partition = current.preparedPartitions?.[0];
      expect(partition?.placement).toEqual({
        status: "pending",
        pending: {
          idempotencyKey,
          frameDigest: partition?.prepared.frameDigest,
        },
      });
    };

    await publish(input(), {
      repository,
      sink: announcementSink,
      journal,
    });
  });

  test("keeps the original publish signal when prepare throws while trying to replace it", async () => {
    const repository = new RecordingRepository();
    const journal = new InMemoryPublicationJournalStore();
    const delegate = sink();
    const controller = new AbortController();
    const replacement = new AbortController();
    const publishInput = { ...input(), signal: controller.signal };
    let mutationThrew = false;
    const mutatingSink: AnnouncementSink = {
      medium: delegate.medium,
      profile: delegate.profile,
      capabilities: delegate.capabilities,
      prepare: async (members, context, options) => {
        const prepared = await delegate.prepare(members, context, options);
        controller.abort();
        try {
          (
            options as {
              signal?: AbortSignal;
            }
          ).signal = replacement.signal;
        } catch (error) {
          mutationThrew = error instanceof TypeError;
        }
        return prepared;
      },
      place: delegate.place.bind(delegate),
      reconcile: delegate.reconcile.bind(delegate),
    };

    await expect(
      publish(publishInput, {
        repository,
        sink: mutatingSink,
        journal,
      }),
    ).rejects.toMatchObject({ code: "OPERATION_ABORTED" });

    expect(mutationThrew).toBe(true);
    expect(publishInput.signal).toBe(controller.signal);
    expect(delegate.placementEffectCount).toBe(0);

    const receipt = await publish(input(), {
      repository,
      sink: mutatingSink,
      journal,
    });
    expect(receipt.completed).toBe(true);
    expect(delegate.placementEffectCount).toBe(1);
  });

  test("latches cancellation when prepare shadows the native signal state", async () => {
    const repository = new RecordingRepository();
    const journal = new InMemoryPublicationJournalStore();
    const delegate = sink();
    const controller = new AbortController();
    let mutate = true;
    const mutatingSink: AnnouncementSink = {
      medium: delegate.medium,
      profile: delegate.profile,
      capabilities: delegate.capabilities,
      prepare: async (members, context, options) => {
        const prepared = await delegate.prepare(members, context, options);
        if (mutate) {
          mutate = false;
          abortAndShadowSignal(controller, options!.signal!);
        }
        return prepared;
      },
      place: delegate.place.bind(delegate),
      reconcile: delegate.reconcile.bind(delegate),
    };

    await expect(
      publish(
        { ...input(), signal: controller.signal },
        { repository, sink: mutatingSink, journal },
      ),
    ).rejects.toMatchObject({ code: "OPERATION_ABORTED" });

    expect(delegate.placementEffectCount).toBe(0);
    expect(journal.entries()[0]?.preparedPartitions).toBeUndefined();

    const receipt = await publish(input(), {
      repository,
      sink: mutatingSink,
      journal,
    });
    expect(receipt.completed).toBe(true);
    expect(delegate.placementEffectCount).toBe(1);
  });

  test("reuses one private latch through preparation and placement, then removes it", async () => {
    const repository = new RecordingRepository();
    const journal = new InMemoryPublicationJournalStore();
    const delegate = sink();
    const controller = new AbortController();
    const listenerCounts: number[] = [];
    const observingSink: AnnouncementSink = {
      medium: delegate.medium,
      profile: delegate.profile,
      capabilities: delegate.capabilities,
      prepare: async (members, context, options) => {
        listenerCounts.push(
          getEventListeners(options!.signal!, "abort").length,
        );
        return delegate.prepare(members, context, options);
      },
      place: async (prepared, idempotencyKey, options) => {
        listenerCounts.push(
          getEventListeners(options!.signal!, "abort").length,
        );
        return delegate.place(prepared, idempotencyKey, options);
      },
      reconcile: delegate.reconcile.bind(delegate),
    };

    const receipt = await publish(
      { ...input(), signal: controller.signal },
      { repository, sink: observingSink, journal },
    );

    expect(receipt.completed).toBe(true);
    expect(listenerCounts.length).toBeGreaterThan(1);
    expect(listenerCounts.every((count) => count === 1)).toBe(true);
    expect(
      getEventListeners(controller.signal, "abort"),
    ).toHaveLength(0);
  });

  test("rejects an already-aborted publish before any effect", async () => {
    const repository = new RecordingRepository();
    const journal = new InMemoryPublicationJournalStore();
    const announcementSink = sink();
    const controller = new AbortController();
    abortAndShadowSignal(controller, controller.signal);

    await expect(
      publish(
        { ...input(), signal: controller.signal },
        { repository, sink: announcementSink, journal },
      ),
    ).rejects.toMatchObject({ code: "OPERATION_ABORTED" });

    expect(repository.events).toEqual([]);
    expect(journal.entryCount).toBe(0);
    expect(announcementSink.prepareCallCount).toBe(0);
    expect(announcementSink.placementEffectCount).toBe(0);
  });

  test.each(["load", "create", "compareAndSwap"] as const)(
    "latches cancellation after the journal %s await",
    async (stage) => {
      const repository = new RecordingRepository();
      const delegateJournal = new InMemoryPublicationJournalStore();
      const announcementSink = sink();
      const controller = new AbortController();
      let mutate = true;
      const maybeMutate = (options?: RepositoryOperationOptions): void => {
        if (!mutate) return;
        mutate = false;
        abortAndShadowSignal(controller, options!.signal!);
      };
      const journal: PublicationJournalStore = {
        load: async (bundleKey, options) => {
          const result = await delegateJournal.load(bundleKey, options);
          if (stage === "load") maybeMutate(options);
          return result;
        },
        create: async (entry, options) => {
          const result = await delegateJournal.create(entry, options);
          if (stage === "create") maybeMutate(options);
          return result;
        },
        compareAndSwap: async (expected, next, options) => {
          const result = await delegateJournal.compareAndSwap(
            expected,
            next,
            options,
          );
          if (stage === "compareAndSwap") maybeMutate(options);
          return result;
        },
      };

      await expect(
        publish(
          { ...input(), signal: controller.signal },
          { repository, sink: announcementSink, journal },
        ),
      ).rejects.toMatchObject({ code: "OPERATION_ABORTED" });

      expect(announcementSink.placementEffectCount).toBe(0);
      expect(delegateJournal.entryCount).toBe(stage === "load" ? 0 : 1);
      expect(
        delegateJournal.entries()[0]?.storedArtifacts.length ?? 0,
      ).toBe(stage === "compareAndSwap" ? 1 : 0);

      const receipt = await publish(input(), {
        repository,
        sink: announcementSink,
        journal: delegateJournal,
      });
      expect(receipt.completed).toBe(true);
      expect(announcementSink.placementEffectCount).toBe(1);
    },
  );

  test.each(["artifact", "record"] as const)(
    "latches cancellation after the repository %s await",
    async (stage) => {
      const repository = new RecordingRepository();
      const journal = new InMemoryPublicationJournalStore();
      const announcementSink = sink();
      const controller = new AbortController();
      let mutate = true;
      const maybeMutate = (options?: RepositoryOperationOptions): void => {
        if (!mutate) return;
        mutate = false;
        abortAndShadowSignal(controller, options!.signal!);
      };
      if (stage === "artifact") {
        const putArtifact = repository.putArtifact.bind(repository);
        repository.putArtifact = async (bytes, options) => {
          const receipt = await putArtifact(bytes, options);
          maybeMutate(options);
          return receipt;
        };
      } else {
        const putRecord = repository.putRecord.bind(repository);
        repository.putRecord = async (family, bytes, options) => {
          const receipt = await putRecord(family, bytes, options);
          maybeMutate(options);
          return receipt;
        };
      }

      await expect(
        publish(
          { ...input(), signal: controller.signal },
          { repository, sink: announcementSink, journal },
        ),
      ).rejects.toMatchObject({ code: "OPERATION_ABORTED" });

      expect(announcementSink.placementEffectCount).toBe(0);
      expect(journal.entries()[0]?.storedRecords).toHaveLength(0);
      expect(journal.entries()[0]?.storedArtifacts).toHaveLength(
        stage === "record" ? 2 : 0,
      );

      const receipt = await publish(input(), {
        repository,
        sink: announcementSink,
        journal,
      });
      expect(receipt.completed).toBe(true);
      expect(announcementSink.placementEffectCount).toBe(1);
    },
  );

  test("returns the same stable receipt for an identical completed call", async () => {
    const repository = new RecordingRepository();
    const journal = new InMemoryPublicationJournalStore();
    const announcementSink = sink();
    const first = await publish(input(), {
      repository,
      sink: announcementSink,
      journal,
    });
    const effects = announcementSink.placementEffectCount;

    expect(
      await publish(input(), {
        repository,
        sink: announcementSink,
        journal,
      }),
    ).toEqual(first);
    expect(announcementSink.placementEffectCount).toBe(effects);

    const narrowedAfterCompletion = new RecordingRepository(
      immutableCapabilities(1),
      repository.delegate,
    );
    expect(
      await publish(input(), {
        repository: narrowedAfterCompletion,
        sink: announcementSink,
        journal,
      }),
    ).toEqual(first);
    expect(narrowedAfterCompletion.events).toEqual([]);
  });

  test.each([
    "omit",
    "substitute",
    "reorder",
    "duplicate",
    "medium",
    "profile",
  ] as const)(
    "rejects sink %s corruption before plan checkpoint or placement",
    async (corruption) => {
    const repository = new RecordingRepository();
    const journal = new InMemoryPublicationJournalStore();
    const delegate = sink();
    const corruptingSink: AnnouncementSink = {
      ...delegate,
      capabilities: delegate.capabilities,
      medium: delegate.medium,
      profile: delegate.profile,
      prepare: async (members, context, options) => {
        const prepared = await delegate.prepare(members, context, options);
        if (members.length < 2) return prepared;
        const replacement = {
          reference: createRecordReference(
            "execution-verification",
            Uint8Array.of(99),
          ),
        };
        return {
          ...prepared,
          ...(corruption === "medium"
            ? { medium: "https://publication.test/changed-medium" }
            : corruption === "profile"
            ? { profile: "https://publication.test/profiles/changed/v2" }
            : {
                members:
                  corruption === "omit"
                    ? prepared.members.slice(0, 1)
                    : corruption === "substitute"
                    ? [replacement, prepared.members[1]!]
                    : corruption === "reorder"
                    ? [...prepared.members].reverse()
                    : [prepared.members[0]!, prepared.members[0]!],
              }),
        } as PreparedAnnouncement;
      },
      place: delegate.place.bind(delegate),
      reconcile: delegate.reconcile.bind(delegate),
    };

    await expect(
      publish(input(), {
        repository,
        sink: corruptingSink,
        journal,
      }),
    ).rejects.toMatchObject({ code: "SINK_PROTOCOL_VIOLATION" });
    expect(journal.entries()[0]?.preparedPartitions).toBeUndefined();
    expect(delegate.placementEffectCount).toBe(0);
    },
  );
});
