// SPDX-License-Identifier: Apache-2.0
import {
  createArtifactReference,
  createRecordReference,
  EvidenceRepositoryError,
  type EvidenceRepository,
  type RepositoryOperationOptions,
} from "@jinn-network/evidence-repository";
import {
  InMemoryEvidenceRepository,
} from "@jinn-network/evidence-repository/testing";
import { describe, expect, test } from "vitest";

import { EvidencePublicationError } from "./errors.js";
import { normalizePublishInput } from "./identities.js";
import { prepareAnnouncementPartitions } from "./partition.js";
import { publish } from "./publish.js";
import { reconcile } from "./reconcile.js";
import {
  InMemoryAnnouncementSink,
  InMemoryPublicationJournalStore,
} from "./testing.js";
import type {
  AnnouncementMember,
  AnnouncementSink,
  PublicationDependencies,
  PublicationJournalStore,
  PublicationReceipt,
  PublishInput,
} from "./types.js";

const DEPENDENCY_STAGES = [
  "journal-load",
  "journal-create",
  "journal-cas",
  "repository-artifact",
  "repository-record",
  "sink-prepare",
  "sink-place",
  "sink-reconcile",
] as const;

type DependencyStage = (typeof DEPENDENCY_STAGES)[number];

interface FailureScenario {
  readonly invoke: () => Promise<PublicationReceipt>;
  readonly recover: () => Promise<PublicationReceipt>;
  readonly observedCallerCancellation: () => boolean;
  readonly placementEffectCount: () => number;
}

interface PendingPublication {
  readonly repository: InMemoryEvidenceRepository;
  readonly journal: InMemoryPublicationJournalStore;
  readonly sink: InMemoryAnnouncementSink;
  readonly bundleKey: ReturnType<typeof normalizePublishInput>["bundleKey"];
}

class RepositoryErrorSubclass extends EvidenceRepositoryError {}
class JournalConflictSubclass extends EvidencePublicationError {}

function publicationInput(signal?: AbortSignal): PublishInput {
  const record = Uint8Array.of(10, 11);
  const artifact = Uint8Array.of(20, 21);
  return {
    records: [{
      reference: createRecordReference("execution-evidence", record),
      bytes: record,
    }],
    artifacts: [{
      reference: createArtifactReference(artifact),
      bytes: artifact,
    }],
    destination: "urn:jinn:publication-destination:await-cancellation",
    ...(signal === undefined ? {} : { signal }),
  };
}

function publicationSink(): InMemoryAnnouncementSink {
  return new InMemoryAnnouncementSink({
    medium: "https://publication.test/await-cancellation-medium",
    profile: "https://publication.test/profiles/await-cancellation/v1",
    maxFrameBytes: 4_096,
  });
}

function recordMembers(): readonly AnnouncementMember[] {
  const bytes = Uint8Array.of(30);
  return [{
    reference: createRecordReference("execution-evidence", bytes),
  }];
}

async function captureRejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("Expected the operation to reject.");
}

function resolvedThenAbort<T>(
  value: T,
  controller: AbortController,
): Promise<T> {
  return {
    then(resolve: (resolved: T) => unknown): void {
      resolve(value);
      queueMicrotask(() => controller.abort());
    },
  } as unknown as Promise<T>;
}

async function failureScenario(
  stage: DependencyStage,
  rejection: unknown,
  controller?: AbortController,
): Promise<FailureScenario> {
  const repositoryDelegate = new InMemoryEvidenceRepository();
  const journalDelegate = new InMemoryPublicationJournalStore();
  const sinkDelegate = publicationSink();
  let observedCallerCancellation = false;

  async function failAfter<T>(
    effect: Promise<T>,
    options?: RepositoryOperationOptions,
  ): Promise<T> {
    await effect;
    if (controller !== undefined) {
      controller.abort();
      observedCallerCancellation =
        options?.signal === controller.signal &&
        options.signal.aborted;
    }
    throw rejection;
  }

  const repository: EvidenceRepository = {
    capabilities: repositoryDelegate.capabilities,
    putArtifact: (bytes, options) =>
      stage === "repository-artifact"
        ? failAfter(
          repositoryDelegate.putArtifact(bytes, options),
          options,
        )
        : repositoryDelegate.putArtifact(bytes, options),
    putRecord: (family, bytes, options) =>
      stage === "repository-record"
        ? failAfter(
          repositoryDelegate.putRecord(family, bytes, options),
          options,
        )
        : repositoryDelegate.putRecord(family, bytes, options),
    getArtifact: (reference, options) =>
      repositoryDelegate.getArtifact(reference, options),
    getRecord: (reference, options) =>
      repositoryDelegate.getRecord(reference, options),
  };

  const journal: PublicationJournalStore = {
    load: (bundleKey, options) =>
      stage === "journal-load"
        ? failAfter(journalDelegate.load(bundleKey, options), options)
        : journalDelegate.load(bundleKey, options),
    create: (entry, options) =>
      stage === "journal-create"
        ? failAfter(journalDelegate.create(entry, options), options)
        : journalDelegate.create(entry, options),
    compareAndSwap: (expected, next, options) =>
      stage === "journal-cas"
        ? failAfter(
          journalDelegate.compareAndSwap(expected, next, options),
          options,
        )
        : journalDelegate.compareAndSwap(expected, next, options),
  };

  const failingSink: AnnouncementSink = {
    medium: sinkDelegate.medium,
    profile: sinkDelegate.profile,
    capabilities: sinkDelegate.capabilities,
    prepare: (members, context, options) =>
      stage === "sink-prepare"
        ? failAfter(
          sinkDelegate.prepare(members, context, options),
          options,
        )
        : sinkDelegate.prepare(members, context, options),
    place: (prepared, idempotencyKey, options) =>
      stage === "sink-place"
        ? failAfter(
          sinkDelegate.place(prepared, idempotencyKey, options),
          options,
        )
        : sinkDelegate.place(prepared, idempotencyKey, options),
    reconcile: (prepared, pending, options) =>
      stage === "sink-reconcile"
        ? failAfter(
          sinkDelegate.reconcile(prepared, pending, options),
          options,
        )
        : sinkDelegate.reconcile(prepared, pending, options),
  };

  const stableDependencies: PublicationDependencies = {
    repository: repositoryDelegate,
    journal: journalDelegate,
    sink: sinkDelegate,
  };

  if (stage === "sink-reconcile") {
    let losePlacementResponse = true;
    const uncertainSink: AnnouncementSink = {
      medium: sinkDelegate.medium,
      profile: sinkDelegate.profile,
      capabilities: sinkDelegate.capabilities,
      prepare: sinkDelegate.prepare.bind(sinkDelegate),
      place: async (prepared, idempotencyKey, options) => {
        const result = await sinkDelegate.place(
          prepared,
          idempotencyKey,
          options,
        );
        if (losePlacementResponse) {
          losePlacementResponse = false;
          throw new EvidencePublicationError(
            "PLACEMENT_UNCERTAIN",
            "The fixture discarded the first placement response.",
          );
        }
        return result;
      },
      reconcile: sinkDelegate.reconcile.bind(sinkDelegate),
    };
    const initialInput = publicationInput();
    const normalized = normalizePublishInput(initialInput);
    const setupError = await captureRejection(
      publish(initialInput, {
        repository: repositoryDelegate,
        journal: journalDelegate,
        sink: uncertainSink,
      }),
    );
    if (
      !(setupError instanceof EvidencePublicationError) ||
      setupError.code !== "PLACEMENT_UNCERTAIN"
    ) {
      throw setupError;
    }

    return {
      invoke: () =>
        reconcile(
          normalized.bundleKey,
          {
            repository: repositoryDelegate,
            journal: journalDelegate,
            sink: failingSink,
          },
          controller === undefined
            ? undefined
            : { signal: controller.signal },
        ),
      recover: () =>
        reconcile(normalized.bundleKey, stableDependencies),
      observedCallerCancellation: () => observedCallerCancellation,
      placementEffectCount: () => sinkDelegate.placementEffectCount,
    };
  }

  return {
    invoke: () =>
      publish(
        publicationInput(controller?.signal),
        { repository, journal, sink: failingSink },
      ),
    recover: () => publish(publicationInput(), stableDependencies),
    observedCallerCancellation: () => observedCallerCancellation,
    placementEffectCount: () => sinkDelegate.placementEffectCount,
  };
}

async function pendingPublication(): Promise<PendingPublication> {
  const repository = new InMemoryEvidenceRepository();
  const journal = new InMemoryPublicationJournalStore();
  const sink = publicationSink();
  let losePlacementResponse = true;
  const uncertainSink: AnnouncementSink = {
    medium: sink.medium,
    profile: sink.profile,
    capabilities: sink.capabilities,
    prepare: sink.prepare.bind(sink),
    place: async (prepared, idempotencyKey, options) => {
      const result = await sink.place(
        prepared,
        idempotencyKey,
        options,
      );
      if (losePlacementResponse) {
        losePlacementResponse = false;
        throw new EvidencePublicationError(
          "PLACEMENT_UNCERTAIN",
          "The fixture discarded the first placement response.",
        );
      }
      return result;
    },
    reconcile: sink.reconcile.bind(sink),
  };
  const input = publicationInput();
  const setupError = await captureRejection(
    publish(input, { repository, journal, sink: uncertainSink }),
  );
  if (
    !(setupError instanceof EvidencePublicationError) ||
    setupError.code !== "PLACEMENT_UNCERTAIN"
  ) {
    throw setupError;
  }
  return {
    repository,
    journal,
    sink,
    bundleKey: normalizePublishInput(input).bundleKey,
  };
}

describe("awaited publication cancellation precedence", () => {
  test.each(DEPENDENCY_STAGES)(
    "maps latched cancellation after rejected %s to publication cancellation",
    async (stage) => {
      const controller = new AbortController();
      const rejection = new DOMException(
        "The dependency observed cancellation.",
        "AbortError",
      );
      const scenario = await failureScenario(
        stage,
        rejection,
        controller,
      );

      const caught = await captureRejection(scenario.invoke());

      expect(scenario.observedCallerCancellation()).toBe(true);
      expect(caught).not.toBe(rejection);
      expect(caught).toBeInstanceOf(EvidencePublicationError);
      expect(caught).toMatchObject({ code: "OPERATION_ABORTED" });

      const receipt = await scenario.recover();
      expect(receipt.completed).toBe(true);
      expect(scenario.placementEffectCount()).toBe(1);
    },
  );

  test.each(DEPENDENCY_STAGES)(
    "preserves the exact repository error after simultaneous cancellation at %s",
    async (stage) => {
      const controller = new AbortController();
      const cause = new Error(`root cause at ${stage}`);
      const expected = new EvidenceRepositoryError(
        stage === "repository-artifact"
          ? "OPERATION_ABORTED"
          : "DEPENDENCY_UNAVAILABLE",
        `repository failure at ${stage}`,
        { cause },
      );
      const scenario = await failureScenario(
        stage,
        expected,
        controller,
      );

      const caught = await captureRejection(scenario.invoke());

      expect(scenario.observedCallerCancellation()).toBe(true);
      expect(caught).toBe(expected);
      expect(caught).toBeInstanceOf(EvidenceRepositoryError);
      expect((caught as EvidenceRepositoryError).code).toBe(expected.code);
      expect((caught as EvidenceRepositoryError).cause).toBe(cause);

      const receipt = await scenario.recover();
      expect(receipt.completed).toBe(true);
      expect(scenario.placementEffectCount()).toBe(1);
    },
  );

  test.each(DEPENDENCY_STAGES)(
    "preserves an uncancelled dependency rejection at %s",
    async (stage) => {
      const expected = new Error(`primary dependency failure at ${stage}`);
      const scenario = await failureScenario(stage, expected);

      const caught = await captureRejection(scenario.invoke());

      expect(scenario.observedCallerCancellation()).toBe(false);
      expect(caught).toBe(expected);

      const receipt = await scenario.recover();
      expect(receipt.completed).toBe(true);
      expect(scenario.placementEffectCount()).toBe(1);
    },
  );

  test("cleanup cannot replace a primary dependency rejection", async () => {
    const controller = new AbortController();
    const expected = new Error("primary dependency failure");
    const cleanupFailure = new Error("hostile cleanup failure");
    const originalRemove = EventTarget.prototype.removeEventListener;
    const delegate = publicationSink();
    const failingSink: AnnouncementSink = {
      medium: delegate.medium,
      profile: delegate.profile,
      capabilities: delegate.capabilities,
      prepare: async () => {
        EventTarget.prototype.removeEventListener = () => {
          throw cleanupFailure;
        };
        throw expected;
      },
      place: delegate.place.bind(delegate),
      reconcile: delegate.reconcile.bind(delegate),
    };

    try {
      const caught = await captureRejection(
        prepareAnnouncementPartitions(
          recordMembers(),
          "urn:jinn:publication-destination:cleanup-primary",
          failingSink,
          { signal: controller.signal },
        ),
      );
      expect(caught).toBe(expected);
    } finally {
      EventTarget.prototype.removeEventListener = originalRemove;
    }
  });
});

describe("trap-free rejected-value classification", () => {
  test("maps a cancelled Proxy rejection without invoking its prototype trap", async () => {
    const controller = new AbortController();
    const trapFailure = new Error("prototype trap must not run");
    let trapCalls = 0;
    const rejection = new Proxy(new Error("proxied rejection"), {
      getPrototypeOf: () => {
        trapCalls += 1;
        throw trapFailure;
      },
    });
    const scenario = await failureScenario(
      "sink-prepare",
      rejection,
      controller,
    );

    const caught = await captureRejection(scenario.invoke());

    expect(trapCalls).toBe(0);
    expect(
      caught instanceof EvidencePublicationError &&
      caught.code === "OPERATION_ABORTED",
    ).toBe(true);
  });

  test("preserves an uncancelled Proxy journal rejection without invoking its prototype trap", async () => {
    const trapFailure = new Error("prototype trap must not run");
    let trapCalls = 0;
    const rejection = new Proxy(new Error("proxied journal rejection"), {
      getPrototypeOf: () => {
        trapCalls += 1;
        throw trapFailure;
      },
    });
    const scenario = await failureScenario("journal-create", rejection);

    const caught = await captureRejection(scenario.invoke());

    expect(trapCalls).toBe(0);
    expect(Object.is(caught, rejection)).toBe(true);
  });

  test("stops before a Proxy in an ordinary error prototype chain", async () => {
    const controller = new AbortController();
    const trapFailure = new Error("prototype trap must not run");
    let trapCalls = 0;
    const proxiedPrototype = new Proxy(
      Object.create(EvidenceRepositoryError.prototype) as object,
      {
        getPrototypeOf: () => {
          trapCalls += 1;
          throw trapFailure;
        },
      },
    );
    const rejection = new Error("ordinary error with proxied prototype");
    Object.setPrototypeOf(rejection, proxiedPrototype);
    const scenario = await failureScenario(
      "sink-prepare",
      rejection,
      controller,
    );

    const caught = await captureRejection(scenario.invoke());

    expect(trapCalls).toBe(0);
    expect(
      caught instanceof EvidencePublicationError &&
      caught.code === "OPERATION_ABORTED",
    ).toBe(true);
  });

  test("does not classify the repository error prototype as an instance during cancellation", async () => {
    const controller = new AbortController();
    const rejection = EvidenceRepositoryError.prototype;
    const scenario = await failureScenario(
      "sink-prepare",
      rejection,
      controller,
    );

    const caught = await captureRejection(scenario.invoke());

    expect(
      caught instanceof EvidencePublicationError &&
      caught.code === "OPERATION_ABORTED",
    ).toBe(true);
  });

  test("preserves the uncancelled repository error prototype rejection", async () => {
    const rejection = EvidenceRepositoryError.prototype;
    const scenario = await failureScenario("sink-prepare", rejection);

    const caught = await captureRejection(scenario.invoke());

    expect(caught).toBe(rejection);
  });

  test("does not classify a repository-error subclass prototype during cancellation", async () => {
    const controller = new AbortController();
    const rejection = RepositoryErrorSubclass.prototype;
    const scenario = await failureScenario(
      "sink-prepare",
      rejection,
      controller,
    );

    const caught = await captureRejection(scenario.invoke());

    expect(caught).not.toBe(rejection);
    expect(
      caught instanceof EvidencePublicationError &&
      caught.code === "OPERATION_ABORTED",
    ).toBe(true);
  });

  test("preserves an uncancelled repository-error subclass prototype rejection", async () => {
    const rejection = RepositoryErrorSubclass.prototype;
    const scenario = await failureScenario("sink-prepare", rejection);

    const caught = await captureRejection(scenario.invoke());

    expect(caught).toBe(rejection);
  });

  test("maps a cancelled revoked Proxy rejection without observing it", async () => {
    const controller = new AbortController();
    const revocable = Proxy.revocable(
      new Error("revoked rejection"),
      {},
    );
    revocable.revoke();
    const scenario = await failureScenario(
      "sink-prepare",
      revocable.proxy,
      controller,
    );

    const caught = await captureRejection(scenario.invoke());

    expect(
      caught instanceof EvidencePublicationError &&
      caught.code === "OPERATION_ABORTED",
    ).toBe(true);
  });

  test("preserves an uncancelled revoked Proxy journal rejection", async () => {
    const revocable = Proxy.revocable(
      new Error("revoked journal rejection"),
      {},
    );
    revocable.revoke();
    const scenario = await failureScenario(
      "journal-create",
      revocable.proxy,
    );

    const observed = await scenario.invoke().then(
      () => {
        throw new Error("Expected the operation to reject.");
      },
      (reason: unknown) => ({ reason }),
    );

    expect(Object.is(observed.reason, revocable.proxy)).toBe(true);
  });

  test("preserves an ordinary repository-error subclass during cancellation", async () => {
    const controller = new AbortController();
    const cause = new Error("repository subclass cause");
    const rejection = new RepositoryErrorSubclass(
      "DEPENDENCY_UNAVAILABLE",
      "repository subclass rejection",
      { cause },
    );
    const scenario = await failureScenario(
      "sink-prepare",
      rejection,
      controller,
    );

    const caught = await captureRejection(scenario.invoke());

    expect(caught).toBe(rejection);
    expect(caught).toBeInstanceOf(RepositoryErrorSubclass);
    expect((caught as RepositoryErrorSubclass).code).toBe(
      "DEPENDENCY_UNAVAILABLE",
    );
    expect((caught as RepositoryErrorSubclass).cause).toBe(cause);
  });

  test("publish converges on an ordinary journal-conflict subclass", async () => {
    const repository = new InMemoryEvidenceRepository();
    const journalDelegate = new InMemoryPublicationJournalStore();
    const sink = publicationSink();
    let conflict = true;
    const journal: PublicationJournalStore = {
      load: journalDelegate.load.bind(journalDelegate),
      create: async (entry, options) => {
        const created = await journalDelegate.create(entry, options);
        if (conflict) {
          conflict = false;
          throw new JournalConflictSubclass(
            "JOURNAL_CONFLICT",
            "fixture concurrent creation",
          );
        }
        return created;
      },
      compareAndSwap: journalDelegate.compareAndSwap.bind(journalDelegate),
    };

    const receipt = await publish(
      publicationInput(),
      { repository, journal, sink },
    );

    expect(receipt.completed).toBe(true);
    expect(sink.placementEffectCount).toBe(1);
  });

  test.each([
    [
      "base",
      EvidencePublicationError.prototype,
    ],
    [
      "subclass",
      JournalConflictSubclass.prototype,
    ],
  ])(
    "does not classify a publication-error %s prototype as a journal conflict",
    async (_kind, rejection) => {
      Object.defineProperty(rejection, "code", {
        configurable: true,
        value: "JOURNAL_CONFLICT",
      });
      const repository = new InMemoryEvidenceRepository();
      const journalDelegate = new InMemoryPublicationJournalStore();
      const sink = publicationSink();
      const journal: PublicationJournalStore = {
        load: journalDelegate.load.bind(journalDelegate),
        create: async (entry, options) => {
          await journalDelegate.create(entry, options);
          throw rejection;
        },
        compareAndSwap: journalDelegate.compareAndSwap.bind(journalDelegate),
      };

      try {
        const caught = await captureRejection(
          publish(
            publicationInput(),
            { repository, journal, sink },
          ),
        );

        expect(caught).toBe(rejection);
        expect(sink.placementEffectCount).toBe(0);
      } finally {
        Reflect.deleteProperty(rejection, "code");
      }
    },
  );

  test("does not invoke an accessor-backed journal conflict code", async () => {
    let getterCalls = 0;
    const rejection = new JournalConflictSubclass(
      "JOURNAL_CONFLICT",
      "accessor-backed conflict",
    );
    Object.defineProperty(rejection, "code", {
      configurable: true,
      get: () => {
        getterCalls += 1;
        throw new Error("code accessor must not run");
      },
    });
    const repository = new InMemoryEvidenceRepository();
    const journalDelegate = new InMemoryPublicationJournalStore();
    const sink = publicationSink();
    const journal: PublicationJournalStore = {
      load: journalDelegate.load.bind(journalDelegate),
      create: async (entry, options) => {
        await journalDelegate.create(entry, options);
        throw rejection;
      },
      compareAndSwap: journalDelegate.compareAndSwap.bind(journalDelegate),
    };

    const caught = await captureRejection(
      publish(
        publicationInput(),
        { repository, journal, sink },
      ),
    );

    expect(getterCalls).toBe(0);
    expect(caught).toBe(rejection);
    expect(sink.placementEffectCount).toBe(0);
  });

  test("wraps a Proxy thrown during prepared-frame validation without observing it", async () => {
    let validationTrapCalls = 0;
    let causeTrapCalls = 0;
    const secondary = new Error("cause prototype trap must not run");
    const cause = new Proxy(new Error("prepared validation rejection"), {
      getPrototypeOf: () => {
        causeTrapCalls += 1;
        throw secondary;
      },
    });
    const framePrototype = new Proxy({}, {
      getPrototypeOf: () => {
        validationTrapCalls += 1;
        throw cause;
      },
    });
    const frameBytes = Object.create(framePrototype) as unknown as Uint8Array;
    const delegate = publicationSink();
    const sink: AnnouncementSink = {
      medium: delegate.medium,
      profile: delegate.profile,
      capabilities: delegate.capabilities,
      prepare: async (members, context, options) => ({
        ...(await delegate.prepare(members, context, options)),
        frameBytes,
      }),
      place: delegate.place.bind(delegate),
      reconcile: delegate.reconcile.bind(delegate),
    };

    const caught = await captureRejection(
      prepareAnnouncementPartitions(
        recordMembers(),
        "urn:jinn:publication-destination:prepared-frame-proxy",
        sink,
      ),
    );

    expect(validationTrapCalls).toBe(1);
    expect(causeTrapCalls).toBe(0);
    expect(
      caught instanceof EvidencePublicationError &&
      caught.code === "SINK_PROTOCOL_VIOLATION"
    ).toBe(true);
    expect((caught as Error).cause).toBe(cause);
  });

  test("reconcile preserves an uncancelled Proxy CAS rejection without invoking its prototype trap", async () => {
    const pending = await pendingPublication();
    const trapFailure = new Error("prototype trap must not run");
    let trapCalls = 0;
    let reject = true;
    const rejection = new Proxy(new Error("proxied CAS rejection"), {
      getPrototypeOf: () => {
        trapCalls += 1;
        throw trapFailure;
      },
    });
    const journal: PublicationJournalStore = {
      load: pending.journal.load.bind(pending.journal),
      create: pending.journal.create.bind(pending.journal),
      compareAndSwap: async (expected, next, options) => {
        const stored = await pending.journal.compareAndSwap(
          expected,
          next,
          options,
        );
        if (reject) {
          reject = false;
          throw rejection;
        }
        return stored;
      },
    };

    const caught = await captureRejection(
      reconcile(pending.bundleKey, {
        repository: pending.repository,
        journal,
        sink: pending.sink,
      }),
    );

    expect(trapCalls).toBe(0);
    expect(Object.is(caught, rejection)).toBe(true);
    const receipt = await reconcile(pending.bundleKey, {
      repository: pending.repository,
      journal: pending.journal,
      sink: pending.sink,
    });
    expect(receipt.completed).toBe(true);
    expect(pending.sink.placementEffectCount).toBe(1);
  });

  test("reconcile converges on an ordinary journal-conflict subclass", async () => {
    const pending = await pendingPublication();
    let conflict = true;
    const journal: PublicationJournalStore = {
      load: pending.journal.load.bind(pending.journal),
      create: pending.journal.create.bind(pending.journal),
      compareAndSwap: async (expected, next, options) => {
        const stored = await pending.journal.compareAndSwap(
          expected,
          next,
          options,
        );
        if (conflict) {
          conflict = false;
          throw new JournalConflictSubclass(
            "JOURNAL_CONFLICT",
            "fixture concurrent checkpoint",
          );
        }
        return stored;
      },
    };

    const receipt = await reconcile(pending.bundleKey, {
      repository: pending.repository,
      journal,
      sink: pending.sink,
    });

    expect(receipt.completed).toBe(true);
    expect(pending.sink.placementEffectCount).toBe(1);
  });
});

describe("public wrapper final cancellation", () => {
  test("partition rejects cancellation queued after its inner result", async () => {
    const controller = new AbortController();
    const members = recordMembers();
    const destination =
      "urn:jinn:publication-destination:partition-final-cancellation";
    const delegate = publicationSink();
    const prepared = await delegate.prepare(members, {
      destination,
      partitionOrdinal: 0,
    });
    const lateAbortSink: AnnouncementSink = {
      medium: delegate.medium,
      profile: delegate.profile,
      capabilities: delegate.capabilities,
      prepare: () => resolvedThenAbort(prepared, controller),
      place: delegate.place.bind(delegate),
      reconcile: delegate.reconcile.bind(delegate),
    };

    await expect(
      prepareAnnouncementPartitions(
        members,
        destination,
        lateAbortSink,
        { signal: controller.signal },
      ),
    ).rejects.toMatchObject({ code: "OPERATION_ABORTED" });
  });

  test("publish rejects cancellation queued after its final checkpoint", async () => {
    const controller = new AbortController();
    const repository = new InMemoryEvidenceRepository();
    const journalDelegate = new InMemoryPublicationJournalStore();
    const sink = publicationSink();
    const lateAbortJournal: PublicationJournalStore = {
      load: journalDelegate.load.bind(journalDelegate),
      create: journalDelegate.create.bind(journalDelegate),
      compareAndSwap: async (expected, next, options) => {
        const result = await journalDelegate.compareAndSwap(
          expected,
          next,
          options,
        );
        return next.completed
          ? resolvedThenAbort(result, controller)
          : result;
      },
    };

    await expect(
      publish(
        publicationInput(controller.signal),
        { repository, journal: lateAbortJournal, sink },
      ),
    ).rejects.toMatchObject({ code: "OPERATION_ABORTED" });

    const receipt = await publish(publicationInput(), {
      repository,
      journal: journalDelegate,
      sink,
    });
    expect(receipt.completed).toBe(true);
    expect(sink.placementEffectCount).toBe(1);
  });

  test("reconcile rejects cancellation queued after its final checkpoint", async () => {
    const controller = new AbortController();
    const repository = new InMemoryEvidenceRepository();
    const journalDelegate = new InMemoryPublicationJournalStore();
    const sink = publicationSink();
    let losePlacementResponse = true;
    const uncertainSink: AnnouncementSink = {
      medium: sink.medium,
      profile: sink.profile,
      capabilities: sink.capabilities,
      prepare: sink.prepare.bind(sink),
      place: async (prepared, idempotencyKey, options) => {
        const result = await sink.place(
          prepared,
          idempotencyKey,
          options,
        );
        if (losePlacementResponse) {
          losePlacementResponse = false;
          throw new EvidencePublicationError(
            "PLACEMENT_UNCERTAIN",
            "The fixture discarded the first placement response.",
          );
        }
        return result;
      },
      reconcile: sink.reconcile.bind(sink),
    };
    const initialInput = publicationInput();
    const normalized = normalizePublishInput(initialInput);
    await expect(
      publish(initialInput, {
        repository,
        journal: journalDelegate,
        sink: uncertainSink,
      }),
    ).rejects.toMatchObject({ code: "PLACEMENT_UNCERTAIN" });

    const lateAbortJournal: PublicationJournalStore = {
      load: journalDelegate.load.bind(journalDelegate),
      create: journalDelegate.create.bind(journalDelegate),
      compareAndSwap: async (expected, next, options) => {
        const result = await journalDelegate.compareAndSwap(
          expected,
          next,
          options,
        );
        return next.completed
          ? resolvedThenAbort(result, controller)
          : result;
      },
    };

    await expect(
      reconcile(
        normalized.bundleKey,
        { repository, journal: lateAbortJournal, sink },
        { signal: controller.signal },
      ),
    ).rejects.toMatchObject({ code: "OPERATION_ABORTED" });

    const receipt = await reconcile(normalized.bundleKey, {
      repository,
      journal: journalDelegate,
      sink,
    });
    expect(receipt.completed).toBe(true);
    expect(sink.placementEffectCount).toBe(1);
  });
});
