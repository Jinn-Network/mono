import { describe, expect, test } from "vitest";
import { ERROR_RETRYABLE, TASK_EXECUTION_ERROR_CATEGORIES, isRetryable } from "./errors.js";

describe("TASK_EXECUTION_ERROR_CATEGORIES", () => {
  test("has exactly 16 categories matching §13 verbatim", () => {
    expect(TASK_EXECUTION_ERROR_CATEGORIES.length).toBe(16);
    expect([...TASK_EXECUTION_ERROR_CATEGORIES]).toEqual([
      "invalid-document",
      "unsupported-profile",
      "unsupported-requirement",
      "unsupported-capability",
      "invalid-reference",
      "content-corruption",
      "access-denied",
      "submission-conflict",
      "attempt-not-found",
      "dependency-unavailable",
      "backend-unavailable",
      "operation-aborted",
      "deadline-exceeded",
      "transport-failure",
      "result-unavailable",
      "protocol-violation",
    ]);
  });

  test("does not include a capacity/resource-exhausted category (coordinator mandate 5)", () => {
    expect(TASK_EXECUTION_ERROR_CATEGORIES).not.toContain("capacity-exhausted");
    expect(TASK_EXECUTION_ERROR_CATEGORIES).not.toContain("resource-exhausted");
    expect(TASK_EXECUTION_ERROR_CATEGORIES).not.toContain("capacity");
  });

  test("every category has a retryable flag and isRetryable matches the table", () => {
    for (const category of TASK_EXECUTION_ERROR_CATEGORIES) {
      expect(isRetryable(category)).toBe(ERROR_RETRYABLE[category]);
    }
  });
});
