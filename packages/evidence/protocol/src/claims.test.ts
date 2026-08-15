import { readFile } from "node:fs/promises";
import { createPublicKey, verify } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  DSSE_PAYLOAD_TYPE,
  EXECUTION_VERIFICATION_PREDICATE_TYPE,
  IN_TOTO_STATEMENT_TYPE,
  RESULT_EVALUATION_PREDICATE_TYPE,
  dssePreAuthEncoding,
  validateExecutionVerification,
  validateResultEvaluation,
  verifyDsseSignatures,
} from "./index.js";

const fixture = (path: string) =>
  readFile(
    new URL(
      `../fixtures/golden-execution-evidence-v1/claims/${path}`,
      import.meta.url,
    ),
  );

function envelopeBytes(statement: unknown, overrides: Record<string, unknown> = {}) {
  const payload = Buffer.from(`${JSON.stringify(statement, null, 2)}\n`);
  return Buffer.from(
    JSON.stringify({
      payloadType: DSSE_PAYLOAD_TYPE,
      payload: payload.toString("base64"),
      signatures: [{ sig: Buffer.alloc(64, 1).toString("base64") }],
      ...overrides,
    }),
  );
}

const digest = { sha256: "a".repeat(64) };

function minimalEvaluation() {
  return {
    _type: IN_TOTO_STATEMENT_TYPE,
    subject: [
      { name: "task.md", digest },
      { name: "result.patch", digest: { sha256: "b".repeat(64) } },
    ],
    predicateType: RESULT_EVALUATION_PREDICATE_TYPE,
    predicate: {
      evaluatedAt: "2026-07-23T16:00:00Z",
      evaluator: { id: "urn:uuid:55555555-5555-4555-8555-555555555555" },
      taskSubject: "task.md",
      resultSubjects: ["result.patch"],
      verdict: "pass",
    },
  };
}

function minimalVerification() {
  return {
    _type: IN_TOTO_STATEMENT_TYPE,
    subject: [{ name: "ro-crate-metadata.json", digest }],
    predicateType: EXECUTION_VERIFICATION_PREDICATE_TYPE,
    predicate: {
      verifiedAt: "2026-07-23T16:05:00Z",
      verifier: { id: "urn:uuid:66666666-6666-4666-8666-666666666666" },
      executionId: "urn:uuid:22222222-2222-4222-8222-222222222222",
      verdict: "verified",
    },
  };
}

describe("authenticated claim validation", () => {
  it("validates both golden DSSE claims and retains exact payload bytes", async () => {
    const evaluationBytes = await fixture(
      "result-evaluation/result-evaluation.dsse.json",
    );
    const verificationBytes = await fixture(
      "execution-verification/execution-verification.dsse.json",
    );

    const evaluation = validateResultEvaluation(evaluationBytes);
    const verification = validateExecutionVerification(verificationBytes);

    expect(evaluation).toMatchObject({ conforms: true, diagnostics: [] });
    expect(verification).toMatchObject({ conforms: true, diagnostics: [] });
    expect(evaluation.value?.payloadBytes).toEqual(
      new Uint8Array(
        Buffer.from(evaluation.value!.envelope.payload, "base64"),
      ),
    );
    expect(verification.value?.payloadBytes).toEqual(
      new Uint8Array(
        Buffer.from(verification.value!.envelope.payload, "base64"),
      ),
    );
  });

  it("accepts minimal predicates and preserves unknown fields", () => {
    const evaluation = minimalEvaluation();
    Object.assign(evaluation, { "x-statement-extension": { retained: true } });
    Object.assign(evaluation.predicate, { "x-predicate-extension": 42 });

    const report = validateResultEvaluation(envelopeBytes(evaluation));

    expect(report.conforms).toBe(true);
    expect(report.value?.statement["x-statement-extension"]).toEqual({
      retained: true,
    });
    expect(report.value?.statement.predicate["x-predicate-extension"]).toBe(42);
    expect(
      validateExecutionVerification(envelopeBytes(minimalVerification()))
        .conforms,
    ).toBe(true);
  });

  it.each([
    [Buffer.from("{"), "JSON_INVALID"],
    [
      envelopeBytes(minimalEvaluation(), { payloadType: "text/plain" }),
      "ATTESTATION_PAYLOAD_TYPE_INVALID",
    ],
    [
      envelopeBytes(minimalEvaluation(), { payload: "not base64!" }),
      "ATTESTATION_PAYLOAD_INVALID",
    ],
    [
      envelopeBytes(minimalEvaluation(), { signatures: [] }),
      "ATTESTATION_SIGNATURE_MISSING",
    ],
  ])("rejects malformed envelope input with %s", (bytes, code) => {
    const report = validateResultEvaluation(bytes as Uint8Array);
    expect(report.conforms).toBe(false);
    expect(report.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      code,
    );
  });

  it("enforces unique subjects and exact evaluation bindings", () => {
    const duplicate = minimalEvaluation();
    duplicate.subject[1] = { ...duplicate.subject[0]! };
    const unbound = minimalEvaluation();
    unbound.predicate.resultSubjects = ["other.patch"];

    expect(
      validateResultEvaluation(envelopeBytes(duplicate)).diagnostics.map(
        ({ code }) => code,
      ),
    ).toContain("ATTESTATION_SUBJECT_INVALID");
    expect(
      validateResultEvaluation(envelopeBytes(unbound)).diagnostics.map(
        ({ code }) => code,
      ),
    ).toContain("EVALUATION_SUBJECT_BINDING_INVALID");
  });

  it("enforces the verification metadata subject and Execution IRI", () => {
    const wrong = minimalVerification();
    wrong.subject[0]!.name = "other.json";
    wrong.predicate.executionId = "relative-execution";

    const report = validateExecutionVerification(envelopeBytes(wrong));

    expect(report.diagnostics.map(({ code }) => code)).toEqual([
      "VERIFICATION_SUBJECT_BINDING_INVALID",
      "VERIFICATION_SUBJECT_BINDING_INVALID",
    ]);
  });

  it("encodes DSSE PAE deterministically", () => {
    expect(
      new TextDecoder().decode(
        dssePreAuthEncoding(
          "application/test",
          new TextEncoder().encode("payload"),
        ),
      ),
    ).toBe("DSSEv1 16 application/test 7 payload");
  });

  it("verifies both fixture signatures through the caller callback", async () => {
    for (const [claim, publicKey] of [
      [
        "result-evaluation/result-evaluation.dsse.json",
        "result-evaluation/public-key.pem",
      ],
      [
        "execution-verification/execution-verification.dsse.json",
        "execution-verification/public-key.pem",
      ],
    ] as const) {
      const bytes = await fixture(claim);
      const report = claim.startsWith("result")
        ? validateResultEvaluation(bytes)
        : validateExecutionVerification(bytes);
      const key = createPublicKey(await fixture(publicKey));

      const signatures = await verifyDsseSignatures(report.value!, (input) =>
        verify(null, input.preAuthEncoding, key, input.signature),
      );

      expect(signatures.verified).toBe(true);
      expect(signatures.signatures).toHaveLength(1);
    }
  });

  it("keeps signature failure separate from structural conformance", async () => {
    const report = validateResultEvaluation(
      await fixture("result-evaluation/result-evaluation.dsse.json"),
    );
    const signatures = await verifyDsseSignatures(report.value!, () => false);

    expect(report.conforms).toBe(true);
    expect(signatures.verified).toBe(false);
  });
});
