import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import * as identity from "@jinn-network/policy-identity";
import type { ExecutionPolicyTuple } from "@jinn-network/policy-identity";
import { canonicalTupleBytes, canonicalTupleText, denormalizeAxes, tupleDigest } from "./index.js";

/**
 * F-C2-1 closure (README "Findings"): `@jinn-network/policy-identity` now exports the real
 * `canonicalTupleBytes`/`canonicalTupleText`/`tupleDigest` (program §1 C1 "Produces"), so
 * `tuple-support.ts`'s local reimplementation is deleted and this package's public surface
 * re-exports identity's functions directly (`src/index.ts`). The exhaustive canonicalization
 * adversarial suite (omitted axes, key ordering, extension keys, negative zero, unpaired
 * surrogates, ...) now lives entirely in `packages/policy/identity`'s own 229-test conformance
 * kit -- re-asserting it here would be redundant with, not additive to, that suite.
 *
 * What stays here is the cross-package smoke assertion: that this package's re-exports really ARE
 * identity's implementation (not a reintroduced local copy that happens to agree today), checked
 * both by reference identity and by output parity against a sample of identity's own golden
 * fixtures.
 */
describe("F-C2-1 closure: canonicalTupleBytes/canonicalTupleText/tupleDigest are identity's own functions", () => {
  it("re-exports the exact same function references, not lookalikes", () => {
    expect(tupleDigest).toBe(identity.tupleDigest);
    expect(canonicalTupleBytes).toBe(identity.canonicalTupleBytes);
    expect(canonicalTupleText).toBe(identity.canonicalTupleText);
  });

  it("agrees with a sample of identity's own golden tuple fixtures (belt-and-suspenders)", () => {
    const anchorFixture = createRequire(import.meta.url).resolve(
      "@jinn-network/policy-identity/fixtures/tuple/golden/all-axes.json",
    );
    const goldenDir = dirname(anchorFixture);
    const names = readdirSync(goldenDir).filter((name) => name.endsWith(".json"));
    expect(names.length).toBeGreaterThanOrEqual(6);
    for (const name of names) {
      const fixture = JSON.parse(readFileSync(join(goldenDir, name), "utf8")) as {
        input: ExecutionPolicyTuple;
        expect: { canonical: string; digest: string };
      };
      expect(canonicalTupleText(fixture.input)).toBe(fixture.expect.canonical);
      expect(tupleDigest(fixture.input)).toBe(fixture.expect.digest);
    }
  });
});

describe("denormalizeAxes (outcomes-specific row-shaping; no identity counterpart)", () => {
  function tuple(): ExecutionPolicyTuple {
    return {
      formatToken: "network.jinn.policy.execution-tuple/1.0",
      harness: null,
      model: null,
      loadout: null,
      isolationPolicy: "unrestricted",
    };
  }

  it("excludes formatToken (document metadata, not an axis -- design finding F4)", () => {
    const axes = denormalizeAxes(tuple());
    expect(Object.hasOwn(axes, "formatToken")).toBe(false);
  });

  it("preserves null core axes and orders keys by UTF-16 code unit", () => {
    const axes = denormalizeAxes(tuple());
    expect(Object.keys(axes)).toEqual(["harness", "isolationPolicy", "loadout", "model"]);
    expect(axes).toEqual({
      harness: null,
      model: null,
      loadout: null,
      isolationPolicy: "unrestricted",
    });
  });

  it("fails closed on an invalid tuple, delegating to identity's own assertValidTuple", () => {
    const { harness: _dropped, ...withoutHarness } = tuple();
    expect(() => denormalizeAxes(withoutHarness as unknown as ExecutionPolicyTuple)).toThrow();
  });
});
