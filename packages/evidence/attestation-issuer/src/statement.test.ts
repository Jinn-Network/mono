// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "vitest";

import {
  buildExecutionVerificationStatement,
  buildResultEvaluationStatement,
} from "./statement.js";

const digest = `sha256:${"a".repeat(64)}` as const;

describe("typed Statement builders", () => {
  test("builds Task-first Result Evaluation subjects and bindings", () => {
    const statement = buildResultEvaluationStatement({
      task: { name: "task.md", digest },
      results: [{ name: "result.patch", digest }, { name: "report.txt", digest }],
      evaluator: { id: "https://example.test/agents/evaluator" },
      evaluatedAt: "2026-07-24T12:00:00Z",
      verdict: "pass",
      explanation: "The exact Results satisfy the rubric.",
    });
    expect(statement).toMatchObject({
      _type: "https://in-toto.io/Statement/v1",
      predicateType: "https://spec.jinn.network/attestations/result-evaluation/v1",
      subject: [
        { name: "task.md", digest: { sha256: "a".repeat(64) } },
        { name: "result.patch", digest: { sha256: "a".repeat(64) } },
        { name: "report.txt", digest: { sha256: "a".repeat(64) } },
      ],
      predicate: {
        evaluator: { id: "https://example.test/agents/evaluator" },
        evaluatedAt: "2026-07-24T12:00:00Z",
        taskSubject: "task.md",
        resultSubjects: ["result.patch", "report.txt"],
        verdict: "pass",
      },
    });
  });

  test("builds the fixed Execution Evidence subject", () => {
    const statement = buildExecutionVerificationStatement({
      executionEvidenceDigest: digest,
      executionId: "urn:uuid:11111111-1111-4111-8111-111111111111",
      verifier: { id: "https://example.test/agents/verifier" },
      verifiedAt: "2026-07-24T12:01:00Z",
      verdict: "verified",
    });
    expect(statement).toMatchObject({
      predicateType: "https://spec.jinn.network/attestations/execution-verification/v1",
      subject: [{ name: "ro-crate-metadata.json", digest: { sha256: "a".repeat(64) } }],
      predicate: {
        executionId: "urn:uuid:11111111-1111-4111-8111-111111111111",
        verifier: { id: "https://example.test/agents/verifier" },
        verifiedAt: "2026-07-24T12:01:00Z",
        verdict: "verified",
      },
    });
  });

  test("preserves complete optional verification support and extensions", () => {
    const statement = buildExecutionVerificationStatement({
      executionEvidenceDigest: digest,
      executionId: "urn:uuid:11111111-1111-4111-8111-111111111111",
      verifier: {
        id: "https://example.test/agents/verifier",
        extensions: { team: "audit" },
      },
      verifiedAt: "2026-07-24T12:01:00Z",
      verdict: "inconclusive",
      verificationPolicy: { name: "policy", digest },
      verificationMethod: { name: "method", digest },
      checks: [{
        name: "trace",
        status: "unknown",
        explanation: "The trace was incomplete.",
        evidence: [{ name: "trace.jsonl", digest }],
        annotations: { severity: "high" },
        extensions: { control: "TRACE-1" },
      }],
      explanation: "More evidence is required.",
      limitations: ["Private environment"],
      supersedes: [{ name: "older-verification", digest }],
      disputes: [{ name: "dispute", digest }],
      statementExtensions: { statementProfile: "fixture" },
      predicateExtensions: { verifierProfile: "base" },
    });
    expect(statement).toMatchObject({
      statementProfile: "fixture",
      predicate: {
        verifierProfile: "base",
        verifier: { team: "audit" },
        verificationPolicy: { name: "policy" },
        verificationMethod: { name: "method" },
        checks: [{
          name: "trace",
          evidence: [{ name: "trace.jsonl" }],
          control: "TRACE-1",
        }],
        explanation: "More evidence is required.",
        limitations: ["Private environment"],
        supersedes: [{ name: "older-verification" }],
        disputes: [{ name: "dispute" }],
      },
    });
  });

  test("preserves optional support and extensions", () => {
    const statement = buildResultEvaluationStatement({
      task: { name: "task", digest, extensions: { customResource: true } },
      results: [{ name: "result", digest }],
      evaluator: { id: "https://example.test/evaluator", extensions: { role: "reviewer" } },
      evaluatedAt: "2026-07-24T12:00:00Z",
      verdict: "inconclusive",
      measurements: [{ name: "score", value: 0.5, extensions: { scale: 1 } }],
      evidence: [{ name: "report", digest }],
      supersedes: [{ name: "old", digest }],
      disputes: [{ name: "dispute", digest }],
      predicateExtensions: { profile: "synthetic" },
      statementExtensions: { statementNote: true },
    });
    expect(statement).toMatchObject({
      statementNote: true,
      predicate: {
        profile: "synthetic",
        evaluator: { role: "reviewer" },
        measurements: [{ scale: 1 }],
        evidence: [{ name: "report" }],
        supersedes: [{ name: "old" }],
        disputes: [{ name: "dispute" }],
      },
    });
    expect(statement.subject[0]).toMatchObject({ customResource: true });
  });
});
