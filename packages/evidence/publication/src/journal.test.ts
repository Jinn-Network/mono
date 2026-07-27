// SPDX-License-Identifier: Apache-2.0
import {
  createArtifactReference,
  createRecordReference,
  type Sha256Digest,
} from "@jinn-network/evidence-repository";
import { describe, expect, test } from "vitest";

import {
  derivePublicationIdentities,
  hashExactBytes,
} from "./identities.js";
import {
  decodeVersionedPublicationJournalEntry,
  encodeVersionedPublicationJournalEntry,
  measureVersionedPublicationJournalEntryBytes,
  validateJournalTransition,
} from "./journal.js";
import { InMemoryPublicationJournalStore } from "./testing.js";
import type {
  PublicationJournalEntry,
  VersionedPublicationJournalEntry,
} from "./types.js";

function initialEntry(): PublicationJournalEntry {
  const destination = "urn:jinn:publication-destination:journal-test";
  const artifacts = [
    createArtifactReference(new Uint8Array([1])),
  ];
  const records = [
    createRecordReference("execution-evidence", new Uint8Array([2])),
  ];
  const identities = derivePublicationIdentities(
    records,
    artifacts,
    destination,
  );
  return {
    schemaVersion: 1,
    ...identities,
    destination,
    repositoryCapabilities: {},
    artifacts,
    records,
    storedArtifacts: [],
    storedRecords: [],
    completed: false,
  };
}

function storedEntry(): PublicationJournalEntry {
  const initial = initialEntry();
  return {
    ...initial,
    storedArtifacts: [{
      reference: initial.artifacts[0]!,
      size: 1,
    }],
    storedRecords: [{
      reference: initial.records[0]!,
      size: 1,
    }],
  };
}

function plannedEntry(): PublicationJournalEntry {
  const stored = storedEntry();
  const frameBytes = new Uint8Array([7, 8, 9]);
  return {
    ...stored,
    preparedPartitions: [{
      ordinal: 0,
      prepared: {
        medium: "https://publication.test/medium",
        profile: "https://publication.test/profiles/v1",
        members: [{ reference: stored.records[0]! }],
        frameBytes,
        frameDigest:
          "sha256:66a6757151f8ee55db127716c7e3dce0be8074b64e20eda542e5c1e46ca9c41e",
        frameSize: 3,
      },
      placement: { status: "unplaced" },
    }],
  } as unknown as PublicationJournalEntry;
}

describe("publication journal codecs and transitions", () => {
  test("round-trips exact prepared and opaque sink bytes", () => {
    const planned = plannedEntry();
    const versioned: VersionedPublicationJournalEntry = {
      ...planned,
      preparedPartitions: [{
        ...planned.preparedPartitions![0]!,
        placement: {
          status: "pending",
          pending: {
            idempotencyKey:
              "sha256:3333333333333333333333333333333333333333333333333333333333333333",
            frameDigest:
              planned.preparedPartitions![0]!.prepared.frameDigest,
            state: {
              format: "https://publication.test/state/\"/é😀/v1",
              bytes: new Uint8Array([0, 255, 1]),
            },
          },
        },
      }],
      revision: 3,
    };

    const decoded = decodeVersionedPublicationJournalEntry(
      encodeVersionedPublicationJournalEntry(versioned),
    );
    expect(decoded).toEqual(versioned);
    expect(
      (decoded.preparedPartitions?.[0]?.prepared as unknown as {
        readonly medium?: string;
      }).medium,
    ).toBe("https://publication.test/medium");
    expect(
      measureVersionedPublicationJournalEntryBytes(
        versioned,
        Number.MAX_SAFE_INTEGER - 1,
      ),
    ).toBe(encodeVersionedPublicationJournalEntry(versioned).byteLength);
  });

  test("snapshots prepared frame bytes without consulting caller metadata", () => {
    const planned = plannedEntry();
    for (const shadowedLength of [0, 1, 10]) {
      const frameBytes = new Uint8Array([7, 8, 9]);
      let metadataReads = 0;
      Object.defineProperty(frameBytes, "length", {
        configurable: true,
        value: shadowedLength,
      });
      Object.defineProperty(frameBytes, "byteLength", {
        configurable: true,
        get: () => {
          metadataReads += 1;
          throw new RangeError("hostile byteLength");
        },
      });
      Object.defineProperty(frameBytes, Symbol.iterator, {
        configurable: true,
        get: () => {
          metadataReads += 1;
          throw new RangeError("hostile iterator");
        },
      });
      const versioned: VersionedPublicationJournalEntry = {
        ...planned,
        preparedPartitions: [{
          ...planned.preparedPartitions![0]!,
          prepared: {
            ...planned.preparedPartitions![0]!.prepared,
            frameBytes,
          },
        }],
        revision: 2,
      };

      const decoded = decodeVersionedPublicationJournalEntry(
        encodeVersionedPublicationJournalEntry(versioned),
      );

      expect(
        decoded.preparedPartitions?.[0]?.prepared.frameBytes,
        `shadowed length ${shadowedLength}`,
      ).toEqual(new Uint8Array([7, 8, 9]));
      expect(metadataReads).toBe(0);
    }
  });

  test("snapshots opaque sink state without consulting caller metadata", () => {
    const planned = plannedEntry();
    for (const shadowedLength of [0, 1, 10]) {
      const stateBytes = new Uint8Array([0, 255, 1]);
      let metadataReads = 0;
      Object.defineProperty(stateBytes, "length", {
        configurable: true,
        value: shadowedLength,
      });
      Object.defineProperty(stateBytes, "byteLength", {
        configurable: true,
        get: () => {
          metadataReads += 1;
          throw new RangeError("hostile byteLength");
        },
      });
      Object.defineProperty(stateBytes, Symbol.iterator, {
        configurable: true,
        get: () => {
          metadataReads += 1;
          throw new RangeError("hostile iterator");
        },
      });
      const versioned: VersionedPublicationJournalEntry = {
        ...planned,
        preparedPartitions: [{
          ...planned.preparedPartitions![0]!,
          placement: {
            status: "pending",
            pending: {
              idempotencyKey:
                "sha256:3333333333333333333333333333333333333333333333333333333333333333",
              frameDigest:
                planned.preparedPartitions![0]!.prepared.frameDigest,
              state: {
                format: "https://publication.test/state/v1",
                bytes: stateBytes,
              },
            },
          },
        }],
        revision: 3,
      };

      const decoded = decodeVersionedPublicationJournalEntry(
        encodeVersionedPublicationJournalEntry(versioned),
      );

      const placement = decoded.preparedPartitions?.[0]?.placement;
      expect(placement?.status).toBe("pending");
      if (placement?.status !== "pending") {
        throw new Error("Expected pending placement.");
      }
      expect(
        placement.pending.state?.bytes,
        `shadowed length ${shadowedLength}`,
      ).toEqual(new Uint8Array([0, 255, 1]));
      expect(metadataReads).toBe(0);
    }
  });

  test("maps detached and proxied journal byte fields to typed corruption errors", () => {
    const planned = plannedEntry();
    for (const target of ["frame", "state"] as const) {
      const detached = new Uint8Array([7, 8, 9]);
      structuredClone(detached.buffer, { transfer: [detached.buffer] });
      const invalidValues: readonly Uint8Array[] = [
        detached,
        new Proxy(new Uint8Array([7, 8, 9]), {}),
      ];
      for (const bytes of invalidValues) {
        const versioned: VersionedPublicationJournalEntry = {
          ...planned,
          preparedPartitions: [{
            ...planned.preparedPartitions![0]!,
            ...(target === "frame"
              ? {
                  prepared: {
                    ...planned.preparedPartitions![0]!.prepared,
                    frameBytes: bytes,
                  },
                }
              : {
                  placement: {
                    status: "pending" as const,
                    pending: {
                      idempotencyKey:
                        "sha256:3333333333333333333333333333333333333333333333333333333333333333" as const,
                      frameDigest:
                        planned.preparedPartitions![0]!.prepared.frameDigest,
                      state: {
                        format: "https://publication.test/state/v1",
                        bytes,
                      },
                    },
                  },
                }),
          }],
          revision: 3,
        };

        expect(
          () => encodeVersionedPublicationJournalEntry(versioned),
          target,
        ).toThrowError(expect.objectContaining({ code: "JOURNAL_CORRUPT" }));
      }
    }
  });

  test("rejects unknown schema versions and malformed base64", () => {
    const encoded = JSON.parse(
      new TextDecoder().decode(
        encodeVersionedPublicationJournalEntry({
          ...initialEntry(),
          revision: 0,
        }),
      ),
    ) as Record<string, unknown>;

    expect(() =>
      decodeVersionedPublicationJournalEntry(
        new TextEncoder().encode(JSON.stringify({
          ...encoded,
          schemaVersion: 2,
        })),
      )
    ).toThrowError(expect.objectContaining({ code: "JOURNAL_CORRUPT" }));

    const planned = plannedEntry();
    const withFrame = JSON.parse(
      new TextDecoder().decode(
        encodeVersionedPublicationJournalEntry({
          ...planned,
          revision: 2,
        }),
      ),
    ) as {
      preparedPartitions: Array<{
        prepared: { frameBytes: string };
      }>;
    };
    withFrame.preparedPartitions[0]!.prepared.frameBytes = "***";
    expect(() =>
      decodeVersionedPublicationJournalEntry(
        new TextEncoder().encode(JSON.stringify(withFrame)),
      )
    ).toThrowError(expect.objectContaining({ code: "JOURNAL_CORRUPT" }));
  });

  test("rejects a non-positive journaled repository capability", () => {
    const encoded = JSON.parse(
      new TextDecoder().decode(
        encodeVersionedPublicationJournalEntry({
          ...initialEntry(),
          revision: 0,
        }),
      ),
    ) as Record<string, unknown>;

    expect(() =>
      decodeVersionedPublicationJournalEntry(
        new TextEncoder().encode(JSON.stringify({
          ...encoded,
          repositoryCapabilities: { maxObjectBytes: 0 },
        })),
      )
    ).toThrowError(expect.objectContaining({ code: "JOURNAL_CORRUPT" }));
  });

  test("reports a self-inconsistent prepared frame as journal corruption", () => {
    const encoded = JSON.parse(
      new TextDecoder().decode(
        encodeVersionedPublicationJournalEntry({
          ...plannedEntry(),
          revision: 2,
        }),
      ),
    ) as {
      preparedPartitions: Array<{
        prepared: { frameSize: number };
      }>;
    };
    encoded.preparedPartitions[0]!.prepared.frameSize += 1;

    expect(() =>
      decodeVersionedPublicationJournalEntry(
        new TextEncoder().encode(JSON.stringify(encoded)),
      )
    ).toThrowError(expect.objectContaining({ code: "JOURNAL_CORRUPT" }));
  });

  test("rejects states that skip required predecessors", () => {
    const initial = initialEntry();
    const invalid: PublicationJournalEntry = {
      ...initial,
      storedRecords: [{
        reference: initial.records[0]!,
        size: 1,
      }],
    };

    expect(() =>
      validateJournalTransition(
        { ...initial, revision: 0 },
        invalid,
      )
    ).toThrowError(expect.objectContaining({ code: "JOURNAL_CORRUPT" }));
  });

  test("rejects create-time checkpoints, plans, and completion", async () => {
    const store = new InMemoryPublicationJournalStore();
    const initial = initialEntry();
    const planned = plannedEntry();
    const invalid = [
      {
        ...initial,
        storedArtifacts: [{
          reference: initial.artifacts[0]!,
          size: 1,
        }],
      },
      planned,
      {
        ...planned,
        preparedPartitions: planned.preparedPartitions!.map((partition) => ({
          ...partition,
          placement: {
            status: "pending" as const,
            pending: {
              idempotencyKey:
                "sha256:3333333333333333333333333333333333333333333333333333333333333333" as const,
              frameDigest: partition.prepared.frameDigest,
            },
          },
        })),
      },
      {
        ...planned,
        preparedPartitions: planned.preparedPartitions!.map((partition) => ({
          ...partition,
          placement: {
            status: "confirmed" as const,
            result: "placed" as const,
            placement: { externalId: "urn:jinn:placement:fixture" },
          },
        })),
        completed: true,
      },
    ];

    for (const entry of invalid) {
      await expect(store.create(entry)).rejects.toMatchObject({
        code: "JOURNAL_CORRUPT",
      });
    }
  });

  test("permits exactly one durable journal step per revision", () => {
    const initial = initialEntry();
    const artifact = validateJournalTransition(
      { ...initial, revision: 0 },
      {
        ...initial,
        storedArtifacts: [{
          reference: initial.artifacts[0]!,
          size: 1,
        }],
      },
    );
    const record = validateJournalTransition(
      { ...artifact, revision: 1 },
      {
        ...artifact,
        storedRecords: [{
          reference: artifact.records[0]!,
          size: 1,
        }],
      },
    );
    const planned = validateJournalTransition(
      { ...record, revision: 2 },
      plannedEntry(),
    );
    const partition = planned.preparedPartitions![0]!;
    const intent = validateJournalTransition(
      { ...planned, revision: 3 },
      {
        ...planned,
        preparedPartitions: [{
          ...partition,
          placement: {
            status: "pending",
            pending: {
              idempotencyKey:
                "sha256:3333333333333333333333333333333333333333333333333333333333333333",
              frameDigest: partition.prepared.frameDigest,
            },
          },
        }],
      },
    );
    const pending = validateJournalTransition(
      { ...intent, revision: 4 },
      {
        ...intent,
        preparedPartitions: [{
          ...intent.preparedPartitions![0]!,
          placement: {
            status: "pending",
            pending: {
              idempotencyKey:
                "sha256:3333333333333333333333333333333333333333333333333333333333333333",
              frameDigest: partition.prepared.frameDigest,
              state: {
                format: "https://publication.test/pending-state/v1",
                bytes: Uint8Array.of(1),
              },
            },
          },
        }],
      },
    );
    const confirmed = validateJournalTransition(
      { ...pending, revision: 5 },
      {
        ...pending,
        preparedPartitions: [{
          ...pending.preparedPartitions![0]!,
          placement: {
            status: "confirmed",
            result: "placed",
            placement: { externalId: "urn:jinn:placement:fixture" },
          },
        }],
      },
    );
    const completed = validateJournalTransition(
      { ...confirmed, revision: 6 },
      { ...confirmed, completed: true },
    );

    expect(completed.completed).toBe(true);
  });

  test("rejects skipped, combined, stateful-first, and no-op transitions", () => {
    const initial = initialEntry();
    const stored = storedEntry();
    const planned = plannedEntry();
    const partition = planned.preparedPartitions![0]!;
    const key =
      "sha256:3333333333333333333333333333333333333333333333333333333333333333" as const;
    const intent: PublicationJournalEntry = {
      ...planned,
      preparedPartitions: [{
        ...partition,
        placement: {
          status: "pending",
          pending: {
            idempotencyKey: key,
            frameDigest: partition.prepared.frameDigest,
          },
        },
      }],
    };
    const pending: PublicationJournalEntry = {
      ...planned,
      preparedPartitions: [{
        ...partition,
        placement: {
          status: "pending",
          pending: {
            idempotencyKey: key,
            frameDigest: partition.prepared.frameDigest,
            state: {
              format: "https://publication.test/pending-state/v1",
              bytes: Uint8Array.of(1),
            },
          },
        },
      }],
    };
    const confirmed: PublicationJournalEntry = {
      ...planned,
      preparedPartitions: [{
        ...partition,
        placement: {
          status: "confirmed",
          result: "placed",
          placement: { externalId: "urn:jinn:placement:fixture" },
        },
      }],
    };
    const cases: Array<[
      VersionedPublicationJournalEntry,
      PublicationJournalEntry,
    ]> = [
      [{ ...initial, revision: 0 }, initial],
      [{ ...initial, revision: 0 }, stored],
      [{ ...planned, revision: 3 }, pending],
      [{ ...planned, revision: 3 }, confirmed],
      [{ ...intent, revision: 4 }, intent],
      [{ ...intent, revision: 4 }, {
        ...pending,
        preparedPartitions: [{
          ...pending.preparedPartitions![0]!,
          placement: {
            status: "pending",
            pending: {
              idempotencyKey:
                "sha256:4444444444444444444444444444444444444444444444444444444444444444",
              frameDigest: partition.prepared.frameDigest,
              state: {
                format: "https://publication.test/pending-state/v1",
                bytes: Uint8Array.of(1),
              },
            },
          },
        }],
      }],
      [{ ...pending, revision: 5 }, {
        ...confirmed,
        completed: true,
      }],
    ];

    for (const [previous, next] of cases) {
      expect(() => validateJournalTransition(previous, next)).toThrowError(
        expect.objectContaining({ code: "JOURNAL_CORRUPT" }),
      );
    }
  });

  test("rejects one revision that changes two placement partitions", () => {
    const destination = "urn:jinn:publication-destination:two-partitions";
    const records = [
      createRecordReference("execution-evidence", Uint8Array.of(1)),
      createRecordReference("result-evaluation", Uint8Array.of(2)),
    ].sort((left, right) =>
      `${left.family}:${left.digest}`.localeCompare(
        `${right.family}:${right.digest}`,
      )
    );
    const partitions = records.map((reference, ordinal) => {
      const frameBytes = Uint8Array.of(ordinal + 1);
      return {
          ordinal,
          prepared: {
            medium: "https://publication.test/medium",
            profile: "https://publication.test/profile/v1",
          members: [{ reference }],
          frameBytes,
          frameDigest: hashExactBytes(frameBytes),
          frameSize: frameBytes.byteLength,
        },
        placement: { status: "unplaced" as const },
      };
    });
    const planned: PublicationJournalEntry = {
      schemaVersion: 1,
      ...derivePublicationIdentities(records, [], destination),
      destination,
      repositoryCapabilities: {},
      artifacts: [],
      records,
      storedArtifacts: [],
      storedRecords: records.map((reference) => ({ reference, size: 1 })),
      preparedPartitions: partitions,
      completed: false,
    };
    const next: PublicationJournalEntry = {
      ...planned,
      preparedPartitions: partitions.map((partition) => ({
        ...partition,
        placement: {
          status: "pending",
          pending: {
            idempotencyKey: hashExactBytes(
              Uint8Array.of(partition.ordinal),
            ),
            frameDigest: partition.prepared.frameDigest,
          },
        },
      })),
    };

    expect(() =>
      validateJournalTransition({ ...planned, revision: 4 }, next)
    ).toThrowError(expect.objectContaining({ code: "JOURNAL_CORRUPT" }));
  });

  test("enforces a confirmed prefix with at most one immediately pending partition", () => {
    const destination =
      "urn:jinn:publication-destination:placement-grammar";
    const records = [
      createRecordReference("execution-evidence", Uint8Array.of(1)),
      createRecordReference("result-evaluation", Uint8Array.of(2)),
    ].sort((left, right) =>
      `${left.family}:${left.digest}`.localeCompare(
        `${right.family}:${right.digest}`,
      )
    );
    const partitions = records.map((reference, ordinal) => {
      const frameBytes = Uint8Array.of(ordinal + 1);
      return {
          ordinal,
          prepared: {
            medium: "https://publication.test/medium",
            profile: "https://publication.test/profile/v1",
          members: [{ reference }],
          frameBytes,
          frameDigest: hashExactBytes(frameBytes),
          frameSize: frameBytes.byteLength,
        },
        placement: { status: "unplaced" as const },
      };
    });
    const planned: PublicationJournalEntry = {
      schemaVersion: 1,
      ...derivePublicationIdentities(records, [], destination),
      destination,
      repositoryCapabilities: {},
      artifacts: [],
      records,
      storedArtifacts: [],
      storedRecords: records.map((reference) => ({ reference, size: 1 })),
      preparedPartitions: partitions,
      completed: false,
    };
    const pending = (ordinal: number) => ({
      status: "pending" as const,
      pending: {
        idempotencyKey: hashExactBytes(Uint8Array.of(ordinal + 20)),
        frameDigest: partitions[ordinal]!.prepared.frameDigest,
      },
    });
    const confirmed = {
      status: "confirmed" as const,
      result: "placed" as const,
      placement: { externalId: "urn:jinn:placement:grammar" },
    };
    const invalidStates: PublicationJournalEntry[] = [
      {
        ...planned,
        preparedPartitions: [
          partitions[0]!,
          { ...partitions[1]!, placement: pending(1) },
        ],
      },
      {
        ...planned,
        preparedPartitions: [
          { ...partitions[0]!, placement: pending(0) },
          { ...partitions[1]!, placement: pending(1) },
        ],
      },
    ];

    for (const invalid of invalidStates) {
      expect(() =>
        encodeVersionedPublicationJournalEntry({
          ...invalid,
          revision: 4,
        })
      ).toThrowError(expect.objectContaining({ code: "JOURNAL_CORRUPT" }));
    }
    expect(() =>
      encodeVersionedPublicationJournalEntry({
        ...planned,
        preparedPartitions: [
          { ...partitions[0]!, placement: confirmed },
          { ...partitions[1]!, placement: pending(1) },
        ],
        revision: 5,
      })
    ).not.toThrow();

    expect(() =>
      validateJournalTransition(
        { ...planned, revision: 4 },
        invalidStates[0]!,
      )
    ).toThrowError(expect.objectContaining({ code: "JOURNAL_CORRUPT" }));
  });

  test("rejects self-consistent identity tampering during decode", () => {
    const initial = initialEntry();
    const encoded = JSON.parse(
      new TextDecoder().decode(
        encodeVersionedPublicationJournalEntry({
          ...initial,
          revision: 0,
        }),
      ),
    ) as Record<string, unknown>;

    for (const field of ["bundleKey", "payloadFingerprint"] as const) {
      expect(() =>
        decodeVersionedPublicationJournalEntry(
          new TextEncoder().encode(JSON.stringify({
            ...encoded,
            [field]: hashExactBytes(Uint8Array.of(field.length)),
          })),
        )
      ).toThrowError(expect.objectContaining({ code: "JOURNAL_CORRUPT" }));
    }
  });

  test("rejects changed immutable identity and non-prefix checkpoints", () => {
    const initial = initialEntry();
    const secondArtifact = createArtifactReference(new Uint8Array([3]));
    const previous: VersionedPublicationJournalEntry = {
      ...initial,
      artifacts: [...initial.artifacts, secondArtifact].sort((left, right) =>
        left.digest.localeCompare(right.digest)
      ),
      revision: 0,
    };
    const withRevision = {
      ...previous,
      storedArtifacts: [{ reference: previous.artifacts[1]!, size: 1 }],
    };
    const { revision: _revision, ...skipped } = withRevision;

    expect(() =>
      validateJournalTransition(previous, skipped)
    ).toThrowError(expect.objectContaining({ code: "JOURNAL_CORRUPT" }));
    expect(() =>
      validateJournalTransition(previous, {
        ...initial,
        destination: "urn:jinn:publication-destination:changed",
      })
    ).toThrowError(expect.objectContaining({ code: "JOURNAL_CORRUPT" }));
  });

  test("accepts one monotonic durable transition at a time", async () => {
    const store = new InMemoryPublicationJournalStore();
    const created = await store.create(initialEntry());
    expect(created.revision).toBe(0);

    const stored = await store.compareAndSwap(created, {
      ...created,
      storedArtifacts: [{
        reference: created.artifacts[0]!,
        size: 1,
      }],
    });
    expect(stored.revision).toBe(1);

    await expect(
      store.compareAndSwap(created, initialEntry()),
    ).rejects.toMatchObject({ code: "JOURNAL_CONFLICT" });
  });

  test("defensively snapshots stored entries", async () => {
    const store = new InMemoryPublicationJournalStore();
    const input = initialEntry();
    const created = await store.create(input);
    (input.artifacts as Array<{ digest: Sha256Digest }>)[0]!.digest =
      "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";

    expect((await store.load(created.bundleKey))?.artifacts[0]).toEqual(
      created.artifacts[0],
    );
    const loaded = await store.load(created.bundleKey);
    (loaded!.artifacts as Array<{ digest: Sha256Digest }>)[0]!.digest =
      "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
    expect((await store.load(created.bundleKey))?.artifacts[0]).toEqual(
      created.artifacts[0],
    );
  });
});
