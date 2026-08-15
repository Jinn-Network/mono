import type { ResourceDescriptorLike } from "../resource-descriptor.js";
import type { CompositeBlock } from "./family-blocks.js";

/** Composite bounds (frozen, §7.1): depth ≤ 2, fan-out ≤ 32. */
export const COMPOSITE_MAX_DEPTH = 2;
export const COMPOSITE_MAX_FANOUT = 32;

export type CompositeBoundsResult =
  | { ok: true }
  | { ok: false; code: "invalid-document"; reason: string };

/**
 * Checks a composite block's fan-out directly and its depth via an injected `resolveDepth`
 * (the depth of the sub-tree rooted at a referenced spec, 0 for a leaf spec) — digest references
 * preclude cycles, so `resolveDepth` never needs to detect one itself.
 */
export function checkCompositeBounds(
  block: CompositeBlock,
  resolveDepth: (ref: ResourceDescriptorLike) => number,
): CompositeBoundsResult {
  if (block.subSpecs.length > COMPOSITE_MAX_FANOUT) {
    return {
      ok: false,
      code: "invalid-document",
      reason: `composite fan-out ${block.subSpecs.length} exceeds the maximum of ${COMPOSITE_MAX_FANOUT}`,
    };
  }
  const depth = 1 + block.subSpecs.reduce((max, sub) => Math.max(max, resolveDepth(sub.spec)), 0);
  if (depth > COMPOSITE_MAX_DEPTH) {
    return {
      ok: false,
      code: "invalid-document",
      reason: `composite depth ${depth} exceeds the maximum of ${COMPOSITE_MAX_DEPTH}`,
    };
  }
  return { ok: true };
}

/**
 * A composite sub-spec's own evaluation outcome, as far as propagation cares: either it landed
 * on a `retryable-infrastructure` unscorable disposition, or it produced an ordinary verdict.
 */
export type SubSpecOutcome =
  | { disposition: "retryable-infrastructure" }
  | { verdict: "pass" | "fail" | "inconclusive" };

export type CompositePropagationResult =
  // Any sub-spec landing on `retryable-infrastructure` makes the whole composite infrastructure
  // — the composite's own verdictRule never runs.
  | { propagate: "infrastructure" }
  // No sub-spec was infrastructure; the composite's own verdictRule decides pass/fail/
  // inconclusive over the aggregated measurements (outside this function's concern).
  | { propagate: "verdict" };

export function compositePropagation(subOutcomes: SubSpecOutcome[]): CompositePropagationResult {
  const anyInfrastructure = subOutcomes.some(
    (sub) => "disposition" in sub && sub.disposition === "retryable-infrastructure",
  );
  return anyInfrastructure ? { propagate: "infrastructure" } : { propagate: "verdict" };
}
