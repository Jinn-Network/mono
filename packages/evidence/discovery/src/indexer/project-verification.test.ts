// SPDX-License-Identifier: MIT
import { readFile } from "node:fs/promises";

import {
  DSSE_PAYLOAD_TYPE,
  EXECUTION_VERIFICATION_PREDICATE_TYPE,
  IN_TOTO_STATEMENT_TYPE,
  validateExecutionVerification,
} from "@jinn-network/evidence-protocol";
import { describe, expect, test } from "vitest";

import { projectExecutionVerification } from "./project-verification.js";

const fixtureRoot = new URL(
  ".",
  import.meta.resolve(
    "@jinn-network/evidence-protocol/fixtures/golden-execution-evidence-v1/README.md",
  ),
);

function envelopeBytes(statement: unknown): Uint8Array {
  return Buffer.from(
    JSON.stringify({
      payloadType: DSSE_PAYLOAD_TYPE,
      payload: Buffer.from(JSON.stringify(statement)).toString("base64"),
      signatures: [{ sig: Buffer.alloc(64, 1).toString("base64") }],
    }),
  );
}

describe("Execution Verification projection", () => {
  test("binds the exact Execution record digest and declared Execution IRI", async () => {
    const bytes = await readFile(
      new URL(
        "claims/execution-verification/execution-verification.dsse.json",
        fixtureRoot,
      ),
    );
    const report = validateExecutionVerification(bytes);
    expect(report.conforms).toBe(true);
    const projection = projectExecutionVerification(
      { family: "execution-verification", digest: report.recordDigest },
      bytes.byteLength,
      report.value!,
    );

    expect(projection).toMatchObject({
      subjectRecord: {
        family: "execution-evidence",
        digest:
          "sha256:7c55e8e528cf5760508093141a3d859218bca33a436347a7f719667ed2ad46bf",
      },
      executionId: "urn:uuid:22222222-2222-4222-8222-222222222222",
      verifierId: "urn:uuid:66666666-6666-4666-8666-666666666666",
      verdict: "verified",
      verifiedAt: "2026-07-23T16:05:00Z",
      supersedes: [],
      disputes: [],
    });
    expect(projection).not.toHaveProperty("checks");
    expect(projection).not.toHaveProperty("verificationMethod");
  });

  test("projects minimal verification without signature trust inference", () => {
    const statement = {
      _type: IN_TOTO_STATEMENT_TYPE,
      subject: [
        {
          name: "ro-crate-metadata.json",
          digest: { sha256: "a".repeat(64) },
          annotations: { ignored: true },
        },
      ],
      predicateType: EXECUTION_VERIFICATION_PREDICATE_TYPE,
      predicate: {
        verifiedAt: "2026-07-23T16:05:00Z",
        verifier: { id: "urn:uuid:66666666-6666-4666-8666-666666666666" },
        executionId: "urn:uuid:22222222-2222-4222-8222-222222222222",
        verdict: "inconclusive",
      },
    };
    const bytes = envelopeBytes(statement);
    const report = validateExecutionVerification(bytes);
    expect(report.conforms).toBe(true);
    const projection = projectExecutionVerification(
      { family: "execution-verification", digest: report.recordDigest },
      bytes.byteLength,
      report.value!,
    );
    expect(projection.subjectRecord.digest).toBe(`sha256:${"a".repeat(64)}`);
    expect(projection.supersedes).toEqual([]);
    expect(projection.disputes).toEqual([]);
    expect(projection).not.toHaveProperty("signatureVerified");
    expect(JSON.stringify(projection)).not.toContain("ignored");
  });
});
