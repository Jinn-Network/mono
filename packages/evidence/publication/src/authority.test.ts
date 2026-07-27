// SPDX-License-Identifier: Apache-2.0
import { runInNewContext } from "node:vm";

import { describe, expect, test } from "vitest";
import {
  createArtifactReference,
  createRecordReference,
  type EvidenceRepository,
  type RepositoryOperationOptions,
  type Sha256Digest,
} from "@jinn-network/evidence-repository";
import {
  InMemoryEvidenceRepository,
} from "@jinn-network/evidence-repository/testing";

import {
  assertNoAuthorityMarkerLeaks,
  validateAuthorityMarkers,
} from "./authority.js";
import {
  encodeVersionedPublicationJournalEntry,
} from "./journal.js";
import { EvidencePublicationError } from "./errors.js";
import { publish } from "./publish.js";
import {
  InMemoryAnnouncementSink,
  InMemoryPublicationJournalStore,
} from "./testing.js";
import type {
  AnnouncementSink,
  PublicationJournalStore,
  PublishInput,
} from "./types.js";

const encoder = new TextEncoder();
const printable = encoder.encode(
  "printable-publication-authority-marker-0001",
);
const binary = Uint8Array.from([
  0xff, 0xfe, 0x80, 0x00, 0x01, 0x02, 0x03, 0x04,
  0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c,
  0x0d, 0x0e, 0x0f, 0x10, 0x11, 0x12, 0x13, 0x14,
  0x15, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x1b, 0x1c,
]);

type FaultPhase = "before" | "after";
type FaultOperation =
  | "journal.create"
  | "journal.compareAndSwap"
  | "repository.putArtifact"
  | "repository.putRecord"
  | "sink.prepare"
  | "sink.place"
  | "sink.reconcile";

interface FaultBoundary {
  readonly operation: FaultOperation;
  readonly occurrence: number;
  readonly phase: FaultPhase;
}

class AuthorityFault {
  readonly #counts = new Map<FaultOperation, number>();
  readonly #markers: readonly Uint8Array[];
  readonly boundary: FaultBoundary;
  triggered = false;

  constructor(
    boundary: FaultBoundary,
    markers: readonly Uint8Array[],
  ) {
    this.boundary = boundary;
    this.#markers = markers;
  }

  async around<T>(
    operation: FaultOperation,
    effect: () => Promise<T>,
  ): Promise<T> {
    const occurrence = (this.#counts.get(operation) ?? 0) + 1;
    this.#counts.set(operation, occurrence);
    if (
      this.boundary.operation === operation &&
      this.boundary.occurrence === occurrence &&
      this.boundary.phase === "before"
    ) {
      this.#interrupt();
    }
    const result = await effect();
    if (
      this.boundary.operation === operation &&
      this.boundary.occurrence === occurrence &&
      this.boundary.phase === "after"
    ) {
      this.#interrupt();
    }
    return result;
  }

  #interrupt(): never {
    this.triggered = true;
    // The tested authority remains closed over and is never serialized.
    void this.#markers[0]?.byteLength;
    void this.#markers[1]?.byteLength;
    throw new EvidencePublicationError(
      "OPERATION_ABORTED",
      `Synthetic publication fault at ${this.boundary.operation} ` +
        `${this.boundary.phase} ${this.boundary.occurrence}.`,
    );
  }
}

function authorityFaultInput(): PublishInput {
  const artifactBytes = Uint8Array.of(2);
  const recordBytes = Uint8Array.of(1);
  return {
    artifacts: [{
      reference: createArtifactReference(artifactBytes),
      bytes: artifactBytes,
    }],
    records: [{
      reference: createRecordReference("execution-evidence", recordBytes),
      bytes: recordBytes,
    }],
    destination: "urn:jinn:publication-destination:authority-fault-matrix",
  };
}

describe("authority-marker conformance scanner", () => {
  test("rejects raw and canonical encoded markers in nested values and causes", () => {
    const markers = validateAuthorityMarkers([printable, binary]);
    const representations = [
      new TextDecoder().decode(printable),
      Buffer.from(printable).toString("hex"),
      Buffer.from(printable).toString("base64"),
      Buffer.from(printable).toString("base64url"),
      [...printable].map((byte) =>
        `%${byte.toString(16).padStart(2, "0").toUpperCase()}`
      ).join(""),
    ];
    for (const leaked of representations) {
      expect(() =>
        assertNoAuthorityMarkerLeaks(markers, [{
          nested: new Error("outer", {
            cause: { leaked },
          }),
        }])
      ).toThrowError(/authority marker/u);
    }
    expect(() =>
      assertNoAuthorityMarkerLeaks(markers, [{
        output: Uint8Array.from([7, ...binary, 8]),
      }])
    ).toThrowError(/authority marker/u);
  });

  test("is cycle-safe and does not evaluate accessor extensions", () => {
    const markers = validateAuthorityMarkers([printable, binary]);
    let getterCalls = 0;
    const value: Record<string, unknown> = { status: "not-found" };
    value.cycle = value;
    Object.defineProperty(value, "futureExtension", {
      get: () => {
        getterCalls += 1;
        return new TextDecoder().decode(printable);
      },
    });

    expect(() => assertNoAuthorityMarkerLeaks(markers, [value])).not.toThrow();
    expect(getterCalls).toBe(0);
  });

  test("detects marker bytes through ArrayBuffer, DataView, and non-byte typed views", () => {
    const markers = validateAuthorityMarkers([printable, binary]);
    const buffer = new ArrayBuffer(binary.byteLength + 4);
    new Uint8Array(buffer, 2, binary.byteLength).set(binary);
    const values = [
      buffer,
      new DataView(buffer, 2, binary.byteLength),
      new Uint16Array(buffer, 2, binary.byteLength / 2),
    ];

    for (const value of values) {
      expect(() =>
        assertNoAuthorityMarkerLeaks(markers, [{ nested: value }])
      ).toThrowError(/authority marker/u);
    }
  });

  test("detects marker bytes in raw cross-realm ArrayBuffer values", () => {
    const markers = validateAuthorityMarkers([printable, binary]);
    const foreignBuffer = runInNewContext(
      "Uint8Array.from(bytes).buffer",
      { bytes: [...binary] },
    ) as ArrayBuffer;

    expect(foreignBuffer instanceof ArrayBuffer).toBe(false);
    expect(ArrayBuffer.isView(foreignBuffer)).toBe(false);
    expect(() =>
      assertNoAuthorityMarkerLeaks(markers, [{ nested: foreignBuffer }])
    ).toThrowError(/authority marker/u);
  });

  test("detects marker bytes in raw cross-realm SharedArrayBuffer values", () => {
    const markers = validateAuthorityMarkers([printable, binary]);
    const foreignBuffer = runInNewContext(
      `
        const buffer = new SharedArrayBuffer(bytes.length);
        new Uint8Array(buffer).set(bytes);
        buffer;
      `,
      { bytes: [...printable] },
    ) as SharedArrayBuffer;

    expect(foreignBuffer instanceof SharedArrayBuffer).toBe(false);
    expect(ArrayBuffer.isView(foreignBuffer)).toBe(false);
    expect(() =>
      assertNoAuthorityMarkerLeaks(markers, [{ nested: foreignBuffer }])
    ).toThrowError(/authority marker/u);
  });

  test("accepts benign raw cross-realm ArrayBuffer values", () => {
    const markers = validateAuthorityMarkers([printable, binary]);
    const foreignBuffers = [
      runInNewContext("Uint8Array.from([1, 2, 3]).buffer"),
      runInNewContext(`
        const buffer = new SharedArrayBuffer(3);
        new Uint8Array(buffer).set([4, 5, 6]);
        buffer;
      `),
    ];
    let getterCalls = 0;
    Object.defineProperty(foreignBuffers[0], Symbol.toStringTag, {
      get: () => {
        getterCalls += 1;
        return new TextDecoder().decode(printable);
      },
    });

    expect(() =>
      assertNoAuthorityMarkerLeaks(markers, foreignBuffers)
    ).not.toThrow();
    expect(getterCalls).toBe(0);
  });

  test("detects marker bytes when typed-array view metadata is shadowed", () => {
    const markers = validateAuthorityMarkers([printable, binary]);
    const metadataShadows = [
      ["buffer"],
      ["byteOffset"],
      ["byteLength"],
      ["length"],
      ["buffer", "byteOffset", "byteLength", "length"],
    ] as const;

    for (const shadowedFields of metadataShadows) {
      const backing = new ArrayBuffer(printable.byteLength * 2);
      const view = new Uint8Array(
        backing,
        printable.byteLength,
        printable.byteLength,
      );
      view.set(printable);
      const shadows = {
        buffer: new ArrayBuffer(printable.byteLength),
        byteOffset: 0,
        byteLength: 0,
        length: printable.byteLength,
      } as const;
      for (const field of shadowedFields) {
        Object.defineProperty(view, field, {
          configurable: true,
          enumerable: false,
          value: shadows[field],
        });
      }

      expect(
        () => assertNoAuthorityMarkerLeaks(markers, [{ nested: view }]),
        shadowedFields.join(","),
      ).toThrowError(/authority marker/u);
    }
  });

  test("scans custom own fields attached to binary objects", () => {
    const markers = validateAuthorityMarkers([printable, binary]);
    const representations = [
      printable,
      Buffer.from(printable).toString("hex"),
      Buffer.from(printable).toString("base64"),
      Buffer.from(printable).toString("base64url"),
      [...printable].map((byte) =>
        `%${byte.toString(16).padStart(2, "0").toUpperCase()}`
      ).join(""),
    ];
    const binaryObjects = [
      () => new Uint8Array(4),
      () => new DataView(new ArrayBuffer(4)),
      () => new ArrayBuffer(4),
    ];

    for (const createBinaryObject of binaryObjects) {
      for (const representation of representations) {
        const value = createBinaryObject() as object & {
          hiddenAuthority?: unknown;
          cycle?: unknown;
        };
        Object.defineProperty(value, "hiddenAuthority", {
          configurable: false,
          enumerable: false,
          writable: false,
          value: representation,
        });
        value.cycle = value;

        expect(() =>
          assertNoAuthorityMarkerLeaks(markers, [value])
        ).toThrowError(/authority marker/u);
      }
    }
  });

  test("requires two unique long markers spanning printable and binary data", () => {
    expect(() => validateAuthorityMarkers([printable])).toThrow();
    expect(() =>
      validateAuthorityMarkers([printable, printable])
    ).toThrow();
    expect(() =>
      validateAuthorityMarkers([
        encoder.encode("another-printable-authority-marker-0002"),
        encoder.encode("another-printable-authority-marker-0003"),
      ])
    ).toThrow();
  });

  test("scans exact sink outputs, journal bytes, and logical receipts", async () => {
    const markers = validateAuthorityMarkers([printable, binary]);
    const repository = new InMemoryEvidenceRepository();
    const journal = new InMemoryPublicationJournalStore();
    const sink = new InMemoryAnnouncementSink({
      medium: "https://publication.test/medium",
      profile: "https://publication.test/profile/v1",
    });
    sink.beforePrepare = () => {
      // Synthetic authority remains closed over by the sink fixture.
      void printable.byteLength;
      void binary.byteLength;
    };
    const bytes = Uint8Array.of(7);
    const receipt = await publish({
      records: [{
        reference: createRecordReference("execution-evidence", bytes),
        bytes,
      }],
      destination: "urn:jinn:publication-destination:authority-scan",
    }, { repository, journal, sink });
    const persisted = journal.entries()[0]!;

    expect(() =>
      assertNoAuthorityMarkerLeaks(markers, [
        receipt,
        persisted,
        encodeVersionedPublicationJournalEntry(persisted),
      ])
    ).not.toThrow();
  });

  test("scans every dependency fault, durable journal encoding, and recovery receipt", async () => {
    const patterns = validateAuthorityMarkers([printable, binary]);
    const boundaries: FaultBoundary[] = [
      ...(["before", "after"] as const).flatMap((phase) => [
        { operation: "journal.create", occurrence: 1, phase },
        { operation: "repository.putArtifact", occurrence: 1, phase },
        { operation: "repository.putRecord", occurrence: 1, phase },
        { operation: "sink.prepare", occurrence: 1, phase },
        { operation: "sink.place", occurrence: 1, phase },
      ] satisfies FaultBoundary[]),
      ...Array.from({ length: 6 }, (_unused, index) =>
        (["before", "after"] as const).map((phase) => ({
          operation: "journal.compareAndSwap" as const,
          occurrence: index + 1,
          phase,
        }))
      ).flat(),
    ];

    const runBoundary = async (
      boundary: FaultBoundary,
      seedReconciliation: boolean,
    ): Promise<void> => {
      const repositoryDelegate = new InMemoryEvidenceRepository();
      const journalDelegate = new InMemoryPublicationJournalStore();
      const sinkDelegate = new InMemoryAnnouncementSink({
        medium: "https://publication.test/authority-matrix-medium",
        profile: "https://publication.test/authority-matrix-profile/v1",
      });
      let activeFault: AuthorityFault | undefined;
      const around = <T>(
        operation: FaultOperation,
        effect: () => Promise<T>,
      ): Promise<T> =>
        activeFault === undefined
          ? effect()
          : activeFault.around(operation, effect);
      const repository: EvidenceRepository = {
        capabilities: repositoryDelegate.capabilities,
        putArtifact: (bytes, options) =>
          around(
            "repository.putArtifact",
            () => repositoryDelegate.putArtifact(bytes, options),
          ),
        getArtifact: (reference, options) =>
          repositoryDelegate.getArtifact(reference, options),
        putRecord: (family, bytes, options) =>
          around(
            "repository.putRecord",
            () => repositoryDelegate.putRecord(family, bytes, options),
          ),
        getRecord: (reference, options) =>
          repositoryDelegate.getRecord(reference, options),
      };
      const journal: PublicationJournalStore = {
        load: (
          bundleKey: Sha256Digest,
          options?: RepositoryOperationOptions,
        ) => journalDelegate.load(bundleKey, options),
        create: (input, options) =>
          around(
            "journal.create",
            () => journalDelegate.create(input, options),
          ),
        compareAndSwap: (expected, input, options) =>
          around(
            "journal.compareAndSwap",
            () => journalDelegate.compareAndSwap(expected, input, options),
          ),
      };
      const sink: AnnouncementSink = {
        medium: sinkDelegate.medium,
        profile: sinkDelegate.profile,
        capabilities: sinkDelegate.capabilities,
        prepare: (members, context, options) =>
          around(
            "sink.prepare",
            () => sinkDelegate.prepare(members, context, options),
          ),
        place: (prepared, key, options) =>
          around(
            "sink.place",
            () => sinkDelegate.place(prepared, key, options),
          ),
        reconcile: (prepared, pending, options) =>
          around(
            "sink.reconcile",
            () => sinkDelegate.reconcile(prepared, pending, options),
          ),
      };
      const durableEvidence = (): readonly unknown[] => {
        const entries = journalDelegate.entries();
        return [
          entries,
          ...entries.map(encodeVersionedPublicationJournalEntry),
        ];
      };
      const scan = (...values: readonly unknown[]) => {
        assertNoAuthorityMarkerLeaks(patterns, values);
      };

      if (seedReconciliation) {
        activeFault = new AuthorityFault({
          operation: "sink.place",
          occurrence: 1,
          phase: "before",
        }, [printable, binary]);
        let seedFailure: unknown;
        try {
          await publish(authorityFaultInput(), {
            repository,
            journal,
            sink,
          });
        } catch (error) {
          seedFailure = error;
        }
        expect(seedFailure).toMatchObject({ code: "OPERATION_ABORTED" });
        scan(seedFailure, durableEvidence());
      }

      activeFault = new AuthorityFault(boundary, [printable, binary]);
      let failure: unknown;
      try {
        await publish(authorityFaultInput(), {
          repository,
          journal,
          sink,
        });
      } catch (error) {
        failure = error;
      }
      expect(activeFault.triggered).toBe(true);
      expect(failure).toMatchObject({ code: "OPERATION_ABORTED" });
      scan(failure, durableEvidence());

      activeFault = undefined;
      const receipt = await publish(authorityFaultInput(), {
        repository,
        journal,
        sink,
      });
      expect(receipt.completed).toBe(true);
      expect(sinkDelegate.placementEffectCount).toBeLessThanOrEqual(1);
      scan(receipt, durableEvidence());
    };

    for (const boundary of boundaries) {
      await runBoundary(boundary, false);
    }
    for (const phase of ["before", "after"] as const) {
      await runBoundary({
        operation: "sink.reconcile",
        occurrence: 1,
        phase,
      }, true);
    }
  });
});
