import { describe, expect, test } from "vitest";

import {
  EVIDENCE_RECORD_FAMILIES,
  EVIDENCE_REPOSITORY_ERROR_CODES,
  EvidenceRepositoryError,
  NO_DECLARED_LIMIT_EVIDENCE_REPOSITORY_CAPABILITIES,
  assertRepositoryOperationActive,
  createArtifactReference,
  createRecordReference,
  parseSha256Digest,
} from "./index.js";
import {
  assertEvidenceRepositoryCapabilities,
  assertStableImmutableEvidenceRepositoryCapabilities,
} from "./capabilities.js";
import {
  InMemoryEvidenceRepository,
  describeEvidenceRepositoryContract,
} from "./testing.js";
import * as testingApi from "./testing.js";

const BOUNDED_OBJECT_BYTES = 1;

class BoundedInMemoryEvidenceRepository extends InMemoryEvidenceRepository {
  override readonly capabilities = Object.freeze({
    maxObjectBytes: BOUNDED_OBJECT_BYTES,
    futureCapability: "stable",
  });

  #assertWithinLimit(bytes: Uint8Array): void {
    if (bytes.byteLength > BOUNDED_OBJECT_BYTES) {
      throw new EvidenceRepositoryError(
        "CONTENT_TOO_LARGE",
        "The object exceeds the repository limit.",
      );
    }
  }

  override putRecord(
    ...args: Parameters<InMemoryEvidenceRepository["putRecord"]>
  ): ReturnType<InMemoryEvidenceRepository["putRecord"]> {
    this.#assertWithinLimit(args[1]);
    return super.putRecord(...args);
  }

  override putArtifact(
    ...args: Parameters<InMemoryEvidenceRepository["putArtifact"]>
  ): ReturnType<InMemoryEvidenceRepository["putArtifact"]> {
    this.#assertWithinLimit(args[0]);
    return super.putArtifact(...args);
  }
}

describe("repository references", () => {
  test("computes exact lowercase SHA-256 references", () => {
    const bytes = new TextEncoder().encode("jinn evidence");

    expect(createRecordReference("execution-evidence", bytes)).toEqual({
      family: "execution-evidence",
      digest:
        "sha256:9560dca737cadb3f5086a1c7105ac50d90d2af64dba74ff274ed4ecc8efb407b",
    });
    expect(createArtifactReference(bytes)).toEqual({
      digest:
        "sha256:9560dca737cadb3f5086a1c7105ac50d90d2af64dba74ff274ed4ecc8efb407b",
    });
    expect(EVIDENCE_RECORD_FAMILIES).toEqual([
      "execution-evidence",
      "result-evaluation",
      "execution-verification",
    ]);
  });

  test("parses only canonical lowercase SHA-256 digests", () => {
    const digest = `sha256:${"a".repeat(64)}`;

    expect(parseSha256Digest(digest)).toBe(digest);
    for (const invalid of [
      "sha256:abc",
      `sha256:${"A".repeat(64)}`,
      `sha512:${"a".repeat(64)}`,
      `sha256:${"g".repeat(64)}`,
    ]) {
      expect(() => parseSha256Digest(invalid)).toThrowError(
        expect.objectContaining({ code: "INVALID_REFERENCE" }),
      );
    }
  });

  test("reports an already-aborted operation with a stable code", () => {
    const controller = new AbortController();
    controller.abort();

    expect(() =>
      assertRepositoryOperationActive({ signal: controller.signal }),
    ).toThrowError(
      expect.objectContaining({
        name: "EvidenceRepositoryError",
        code: "OPERATION_ABORTED",
      }),
    );
    expect(
      new EvidenceRepositoryError("IO_FAILURE", "failed").code,
    ).toBe("IO_FAILURE");
  });
});

describe("repository capabilities", () => {
  test("exports one stable frozen empty capability object", () => {
    expect(
      Reflect.ownKeys(
        NO_DECLARED_LIMIT_EVIDENCE_REPOSITORY_CAPABILITIES,
      ),
    ).toEqual([]);
    expect(
      Object.getPrototypeOf(
        NO_DECLARED_LIMIT_EVIDENCE_REPOSITORY_CAPABILITIES,
      ),
    ).toBeNull();
    expect(
      Object.isFrozen(NO_DECLARED_LIMIT_EVIDENCE_REPOSITORY_CAPABILITIES),
    ).toBe(true);
    expect(EVIDENCE_REPOSITORY_ERROR_CODES).toContain("CONTENT_TOO_LARGE");
    expect(
      new EvidenceRepositoryError("CONTENT_TOO_LARGE", "too large").code,
    ).toBe("CONTENT_TOO_LARGE");
  });

  test("the empty capability snapshot is immune to prototype pollution", () => {
    const previousDescriptor = Object.getOwnPropertyDescriptor(
      Object.prototype,
      "maxObjectBytes",
    );
    let getterCalls = 0;

    try {
      Object.defineProperty(Object.prototype, "maxObjectBytes", {
        configurable: true,
        get() {
          getterCalls += 1;
          return 1;
        },
      });
      expect(
        assertStableImmutableEvidenceRepositoryCapabilities(
          () => NO_DECLARED_LIMIT_EVIDENCE_REPOSITORY_CAPABILITIES,
        ),
      ).toBe(NO_DECLARED_LIMIT_EVIDENCE_REPOSITORY_CAPABILITIES);
      expect(getterCalls).toBe(0);
    } finally {
      if (previousDescriptor === undefined) {
        Reflect.deleteProperty(Object.prototype, "maxObjectBytes");
      } else {
        Object.defineProperty(
          Object.prototype,
          "maxObjectBytes",
          previousDescriptor,
        );
      }
    }
  });

  test("preserves the cause supplied to a content-too-large error", () => {
    const cause = new Error("binding limit");
    const error = new EvidenceRepositoryError(
      "CONTENT_TOO_LARGE",
      "too large",
      { cause },
    );

    expect(error.cause).toBe(cause);
  });

  test.each([
    0,
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
    "1024",
  ])("rejects invalid maxObjectBytes value %s", (maxObjectBytes) => {
    expect(() =>
      assertEvidenceRepositoryCapabilities({ maxObjectBytes }),
    ).toThrowError(/maxObjectBytes/u);
  });

  test.each([null, [], 1, "capabilities"])(
    "rejects a non-object capability container %#",
    (capabilities) => {
      expect(() =>
        assertEvidenceRepositoryCapabilities(capabilities),
      ).toThrowError(/non-null, non-array object/u);
    },
  );

  test("accepts an absent limit and ignores future fields", () => {
    expect(() =>
      assertEvidenceRepositoryCapabilities(
        Object.freeze({ futureCapability: "preserved" }),
      ),
    ).not.toThrow();
  });

  test.each([1, Number.MAX_SAFE_INTEGER])(
    "accepts valid declared limit %s without allocating it",
    (maxObjectBytes) => {
      expect(() =>
        assertEvidenceRepositoryCapabilities({ maxObjectBytes }),
      ).not.toThrow();
    },
  );

  test("does not export capability validation from the testing subpath", () => {
    expect(testingApi).not.toHaveProperty(
      "assertEvidenceRepositoryCapabilities",
    );
    expect(testingApi).not.toHaveProperty(
      "assertEvidenceRepositoryCapabilitiesSlot",
    );
  });
});

describeEvidenceRepositoryContract(async () => ({
  repository: new InMemoryEvidenceRepository(),
}));

describeEvidenceRepositoryContract(async () => ({
  repository: new BoundedInMemoryEvidenceRepository(),
  createObjectAtDeclaredLimit: () => new Uint8Array(BOUNDED_OBJECT_BYTES),
  createObjectAboveDeclaredLimit: () =>
    new Uint8Array(BOUNDED_OBJECT_BYTES + 1),
}));
