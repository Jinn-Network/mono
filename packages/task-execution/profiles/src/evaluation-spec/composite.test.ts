import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadFixtureFamily, runStructuralCheck } from "../testing.js";
import { checkCompositeBounds, compositePropagation } from "./composite.js";
import type { CompositeBlock } from "./family-blocks.js";
import type { ResourceDescriptorLike } from "../resource-descriptor.js";

const familyDir = fileURLToPath(new URL("../../fixtures/composite", import.meta.url));

function checkBounds(input: unknown) {
  const { block, subSpecDepths } = input as { block: CompositeBlock; subSpecDepths: Record<string, number> };
  const resolveDepth = (ref: ResourceDescriptorLike) =>
    ref.uri !== undefined ? (subSpecDepths[ref.uri] ?? 0) : 0;
  const result = checkCompositeBounds(block, resolveDepth);
  return result.ok ? { ok: true as const } : { ok: false as const, code: result.code };
}

describe("composite bounds (depth <= 2, fan-out <= 32)", () => {
  it("passes every golden and adversarial fixture case", async () => {
    const cases = await loadFixtureFamily(familyDir);
    expect(cases.length).toBeGreaterThan(0);
    const results = runStructuralCheck(cases, checkBounds);
    for (const result of results) {
      expect(result, `${result.kind}/${result.case}: ${result.detail ?? ""}`).toMatchObject({ ok: true });
    }
  });
});

describe("composite propagation", () => {
  it("propagates infrastructure when any sub-spec is retryable-infrastructure", () => {
    expect(
      compositePropagation([{ verdict: "pass" }, { disposition: "retryable-infrastructure" }]),
    ).toEqual({ propagate: "infrastructure" });
  });

  it("defers to the composite's own verdictRule when no sub-spec is infrastructure", () => {
    expect(compositePropagation([{ verdict: "pass" }, { verdict: "fail" }])).toEqual({
      propagate: "verdict",
    });
  });
});
