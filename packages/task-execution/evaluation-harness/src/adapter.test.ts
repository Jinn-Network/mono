// SPDX-License-Identifier: Apache-2.0

import type { EvaluationSpec } from "@jinn-network/task-execution-profiles";
import type { AttemptIdentity } from "@jinn-network/task-execution-supervisor";
import { describe, expect, test } from "vitest";
import {
  EvaluationOperationalError,
  isEvaluationOperationalError,
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

// --- the dual-package hazard the brand exists to survive (#41 part c) -----------------
//
// A deployment module is imported by absolute URL and resolves its OWN copy of this
// package, so the `EvaluationOperationalError` an adapter throws is routinely a different
// class object than the one `runtime.ts` catches with. Live evidence, native gate round 25
// (2026-08-12): a prediction adapter threw with
// safeDetail "the evaluation context carries no resolutionSnapshot", the runtime's
// `instanceof` said no, and the operator's entire record of the refusal was
// `evaluation-harness: refused (evaluation-operational-failure)`.
//
// A distinct query string on the same specifier gives a genuinely separate module instance
// (Node caches by resolved URL) -- the same mechanism, reproduced in one process.
describe("EvaluationOperationalError recognition across separately-loaded copies", () => {
  test("instanceof fails on a second module instance's error while the brand still recognizes it", async () => {
    // Non-literal specifier: the query string is a module-cache key, not a path on disk, so it
    // must not be statically resolved.
    const specifier: string = "./adapter.js?dual-package-copy=1";
    const copy = await import(specifier) as {
      readonly EvaluationOperationalError: typeof EvaluationOperationalError;
    };
    const foreign = new copy.EvaluationOperationalError({
      canonicalCode: "UNAVAILABLE",
      reason: "provider-unavailable",
      recoveryAdvice: "new-attempt-required",
      safeDetail: "the evaluation context carries no resolutionSnapshot",
    });

    expect(copy.EvaluationOperationalError).not.toBe(EvaluationOperationalError);
    expect(foreign instanceof EvaluationOperationalError).toBe(false);
    expect(isEvaluationOperationalError(foreign)).toBe(true);
    expect(isEvaluationOperationalError(foreign) ? foreign.safeDetail : undefined)
      .toBe("the evaluation context carries no resolutionSnapshot");
  });

  test("refuses look-alikes that carry no brand", () => {
    expect(isEvaluationOperationalError(new Error("plain"))).toBe(false);
    expect(isEvaluationOperationalError({ safeDetail: "unbranded impostor" })).toBe(false);
    expect(isEvaluationOperationalError(undefined)).toBe(false);
    expect(isEvaluationOperationalError(null)).toBe(false);
  });
});
