import { describe, expect, test } from "vitest";
import { projectPublishErrorForGui } from "./gui-error";

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
