// SPDX-License-Identifier: Apache-2.0

import { readFile } from "node:fs/promises";

import {
  validateExecutionVerification,
  validateResultEvaluation,
} from "@jinn-network/evidence-protocol";
import { describe, expect, test } from "vitest";

import {
  prepareExecutionVerification,
  prepareResultEvaluation,
} from "./prepare.js";
import { parsePreparedAttestation } from "./prepared.js";
import type { DsseSigner } from "./types.js";

const d = (character: string) =>
  `sha256:${character.repeat(64)}` as `sha256:${string}`;
const signer: DsseSigner = async () => [{
  keyid: "issuer-contract-fixture-key",
  signature: new Uint8Array([
    0, 1, 2, 3, 4, 5, 6, 7,
    8, 9, 10, 11, 12, 13, 14, 15,
  ]),
}];
const fixture = (name: string) =>
  new URL(`../fixtures/issuer-contract-v1/${name}`, import.meta.url);

describe("issuer contract fixtures", () => {
  test("regenerates and validates Result Evaluation bytes", async () => {
    const bytes = await readFile(fixture("result-evaluation.json"));
    const expected = JSON.parse(await readFile(fixture("expected-digests.json"), "utf8"));
    const parsed = parsePreparedAttestation(bytes);
    expect(parsed).toMatchObject({
      family: "result-evaluation",
      recordDigest: expected["result-evaluation.json"],
    });
    expect(validateResultEvaluation(bytes).conforms).toBe(true);
    const regenerated = await prepareResultEvaluation({
      task: { name: "task.md", digest: d("a") },
      results: [
        { name: "result.patch", digest: d("b") },
        { name: "report.txt", digest: d("c") },
      ],
      evaluator: {
        id: "https://example.test/agents/evaluator",
        extensions: { role: "fixture" },
      },
      evaluatedAt: "2026-07-24T12:00:00Z",
      verdict: "pass",
      evaluationSpecification: { name: "rubric.json", digest: d("d") },
      evaluationMethod: { name: "method.md", digest: d("e") },
      measurements: [{
        name: "score",
        value: 1,
        unit: "ratio",
        annotations: { synthetic: true },
      }],
      evidence: [{
        name: "report.json",
        digest: d("f"),
        mediaType: "application/json",
      }],
      explanation: "Synthetic fixture evaluation.",
      limitations: ["Serialization fixture only."],
      supersedes: [{ name: "older-evaluation.json", digest: d("1") }],
      disputes: [{ name: "dispute.json", digest: d("2") }],
      statementExtensions: { fixtureVersion: 1 },
      predicateExtensions: { fixturePurpose: "serialization" },
    }, signer);
    expect(regenerated.envelopeBytes).toEqual(Uint8Array.from(bytes));
  });

  test("regenerates and validates Execution Verification bytes", async () => {
    const bytes = await readFile(fixture("execution-verification.json"));
    const expected = JSON.parse(await readFile(fixture("expected-digests.json"), "utf8"));
    const parsed = parsePreparedAttestation(bytes);
    expect(parsed).toMatchObject({
      family: "execution-verification",
      recordDigest: expected["execution-verification.json"],
    });
    expect(validateExecutionVerification(bytes).conforms).toBe(true);
    const regenerated = await prepareExecutionVerification({
      executionEvidenceDigest: d("3"),
      executionId: "urn:uuid:11111111-1111-4111-8111-111111111111",
      verifier: {
        id: "https://example.test/agents/verifier",
        extensions: { role: "fixture" },
      },
      verifiedAt: "2026-07-24T12:00:00Z",
      verdict: "verified",
      verificationPolicy: { name: "policy.json", digest: d("4") },
      verificationMethod: { name: "method.md", digest: d("5") },
      checks: [{
        name: "trace-integrity",
        status: "pass",
        explanation: "Synthetic fixture check.",
        evidence: [{ name: "trace.jsonl", digest: d("6") }],
        annotations: { synthetic: true },
        extensions: { control: "TRACE-1" },
      }],
      explanation: "Synthetic fixture verification.",
      limitations: ["Serialization fixture only."],
      supersedes: [{ name: "older-verification.json", digest: d("7") }],
      disputes: [{ name: "dispute.json", digest: d("8") }],
      statementExtensions: { fixtureVersion: 1 },
      predicateExtensions: { fixturePurpose: "serialization" },
    }, signer);
    expect(regenerated.envelopeBytes).toEqual(Uint8Array.from(bytes));
  });
});
