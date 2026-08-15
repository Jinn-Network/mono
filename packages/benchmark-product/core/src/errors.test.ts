import { describe, expect, test } from "vitest";
import {
  BenchmarkProductError,
  refuse,
  refuseWithIssues,
  toErrorEnvelope,
  type ProductErrorCode,
} from "./errors.js";

describe("BenchmarkProductError", () => {
  test("carries a code, a message, and structured issues", () => {
    const error = new BenchmarkProductError("validation", "draft is invalid", [
      { path: "spec.name", message: "must be a non-empty string" },
    ]);
    expect(error.code).toBe("validation");
    expect(error.message).toBe("draft is invalid");
    expect(error.issues).toEqual([{ path: "spec.name", message: "must be a non-empty string" }]);
    expect(error.name).toBe("BenchmarkProductError");
    expect(error).toBeInstanceOf(Error);
  });

  test("refuse throws a typed error with a single issue", () => {
    let caught: unknown;
    try {
      refuse("not-found", "drafts/missing", "no draft with this id");
    } catch (cause) {
      caught = cause;
    }
    expect(caught).toBeInstanceOf(BenchmarkProductError);
    const error = caught as BenchmarkProductError;
    expect(error.code).toBe("not-found");
    expect(error.issues).toEqual([{ path: "drafts/missing", message: "no draft with this id" }]);
  });

  test("refuseWithIssues throws with every issue retained", () => {
    const issues = [
      { path: "spec.arms.0.armId", message: "invalid arm id" },
      { path: "spec.policy.cellWindowMs", message: "must be a positive integer" },
    ];
    let caught: unknown;
    try {
      refuseWithIssues("validation", issues);
    } catch (cause) {
      caught = cause;
    }
    const error = caught as BenchmarkProductError;
    expect(error.code).toBe("validation");
    expect(error.issues).toEqual(issues);
  });
});

describe("toErrorEnvelope", () => {
  test("a typed error becomes a machine-readable envelope", () => {
    const error = new BenchmarkProductError("authority-denied", "principal holds no lock grant", [
      { path: "principals.agent-1", message: "grant missing: lock" },
    ]);
    expect(toErrorEnvelope(error)).toEqual({
      code: "authority-denied",
      detail: "principal holds no lock grant",
      issues: [{ path: "principals.agent-1", message: "grant missing: lock" }],
    });
  });

  test("an untyped throw is carried as an execution envelope, never swallowed", () => {
    expect(toErrorEnvelope(new Error("disk on fire"))).toEqual({
      code: "execution",
      detail: "disk on fire",
    });
    expect(toErrorEnvelope("plain string")).toEqual({
      code: "execution",
      detail: "plain string",
    });
  });

  test("the v1 code set covers the spec §4.3 categories as refined by A8", () => {
    // Compile-time coverage: each of these must be assignable to ProductErrorCode.
    const codes: ProductErrorCode[] = [
      "validation",
      "illegal-transition",
      "authority-denied",
      "record-integrity",
      "journal-integrity",
      "not-found",
      "conflict",
      "invalid-invocation",
      "venue-unavailable",
      "venue-unverifiable",
      "execution",
    ];
    expect(new Set(codes).size).toBe(codes.length);
  });
});
