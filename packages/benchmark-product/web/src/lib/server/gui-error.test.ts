import { describe, expect, test } from "vitest";
import type { ProductErrorCode } from "@colophon-claims/core";
import { projectProductErrorForGui, projectPublishErrorForGui } from "./gui-error";

const PRODUCT_ERROR_CODES: readonly ProductErrorCode[] = [
  "validation", "illegal-transition", "authority-denied", "record-integrity",
  "journal-integrity", "not-found", "conflict", "invalid-invocation",
  "venue-unavailable", "venue-unverifiable", "execution",
];

describe("general browser error projection", () => {
  test.each(PRODUCT_ERROR_CODES)("%s never carries attacker-controlled detail or issue text", (code) => {
    const sentinel = "/private/BP50_SECRET_SENTINEL/signing-key.pem";
    const projected = projectProductErrorForGui({
      code,
      detail: sentinel,
      issues: [{ path: sentinel, message: sentinel }],
    });
    expect(projected.code).toBe(code);
    expect(JSON.stringify(projected)).not.toContain(sentinel);
    expect(projected.detail.length).toBeGreaterThan(0);
    expect(projected.issues?.[0]).toEqual({
      path: "operation.input",
      message: "The server rejected this field or boundary.",
    });
  });
});

describe("publish error projection", () => {
  test("retains the typed refusal but removes absolute target paths from every browser field", () => {
    const privatePath = "/Users/operator/private-benchmark/artifacts/draft-1/public-bundles/deadbeef";
    const projected = projectPublishErrorForGui({
      code: "conflict",
      detail: `a different immutable bundle exists at ${privatePath}`,
      issues: [{ path: privatePath, message: `refusing to overwrite ${privatePath}` }],
    });
    expect(projected.code).toBe("conflict");
    expect(projected.issues?.[0]?.path).toBe("publish.target");
    expect(JSON.stringify(projected)).not.toContain(privatePath);
    expect(JSON.stringify(projected)).not.toContain("/Users/");
  });
});
