// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "vitest";

import {
  buildExecutionVerificationStatement,
  buildResultEvaluationStatement,
} from "./statement.js";
import type {
  PrepareExecutionVerificationInput,
  PrepareResultEvaluationInput,
} from "./types.js";

const digest = `sha256:${"a".repeat(64)}` as const;
const valid: PrepareResultEvaluationInput = {
  task: { name: "task", digest },
  results: [{ name: "result", digest }],
  evaluator: { id: "https://example.test/evaluator" },
  evaluatedAt: "2026-07-24T12:00:00Z",
  verdict: "pass",
};

describe("issuance input validation", () => {
  test.each([
    { ...valid, task: { name: "", digest } },
    { ...valid, task: { name: "task", digest: `sha256:${"A".repeat(64)}` } },
    { ...valid, task: { name: "task", digest: `sha256:${"a".repeat(63)}` } },
    { ...valid, task: { name: "task", digest: `sha256:${"a".repeat(65)}` } },
    { ...valid, task: { name: "task", digest: `sha256:${"g".repeat(64)}` } },
    { ...valid, results: [] },
    { ...valid, results: [{ name: "", digest }] },
    { ...valid, results: [{ name: "task", digest }] },
    { ...valid, evaluator: { id: "relative" } },
    { ...valid, evaluator: { id: "urn:bad space" } },
    { ...valid, evaluator: { id: "https://example.test/%ZZ" } },
    { ...valid, evaluator: { id: "https://example.test/\u0000" } },
    { ...valid, evaluatedAt: "2026-07-24T12:00:00" },
    { ...valid, explanation: "" },
    { ...valid, measurements: [{ name: "", value: 1 }] },
    { ...valid, evidence: [{ name: "", digest }] },
    { ...valid, verdict: "maybe" },
    { ...valid, statementExtensions: { subject: [] } },
    { ...valid, predicateExtensions: { verdict: "fail" } },
    { ...valid, evaluator: { id: "https://example.test/e", extensions: { id: "override" } } },
    { ...valid, task: { name: "task", digest, extensions: { digest: {} } } },
    { ...valid, task: { name: "task", digest, extensions: { content: "private" } } },
    {
      ...valid,
      evidence: [{
        name: "report",
        digest,
        extensions: { downloadLocation: "file:///private/report" },
      }],
    },
    { ...valid, measurements: [{ name: "score", value: 1, extensions: { value: 2 } }] },
    { ...valid, limitations: "not-an-array" },
    {
      ...valid,
      task: Object.assign(Object.create({ name: "inherited" }), { digest }),
    },
    { ...valid, statementExtensions: { sparse: Array(1) } },
    {
      ...valid,
      results: Object.assign([...valid.results], {
        "4294967295": { name: "not-an-index", digest },
      }),
    },
  ])("rejects invalid input before signing %#", (input) => {
    expect(() => buildResultEvaluationStatement(
      input as unknown as PrepareResultEvaluationInput,
    )).toThrow(expect.objectContaining({ code: "INVALID_ISSUANCE_INPUT" }));
  });

  test.each([
    "https://example.test/agents/[invalid]",
    "urn:jinn:agent:[invalid]",
  ])("rejects raw brackets outside an authority host: %s", (id) => {
    expect(() => buildResultEvaluationStatement({
      ...valid,
      evaluator: { id },
    })).toThrow(expect.objectContaining({ code: "INVALID_ISSUANCE_INPUT" }));
  });

  const verification: PrepareExecutionVerificationInput = {
    executionEvidenceDigest: digest,
    executionId: "urn:uuid:11111111-1111-4111-8111-111111111111",
    verifier: { id: "https://example.test/verifier" },
    verifiedAt: "2026-07-24T12:00:00Z",
    verdict: "verified",
  };

  test.each([
    { ...verification, executionId: "relative" },
    { ...verification, executionId: "https://example.test/unsafe\\path" },
    { ...verification, verifier: { id: "relative" } },
    { ...verification, verifiedAt: "2026-02-30T12:00:00Z" },
    { ...verification, verdict: "pass" },
    { ...verification, checks: [{ name: "", status: "pass" }] },
    { ...verification, checks: [{ name: "integrity", status: "maybe" }] },
    {
      ...verification,
      checks: [{ name: "integrity", status: "pass", extensions: { status: "fail" } }],
    },
    { ...verification, checks: "not-an-array" },
    {
      ...verification,
      verifier: Object.assign(
        Object.create({ id: "https://example.test/inherited" }),
        {},
      ),
    },
  ])("rejects invalid verification input %#", (input) => {
    expect(() => buildExecutionVerificationStatement(
      input as unknown as PrepareExecutionVerificationInput,
    )).toThrow(expect.objectContaining({ code: "INVALID_ISSUANCE_INPUT" }));
  });

  test("preserves schema-permitted empty optional strings", () => {
    const statement = buildResultEvaluationStatement({
      ...valid,
      task: { name: "task", digest, uri: "", mediaType: "" },
      measurements: [{ name: "score", value: 1, unit: "" }],
      limitations: [""],
    });
    expect(statement.subject[0]).toMatchObject({ uri: "", mediaType: "" });
    expect(statement.predicate.measurements).toEqual([{
      name: "score",
      value: 1,
      unit: "",
    }]);
    expect(statement.predicate.limitations).toEqual([""]);
  });

  test("rejects cyclic and unsafe extension values", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => buildResultEvaluationStatement({
      ...valid,
      statementExtensions: cyclic as never,
    })).toThrow(expect.objectContaining({ code: "INVALID_ISSUANCE_INPUT" }));
    expect(() => buildResultEvaluationStatement({
      ...valid,
      statementExtensions: new Date() as never,
    })).toThrow(expect.objectContaining({ code: "INVALID_ISSUANCE_INPUT" }));
  });
});
