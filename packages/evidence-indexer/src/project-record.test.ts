// SPDX-License-Identifier: MIT
import { readFile } from "node:fs/promises";

import { recordDigest } from "@jinn-network/evidence-protocol";
import { InMemoryEvidenceCatalog } from "@jinn-network/evidence-catalog";
import { describe, expect, test } from "vitest";

import { validateAndProjectEvidenceRecord } from "./project-record.js";

const fixtureRoot = new URL(
  ".",
  import.meta.resolve(
    "@jinn-network/evidence-protocol/fixtures/golden-execution-evidence-v1/README.md",
  ),
);

describe("Evidence record validation dispatch", () => {
  test.each([
    [
      "result-evaluation",
      "claims/result-evaluation/result-evaluation.dsse.json",
    ],
    [
      "execution-verification",
      "claims/execution-verification/execution-verification.dsse.json",
    ],
  ] as const)("validates and projects %s", async (family, relativePath) => {
    const bytes = await readFile(new URL(relativePath, fixtureRoot));
    const result = validateAndProjectEvidenceRecord(
      { family, digest: recordDigest(bytes) },
      bytes,
    );
    expect(result.conforms).toBe(true);
    if (result.conforms) expect(result.projection.family).toBe(family);
  });

  test("returns sorted protocol diagnostics for malformed evidence", () => {
    const bytes = Buffer.from("{");
    const result = validateAndProjectEvidenceRecord(
      { family: "result-evaluation", digest: recordDigest(bytes) },
      bytes,
    );
    expect(result).toMatchObject({
      conforms: false,
      diagnostics: [{ code: "JSON_INVALID" }],
    });
  });

  test("throws a stable error for a caller digest mismatch", async () => {
    const bytes = await readFile(
      new URL(
        "claims/result-evaluation/result-evaluation.dsse.json",
        fixtureRoot,
      ),
    );
    expect(() =>
      validateAndProjectEvidenceRecord(
        {
          family: "result-evaluation",
          digest: `sha256:${"0".repeat(64)}`,
        },
        bytes,
      ),
    ).toThrowError(expect.objectContaining({ code: "REFERENCE_MISMATCH" }));
  });

  test("does not verify signatures or resolve actor identities", async () => {
    const bytes = await readFile(
      new URL(
        "claims/result-evaluation/result-evaluation.dsse.json",
        fixtureRoot,
      ),
    );
    const result = validateAndProjectEvidenceRecord(
      { family: "result-evaluation", digest: recordDigest(bytes) },
      bytes,
    );
    expect(result.conforms).toBe(true);
    if (result.conforms) {
      expect(result.projection).not.toHaveProperty("signatureVerified");
      expect(result.projection).not.toHaveProperty("actorIdentity");
    }
  });

  test("matches exact evaluation subjects to every corresponding Execution record", async () => {
    const [privateBytes, publicBytes, evaluationBytes] = await Promise.all([
      readFile(new URL("execution/ro-crate-metadata.json", fixtureRoot)),
      readFile(new URL("public/ro-crate-metadata.json", fixtureRoot)),
      readFile(
        new URL(
          "claims/result-evaluation/result-evaluation.dsse.json",
          fixtureRoot,
        ),
      ),
    ]);
    const projected = [
      validateAndProjectEvidenceRecord(
        {
          family: "execution-evidence",
          digest: recordDigest(privateBytes),
        },
        privateBytes,
      ),
      validateAndProjectEvidenceRecord(
        {
          family: "execution-evidence",
          digest: recordDigest(publicBytes),
        },
        publicBytes,
      ),
      validateAndProjectEvidenceRecord(
        {
          family: "result-evaluation",
          digest: recordDigest(evaluationBytes),
        },
        evaluationBytes,
      ),
    ];
    expect(projected.every(({ conforms }) => conforms)).toBe(true);
    const catalog = new InMemoryEvidenceCatalog();
    for (const [index, result] of projected.entries()) {
      if (!result.conforms) continue;
      await catalog.putRecordProjection(result.projection);
      await catalog.observeRecordLocation(result.projection.reference, {
        sourceId: "fixture",
        announcementId: `available-${index}`,
        repositoryId: "fixture",
      });
    }
    const evaluation = projected[2]!;
    if (!evaluation.conforms || evaluation.projection.family !== "result-evaluation") {
      throw new Error("Expected projected Evaluation fixture.");
    }
    const matches = await catalog.findExecutions({
      taskDigest: evaluation.projection.taskSubject.digest,
      resultDigest: evaluation.projection.resultSubjects[0].digest,
    });
    expect(matches.items).toHaveLength(2);
    expect(new Set(matches.items.map(({ executionId }) => executionId)).size).toBe(
      1,
    );
  });

  test("rejects an unsupported caller family", () => {
    const bytes = Buffer.from("{}");
    expect(() =>
      validateAndProjectEvidenceRecord(
        {
          family: "unsupported",
          digest: recordDigest(bytes),
        } as never,
        bytes,
      ),
    ).toThrowError(expect.objectContaining({ code: "REFERENCE_MISMATCH" }));
  });
});
