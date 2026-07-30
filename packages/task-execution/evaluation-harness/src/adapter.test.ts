// SPDX-License-Identifier: Apache-2.0

import type { EvaluationSpec } from "@jinn-network/task-execution-profiles";
import type { AttemptIdentity } from "@jinn-network/task-execution-supervisor";
import { describe, expect, test } from "vitest";
import {
  EvaluationOperationalError,
  validateCompletedEvaluation,
  type EvaluatorAdapter,
  type ExactEvaluationMaterial,
} from "./adapter.js";

const digest = {
  sha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
} as const;

const task: ExactEvaluationMaterial = {
  descriptor: { name: "task.json", digest },
  bytes: new TextEncoder().encode("{}"),
};

const results: readonly ExactEvaluationMaterial[] = [{
  descriptor: { name: "result.patch", digest },
  bytes: new TextEncoder().encode("diff"),
}];

const attempt = {
  attemptUri: "urn:uuid:4e44d605-7a9f-4f30-9f0a-f7cac01cb935",
  nonce: "evaluation-nonce",
  attemptNumber: 1,
} as AttemptIdentity;

describe("EvaluatorAdapter", () => {
  test("returns one validated completed evaluation", async () => {
    const adapter: EvaluatorAdapter = {
      async evaluate(
        receivedTask,
        receivedResults,
        _specification,
        _context,
        receivedAttempt,
        signal,
      ) {
        expect(receivedTask).toBe(task);
        expect(receivedResults).toBe(results);
        expect(receivedAttempt).toBe(attempt);
        expect(signal.aborted).toBe(false);
        return {
          detailedOutcome: { testsPassed: 7, testsFailed: 0 },
          verdict: "pass",
          evaluatedAt: "2026-07-29T10:00:00.000Z",
          measurements: [{ name: "testsPassed", value: 7 }],
        };
      },
    };

    const completed = validateCompletedEvaluation(await adapter.evaluate(
      task,
      results,
      { family: "deterministic-process" } as EvaluationSpec,
      {},
      attempt,
      new AbortController().signal,
    ));

    expect(completed).toEqual({
      detailedOutcome: { testsPassed: 7, testsFailed: 0 },
      verdict: "pass",
      evaluatedAt: "2026-07-29T10:00:00.000Z",
      measurements: [{ name: "testsPassed", value: 7 }],
    });
  });

  test("keeps operational interruption on the typed failure path", async () => {
    const adapter: EvaluatorAdapter = {
      async evaluate() {
        throw new EvaluationOperationalError({
          canonicalCode: "UNAVAILABLE",
          reason: "provider-unavailable",
          recoveryAdvice: "new-attempt-required",
          safeDetail: "grader service unavailable",
        });
      },
    };

    await expect(adapter.evaluate(
      task,
      results,
      {} as EvaluationSpec,
      {},
      attempt,
      AbortSignal.abort(),
    )).rejects.toMatchObject({
      name: "EvaluationOperationalError",
      canonicalCode: "UNAVAILABLE",
      reason: "provider-unavailable",
      recoveryAdvice: "new-attempt-required",
    });
  });

  test.each([
    "subjects",
    "taskSubject",
    "resultSubjects",
    "evaluationSpecification",
    "evaluationMethod",
    "signer",
    "signingCapability",
    "repository",
    "publicationDestination",
  ])("rejects adapter authority override field %s", (field) => {
    expect(() => validateCompletedEvaluation({
      detailedOutcome: {},
      verdict: "pass",
      evaluatedAt: "2026-07-29T10:00:00.000Z",
      [field]: "attacker-controlled",
    })).toThrow(`CompletedEvaluation must not contain ${field}`);
  });
});
