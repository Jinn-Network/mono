import { afterAll, describe, expect, test } from "vitest";

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
  InMemoryEvidenceRepository,
  assertEvidenceRepositoryCapabilities,
  describeEvidenceRepositoryContract,
} from "./testing.js";

const BOUNDED_OBJECT_BYTES = 64;
const boundedContractObservations = {
  artifactAtLimit: 0,
  artifactOversize: 0,
  fixture: 0,
  recordAtLimit: 0,
  recordOversize: 0,
};

class BoundedInMemoryEvidenceRepository extends InMemoryEvidenceRepository {
  override readonly capabilities = Object.freeze({
    maxObjectBytes: BOUNDED_OBJECT_BYTES,
  });

  #observe(kind: "artifact" | "record", bytes: Uint8Array): void {
    if (bytes.byteLength === BOUNDED_OBJECT_BYTES) {
      boundedContractObservations[
        kind === "artifact" ? "artifactAtLimit" : "recordAtLimit"
      ] += 1;
    }
    if (bytes.byteLength > BOUNDED_OBJECT_BYTES) {
      boundedContractObservations[
        kind === "artifact" ? "artifactOversize" : "recordOversize"
      ] += 1;
      throw new EvidenceRepositoryError(
        "CONTENT_TOO_LARGE",
        "The object exceeds the repository limit.",
      );
    }
  }

  override putRecord(
    ...args: Parameters<InMemoryEvidenceRepository["putRecord"]>
  ): ReturnType<InMemoryEvidenceRepository["putRecord"]> {
    this.#observe("record", args[1]);
    return super.putRecord(...args);
  }

  override putArtifact(
    ...args: Parameters<InMemoryEvidenceRepository["putArtifact"]>
  ): ReturnType<InMemoryEvidenceRepository["putArtifact"]> {
    this.#observe("artifact", args[0]);
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
    expect(NO_DECLARED_LIMIT_EVIDENCE_REPOSITORY_CAPABILITIES).toEqual({});
    expect(
      Object.isFrozen(NO_DECLARED_LIMIT_EVIDENCE_REPOSITORY_CAPABILITIES),
    ).toBe(true);
    expect(EVIDENCE_REPOSITORY_ERROR_CODES).toContain("CONTENT_TOO_LARGE");
    expect(
      new EvidenceRepositoryError("CONTENT_TOO_LARGE", "too large").code,
    ).toBe("CONTENT_TOO_LARGE");
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
});

describeEvidenceRepositoryContract(async () => ({
  repository: new InMemoryEvidenceRepository(),
}));

describeEvidenceRepositoryContract(async () => ({
  repository: new BoundedInMemoryEvidenceRepository(),
  createObjectAtDeclaredLimit: () => {
    boundedContractObservations.fixture += 1;
    return new Uint8Array(BOUNDED_OBJECT_BYTES);
  },
}));

afterAll(() => {
  expect(boundedContractObservations).toEqual({
    artifactAtLimit: 1,
    artifactOversize: 1,
    fixture: 1,
    recordAtLimit: 1,
    recordOversize: 1,
  });
});
