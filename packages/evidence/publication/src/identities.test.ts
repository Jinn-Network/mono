// SPDX-License-Identifier: Apache-2.0
import {
  createArtifactReference,
  createRecordReference,
} from "@jinn-network/evidence-repository";
import { describe, expect, test } from "vitest";

import {
  assertPreparedAnnouncement,
  derivePlacementIdempotencyKey,
  normalizePublishInput,
  snapshotPreparedAnnouncement,
} from "./identities.js";
import { EvidencePublicationError } from "./errors.js";
import type { PreparedAnnouncement } from "./types.js";

const arbitraryBytes = new TextEncoder().encode("not protocol JSON");
const secondBytes = new Uint8Array([1, 2, 3]);

describe("publication identities", () => {
  test("normalizes exact bytes without enforcing Evidence Protocol conformance", () => {
    const record = {
      reference: createRecordReference("execution-evidence", arbitraryBytes),
      bytes: arbitraryBytes,
    } as const;
    const artifact = {
      reference: createArtifactReference(secondBytes),
      bytes: secondBytes,
    } as const;

    const normalized = normalizePublishInput({
      records: [record, record],
      artifacts: [artifact, artifact],
      destination: "urn:jinn:publication-destination:fixture",
    });

    expect(normalized.records).toHaveLength(1);
    expect(normalized.artifacts).toHaveLength(1);
    expect(normalized.records[0]?.bytes).toEqual(arbitraryBytes);
    expect(normalized.artifacts[0]?.bytes).toEqual(secondBytes);
    expect(normalized.bundleKey).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(normalized.payloadFingerprint).toMatch(
      /^sha256:[0-9a-f]{64}$/u,
    );
  });

  test("sorts artifacts by digest and records by family then digest", () => {
    const records = [
      {
        reference: createRecordReference(
          "result-evaluation",
          new Uint8Array([9]),
        ),
        bytes: new Uint8Array([9]),
      },
      {
        reference: createRecordReference(
          "execution-evidence",
          new Uint8Array([8]),
        ),
        bytes: new Uint8Array([8]),
      },
    ] as const;
    const artifacts = [
      {
        reference: createArtifactReference(new Uint8Array([7])),
        bytes: new Uint8Array([7]),
      },
      {
        reference: createArtifactReference(new Uint8Array([6])),
        bytes: new Uint8Array([6]),
      },
    ] as const;

    const normalized = normalizePublishInput({
      records,
      artifacts,
      destination: "https://publication.example/repository",
    });

    expect(normalized.records.map(({ reference }) => reference)).toEqual(
      [...records]
        .map(({ reference }) => reference)
        .sort((left, right) =>
          `${left.family}:${left.digest}`.localeCompare(
            `${right.family}:${right.digest}`,
          )
        ),
    );
    expect(normalized.artifacts.map(({ reference }) => reference)).toEqual(
      [...artifacts]
        .map(({ reference }) => reference)
        .sort((left, right) => left.digest.localeCompare(right.digest)),
    );
  });

  test("rejects a digest mismatch before returning normalized input", () => {
    const reference = createRecordReference(
      "execution-evidence",
      new Uint8Array([1]),
    );

    expect(() =>
      normalizePublishInput({
        records: [{ reference, bytes: new Uint8Array([2]) }],
        destination: "urn:jinn:publication-destination:fixture",
      })
    ).toThrowError(
      expect.objectContaining({ code: "CONTENT_DIGEST_MISMATCH" }),
    );
  });

  test("rejects conflicting duplicate declarations", () => {
    const bytes = new Uint8Array([3]);
    const reference = createArtifactReference(bytes);

    expect(() =>
      normalizePublishInput({
        records: [{
          reference: createRecordReference("execution-evidence", bytes),
          bytes,
        }],
        artifacts: [
          { reference, bytes },
          { reference, bytes: new Uint8Array([4]) },
        ],
        destination: "urn:jinn:publication-destination:fixture",
      })
    ).toThrowError(expect.objectContaining({ code: "BUNDLE_CONFLICT" }));
  });

  test("requires records and a credential-free absolute destination IRI", () => {
    for (const destination of [
      "relative/path",
      "https://user:secret@example.test/repository",
    ]) {
      expect(() =>
        normalizePublishInput({
          records: [],
          destination,
        })
      ).toThrowError(expect.objectContaining({ code: "INVALID_INPUT" }));
    }

    expect(() =>
      normalizePublishInput({
        records: [],
        destination: "urn:jinn:publication-destination:fixture",
      })
    ).toThrowError(expect.objectContaining({ code: "INVALID_INPUT" }));
  });

  test("defensively copies accepted references and bytes", () => {
    const bytes = new Uint8Array([5]);
    const reference = createRecordReference("execution-verification", bytes);
    const mutableReference = { ...reference };
    const input = {
      records: [{ reference: mutableReference, bytes }],
      destination: "urn:jinn:publication-destination:fixture",
    };

    const normalized = normalizePublishInput(input);
    bytes[0] = 99;
    mutableReference.family = "execution-evidence";

    expect(normalized.records[0]).toEqual({
      reference,
      bytes: new Uint8Array([5]),
    });
  });

  test("validates exact sink-owned prepared framing and cloned members", () => {
    const members = [{
      reference: createRecordReference(
        "execution-evidence",
        new Uint8Array([6]),
      ),
    }] as const;
    const frameBytes = new TextEncoder().encode("frame");
    const prepared = {
      medium: "https://medium.example/id",
      profile: "https://medium.example/profile/v1",
      members: structuredClone(members),
      frameBytes,
      frameDigest:
        "sha256:9dff50df08c635815f4b19da10f756605a34a79a48d4ba48712782502975a70e",
      frameSize: frameBytes.byteLength,
    } as const;

    expect(() =>
      assertPreparedAnnouncement(
        prepared,
        members,
        "https://medium.example/id",
        "https://medium.example/profile/v1",
      )
    ).not.toThrow();
  });

  test.each([
    ["medium", { medium: "https://medium.example/other" }],
    ["profile", { profile: "https://medium.example/profile/v2" }],
    ["size", { frameSize: 4 }],
    ["digest", {
      frameDigest:
        "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    }],
    ["members", { members: [] }],
  ] as const)(
    "rejects a prepared announcement with a mismatched %s",
    (_name, override) => {
      const members = [{
        reference: createRecordReference(
          "execution-evidence",
          new Uint8Array([6]),
        ),
      }] as const;
      const frameBytes = new TextEncoder().encode("frame");
      const prepared = {
        medium: "https://medium.example/id",
        profile: "https://medium.example/profile/v1",
        members,
        frameBytes,
        frameDigest:
          "sha256:9dff50df08c635815f4b19da10f756605a34a79a48d4ba48712782502975a70e" as const,
        frameSize: frameBytes.byteLength,
        ...override,
      } as PreparedAnnouncement;

      expect(() =>
        assertPreparedAnnouncement(
          prepared,
          members,
          "https://medium.example/id",
          "https://medium.example/profile/v1",
        )
      ).toThrowError(
        expect.objectContaining({ code: "SINK_PROTOCOL_VIOLATION" }),
      );
    },
  );

  test("accepts prepared own data fields on structural prototypes without evaluating extensions", () => {
    const members = [{
      reference: createRecordReference(
        "execution-evidence",
        new Uint8Array([6]),
      ),
    }] as const;
    const frameBytes = new TextEncoder().encode("frame");
    const frameDigest =
      "sha256:9dff50df08c635815f4b19da10f756605a34a79a48d4ba48712782502975a70e";
    let extensionGetterCalls = 0;
    class PreparedFixture {
      readonly medium = "https://medium.example/id";
      readonly profile = "https://medium.example/profile/v1";
      readonly members = structuredClone(members);
      readonly frameBytes = frameBytes;
      readonly frameDigest = frameDigest;
      readonly frameSize = frameBytes.byteLength;

      get futureExtension(): never {
        extensionGetterCalls += 1;
        throw new Error("must not evaluate extensions");
      }
    }
    const classResult = Object.freeze(new PreparedFixture());
    const nullResult = Object.create(null) as Record<string, unknown>;
    for (const [name, value] of Object.entries({
      medium: "https://medium.example/id",
      profile: "https://medium.example/profile/v1",
      members: structuredClone(members),
      frameBytes,
      frameDigest,
      frameSize: frameBytes.byteLength,
    })) {
      Object.defineProperty(nullResult, name, {
        configurable: false,
        enumerable: false,
        writable: false,
        value,
      });
    }
    Object.defineProperty(nullResult, "futureExtension", {
      configurable: false,
      enumerable: false,
      get: () => {
        extensionGetterCalls += 1;
        throw new Error("must not evaluate extensions");
      },
    });
    Object.preventExtensions(nullResult);

    for (const result of [classResult, nullResult]) {
      expect(
        snapshotPreparedAnnouncement(
          result as PreparedAnnouncement,
          members,
          "https://medium.example/id",
          "https://medium.example/profile/v1",
        ),
      ).toMatchObject({
        profile: "https://medium.example/profile/v1",
        frameDigest,
        frameSize: frameBytes.byteLength,
      });
    }
    expect(extensionGetterCalls).toBe(0);
  });

  test("preserves the sink's exact immutable medium with its profile", () => {
    const members = [{
      reference: createRecordReference(
        "execution-evidence",
        new Uint8Array([6]),
      ),
    }] as const;
    const frameBytes = new TextEncoder().encode("frame");
    const snapshot = snapshotPreparedAnnouncement(
      {
        medium: "https://medium.example/id",
        profile: "https://medium.example/profile/v1",
        members,
        frameBytes,
        frameDigest:
          "sha256:9dff50df08c635815f4b19da10f756605a34a79a48d4ba48712782502975a70e",
        frameSize: frameBytes.byteLength,
      } as unknown as PreparedAnnouncement,
      members,
      "https://medium.example/id",
      "https://medium.example/profile/v1",
    );

    expect(
      (snapshot as unknown as { readonly medium?: string }).medium,
    ).toBe("https://medium.example/id");
  });

  test.each([
    "medium",
    "profile",
    "members",
    "frameBytes",
    "frameDigest",
    "frameSize",
  ] as const)(
    "rejects accessor-backed prepared %s without invoking it",
    (field) => {
      const members = [{
        reference: createRecordReference(
          "execution-evidence",
          new Uint8Array([6]),
        ),
      }] as const;
      const frameBytes = new TextEncoder().encode("frame");
      const prepared: Record<string, unknown> = {
        medium: "https://medium.example/id",
        profile: "https://medium.example/profile/v1",
        members,
        frameBytes,
        frameDigest:
          "sha256:9dff50df08c635815f4b19da10f756605a34a79a48d4ba48712782502975a70e",
        frameSize: frameBytes.byteLength,
      };
      let getterCalls = 0;
      Object.defineProperty(prepared, field, {
        configurable: true,
        get: () => {
          getterCalls += 1;
          return undefined;
        },
      });

      expect(() =>
        snapshotPreparedAnnouncement(
          prepared as unknown as PreparedAnnouncement,
          members,
          "https://medium.example/id",
          "https://medium.example/profile/v1",
        )
      ).toThrowError(
        expect.objectContaining({ code: "SINK_PROTOCOL_VIOLATION" }),
      );
      expect(getterCalls).toBe(0);
    },
  );

  test("rejects a proxied prepared result before invoking reflection traps", () => {
    const members = [{
      reference: createRecordReference(
        "execution-evidence",
        new Uint8Array([6]),
      ),
    }] as const;
    const frameBytes = new TextEncoder().encode("frame");
    let trapCalls = 0;
    const prepared = new Proxy(
      {
        medium: "https://medium.example/id",
        profile: "https://medium.example/profile/v1",
        members,
        frameBytes,
        frameDigest:
          "sha256:9dff50df08c635815f4b19da10f756605a34a79a48d4ba48712782502975a70e" as const,
        frameSize: frameBytes.byteLength,
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

    expect(() =>
      snapshotPreparedAnnouncement(
        prepared,
        members,
        "https://medium.example/id",
        "https://medium.example/profile/v1",
      )
    ).toThrowError(
      expect.objectContaining({ code: "SINK_PROTOCOL_VIOLATION" }),
    );
    expect(trapCalls).toBe(0);
  });

  test("rejects accessor-backed prepared member elements without invoking them", () => {
    const expectedMembers = [{
      reference: createRecordReference(
        "execution-evidence",
        new Uint8Array([6]),
      ),
    }] as const;
    const actualMembers = [...expectedMembers];
    let getterCalls = 0;
    Object.defineProperty(actualMembers, "0", {
      configurable: true,
      get: () => {
        getterCalls += 1;
        return expectedMembers[0];
      },
    });
    const frameBytes = new TextEncoder().encode("frame");

    expect(() =>
      snapshotPreparedAnnouncement(
        {
          medium: "https://medium.example/id",
          profile: "https://medium.example/profile/v1",
          members: actualMembers,
          frameBytes,
          frameDigest:
            "sha256:9dff50df08c635815f4b19da10f756605a34a79a48d4ba48712782502975a70e",
          frameSize: frameBytes.byteLength,
        },
        expectedMembers,
        "https://medium.example/id",
        "https://medium.example/profile/v1",
      )
    ).toThrowError(
      expect.objectContaining({ code: "SINK_PROTOCOL_VIOLATION" }),
    );
    expect(getterCalls).toBe(0);
  });

  test.each(["family", "digest"] as const)(
    "rejects accessor-backed prepared member reference %s without invoking it",
    (field) => {
      const reference = createRecordReference(
        "execution-evidence",
        new Uint8Array([6]),
      );
      const expectedMembers = [{ reference }] as const;
      const actualReference = { ...reference };
      let getterCalls = 0;
      Object.defineProperty(actualReference, field, {
        configurable: true,
        get: () => {
          getterCalls += 1;
          return reference[field];
        },
      });
      const frameBytes = new TextEncoder().encode("frame");

      expect(() =>
        snapshotPreparedAnnouncement(
          {
            medium: "https://medium.example/id",
            profile: "https://medium.example/profile/v1",
            members: [{ reference: actualReference }],
            frameBytes,
            frameDigest:
              "sha256:9dff50df08c635815f4b19da10f756605a34a79a48d4ba48712782502975a70e",
            frameSize: frameBytes.byteLength,
          },
          expectedMembers,
          "https://medium.example/id",
          "https://medium.example/profile/v1",
        )
      ).toThrowError(
        expect.objectContaining({ code: "SINK_PROTOCOL_VIOLATION" }),
      );
      expect(getterCalls).toBe(0);
    },
  );

  test("rejects an accessor-backed member reference slot without invoking it", () => {
    const reference = createRecordReference(
      "execution-evidence",
      new Uint8Array([6]),
    );
    const expectedMembers = [{ reference }] as const;
    const member = {} as Record<string, unknown>;
    let getterCalls = 0;
    Object.defineProperty(member, "reference", {
      configurable: true,
      get: () => {
        getterCalls += 1;
        return reference;
      },
    });
    const frameBytes = new TextEncoder().encode("frame");

    expect(() =>
      snapshotPreparedAnnouncement(
        {
          medium: "https://medium.example/id",
          profile: "https://medium.example/profile/v1",
          members: [member] as unknown as PreparedAnnouncement["members"],
          frameBytes,
          frameDigest:
            "sha256:9dff50df08c635815f4b19da10f756605a34a79a48d4ba48712782502975a70e",
          frameSize: frameBytes.byteLength,
        },
        expectedMembers,
        "https://medium.example/id",
        "https://medium.example/profile/v1",
      )
    ).toThrowError(
      expect.objectContaining({ code: "SINK_PROTOCOL_VIOLATION" }),
    );
    expect(getterCalls).toBe(0);
  });

  test("accepts recursive structural prepared data without evaluating extensions", () => {
    const reference = createRecordReference(
      "execution-evidence",
      new Uint8Array([6]),
    );
    let extensionGetterCalls = 0;
    const structuralReference = Object.create(null) as Record<string, unknown>;
    for (const field of ["family", "digest"] as const) {
      Object.defineProperty(structuralReference, field, {
        configurable: false,
        enumerable: false,
        writable: false,
        value: reference[field],
      });
    }
    Object.defineProperty(structuralReference, "futureExtension", {
      configurable: false,
      get: () => {
        extensionGetterCalls += 1;
        throw new Error("must not evaluate reference extensions");
      },
    });
    class Member {
      readonly reference = structuralReference;

      get futureExtension(): never {
        extensionGetterCalls += 1;
        throw new Error("must not evaluate member extensions");
      }
    }
    const expectedMembers = [{ reference }] as const;
    const frameBytes = new TextEncoder().encode("frame");

    expect(
      snapshotPreparedAnnouncement(
        {
          medium: "https://medium.example/id",
          profile: "https://medium.example/profile/v1",
          members: [new Member()] as unknown as PreparedAnnouncement["members"],
          frameBytes,
          frameDigest:
            "sha256:9dff50df08c635815f4b19da10f756605a34a79a48d4ba48712782502975a70e",
          frameSize: frameBytes.byteLength,
        },
        expectedMembers,
        "https://medium.example/id",
        "https://medium.example/profile/v1",
      ).members,
    ).toEqual(expectedMembers);
    expect(extensionGetterCalls).toBe(0);
  });

  test("rejects a proxied prepared member element without invoking traps", () => {
    const reference = createRecordReference(
      "execution-evidence",
      new Uint8Array([6]),
    );
    const expectedMembers = [{ reference }] as const;
    let trapCalls = 0;
    const member = new Proxy({ reference }, {
      get: (target, key, receiver) => {
        trapCalls += 1;
        return Reflect.get(target, key, receiver);
      },
      getOwnPropertyDescriptor: (target, key) => {
        trapCalls += 1;
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    });
    const frameBytes = new TextEncoder().encode("frame");

    expect(() =>
      snapshotPreparedAnnouncement(
        {
          medium: "https://medium.example/id",
          profile: "https://medium.example/profile/v1",
          members: [member],
          frameBytes,
          frameDigest:
            "sha256:9dff50df08c635815f4b19da10f756605a34a79a48d4ba48712782502975a70e",
          frameSize: frameBytes.byteLength,
        },
        expectedMembers,
        "https://medium.example/id",
        "https://medium.example/profile/v1",
      )
    ).toThrowError(
      expect.objectContaining({ code: "SINK_PROTOCOL_VIOLATION" }),
    );
    expect(trapCalls).toBe(0);
  });

  test.each(["member reference", "frame bytes"] as const)(
    "rejects proxied prepared %s without invoking traps",
    (role) => {
      const reference = createRecordReference(
        "execution-evidence",
        new Uint8Array([6]),
      );
      const expectedMembers = [{ reference }] as const;
      const frameBytes = new TextEncoder().encode("frame");
      let trapCalls = 0;
      const traps = {
        get: (target: object, key: PropertyKey, receiver: unknown) => {
          trapCalls += 1;
          return Reflect.get(target, key, receiver);
        },
        getOwnPropertyDescriptor: (target: object, key: PropertyKey) => {
          trapCalls += 1;
          return Reflect.getOwnPropertyDescriptor(target, key);
        },
      };
      const actualReference = (role === "member reference"
        ? new Proxy(reference, traps)
        : reference) as PreparedAnnouncement["members"][number]["reference"];
      const actualFrameBytes = (role === "frame bytes"
        ? new Proxy(frameBytes, traps)
        : frameBytes) as Uint8Array;

      expect(() =>
        snapshotPreparedAnnouncement(
          {
            medium: "https://medium.example/id",
            profile: "https://medium.example/profile/v1",
            members: [{ reference: actualReference }],
            frameBytes: actualFrameBytes,
            frameDigest:
              "sha256:9dff50df08c635815f4b19da10f756605a34a79a48d4ba48712782502975a70e",
            frameSize: frameBytes.byteLength,
          },
          expectedMembers,
          "https://medium.example/id",
          "https://medium.example/profile/v1",
        )
      ).toThrowError(
        expect.objectContaining({ code: "SINK_PROTOCOL_VIOLATION" }),
      );
      expect(trapCalls).toBe(0);
    },
  );

  test.each([
    ["medium", { medium: "relative-medium" }],
    ["profile", { profile: "relative-profile" }],
    ["member reference", {
      members: [{ reference: { family: "foreign", digest: "not-a-digest" } }],
    }],
    ["frame bytes", { frameBytes: [1, 2, 3] }],
    ["frame digest", { frameDigest: "not-a-digest" }],
  ] as const)(
    "maps malformed prepared %s output to a sink protocol violation with cause",
    (_name, override) => {
      const members = [{
        reference: createRecordReference(
          "execution-evidence",
          new Uint8Array([6]),
        ),
      }] as const;
      const frameBytes = new TextEncoder().encode("frame");
      const prepared = {
        medium: "https://medium.example/id",
        profile: "https://medium.example/profile/v1",
        members,
        frameBytes,
        frameDigest:
          "sha256:9dff50df08c635815f4b19da10f756605a34a79a48d4ba48712782502975a70e",
        frameSize: frameBytes.byteLength,
        ...override,
      } as unknown as PreparedAnnouncement;

      let caught: unknown;
      try {
        snapshotPreparedAnnouncement(
          prepared,
          members,
          "https://medium.example/id",
          "https://medium.example/profile/v1",
        );
      } catch (error) {
        caught = error;
      }
      expect(caught).toMatchObject({
        code: "SINK_PROTOCOL_VIOLATION",
        cause: expect.anything(),
      });
      expect((caught as EvidencePublicationError).cause).toMatchObject({
        code: "INVALID_INPUT",
      });
    },
  );

  test("derives stable placement keys from every placement identity", () => {
    const base = {
      bundleKey:
        "sha256:1111111111111111111111111111111111111111111111111111111111111111",
      destination: "urn:jinn:publication-destination:fixture",
      partitionOrdinal: 0,
      frameDigest:
        "sha256:2222222222222222222222222222222222222222222222222222222222222222",
      medium: "https://medium.example/id",
      profile: "https://medium.example/profile/v1",
    } as const;
    const first = derivePlacementIdempotencyKey(base);

    expect(first).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(derivePlacementIdempotencyKey(base)).toBe(first);
    expect(
      derivePlacementIdempotencyKey({ ...base, partitionOrdinal: 1 }),
    ).not.toBe(first);
  });

  test("publication errors preserve causes", () => {
    const cause = new Error("fixture");
    expect(
      new EvidencePublicationError("IO_FAILURE", "failed", { cause }).cause,
    ).toBe(cause);
  });
});
