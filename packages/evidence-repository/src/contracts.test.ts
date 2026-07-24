import { describe, expect, test } from "vitest";

import {
  EVIDENCE_RECORD_FAMILIES,
  EvidenceRepositoryError,
  assertRepositoryOperationActive,
  createArtifactReference,
  createRecordReference,
  parseSha256Digest,
} from "./index.js";
import {
  InMemoryEvidenceRepository,
  describeEvidenceRepositoryContract,
} from "./testing.js";

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

describeEvidenceRepositoryContract(async () => ({
  repository: new InMemoryEvidenceRepository(),
}));
