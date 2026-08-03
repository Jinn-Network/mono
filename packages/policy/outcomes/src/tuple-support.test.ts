import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { ExecutionPolicyTuple } from "@jinn-network/policy-identity";
import { canonicalTupleText, denormalizeAxes, tupleDigest } from "./tuple-support.js";
import { PolicyOutcomesInputError } from "./schema.js";

/**
 * FINDING F-C2-1 (README "Findings"): `@jinn-network/policy-identity` ships only C1's kit at the
 * time this package was written -- no `canonicalTupleBytes`/`tupleDigest` export yet. This
 * package's local canonicalizer (`tuple-support.ts`) is therefore pinned for byte-for-byte parity
 * against C1's OWN committed golden fixtures, so drift from the substrate §4.1 step 5 rule would
 * be caught immediately, independent of whether C1's real implementation has landed yet.
 *
 * Resolved through Node's own module resolution (not a hardcoded `../../identity` path) so the
 * lookup works identically whether the portal resolves to the sibling source tree or to a
 * published `@jinn-network/policy-identity` install. The package's `exports` map publishes
 * `./fixtures/*` (not `./package.json`), so an actual fixture file anchors the resolution.
 */
const anchorFixture = createRequire(import.meta.url).resolve(
  "@jinn-network/policy-identity/fixtures/tuple/golden/all-axes.json",
);
const goldenDir = dirname(anchorFixture);

interface TupleFixture {
  readonly input: ExecutionPolicyTuple;
  readonly expect: { readonly canonical: string; readonly digest: string };
}

const goldenFixtures = readdirSync(goldenDir)
  .filter((name) => name.endsWith(".json"))
  .map((name) => [name, JSON.parse(readFileSync(join(goldenDir, name), "utf8")) as TupleFixture] as const);

describe("canonicalTupleText / tupleDigest: byte parity against C1's kit golden fixtures", () => {
  it.each(goldenFixtures)("%s", (_name, fixture) => {
    expect(canonicalTupleText(fixture.input)).toBe(fixture.expect.canonical);
    expect(tupleDigest(fixture.input)).toBe(fixture.expect.digest);
  });

  it("has at least the documented golden fixtures (guards against a silently-emptied directory)", () => {
    expect(goldenFixtures.length).toBeGreaterThanOrEqual(6);
  });
});

describe("assertValidTuple: fails closed on an omitted core axis (substrate §4.1 step 5)", () => {
  const base = {
    formatToken: "network.jinn.policy.execution-tuple/1.0",
    harness: null,
    model: null,
    loadout: null,
    isolationPolicy: "unrestricted",
  } as const;

  it("rejects a tuple missing a core axis key entirely", () => {
    const { harness: _dropped, ...withoutHarness } = base;
    expect(() => tupleDigest(withoutHarness as unknown as ExecutionPolicyTuple)).toThrow(
      PolicyOutcomesInputError,
    );
  });

  it("rejects a tuple whose core axis is explicitly undefined (would seal as omitted)", () => {
    expect(() => tupleDigest({ ...base, harness: undefined } as unknown as ExecutionPolicyTuple))
      .toThrow(PolicyOutcomesInputError);
  });

  it("rejects the wrong format token", () => {
    expect(() => tupleDigest({ ...base, formatToken: "wrong/1.0" } as ExecutionPolicyTuple))
      .toThrow(PolicyOutcomesInputError);
  });

  it("null and absent are non-collision: a null core axis is valid and distinct from omission", () => {
    expect(() => tupleDigest(base)).not.toThrow();
  });
});

describe("denormalizeAxes", () => {
  it("excludes formatToken (document metadata, not an axis -- design finding F4)", () => {
    const axes = denormalizeAxes(base());
    expect(Object.hasOwn(axes, "formatToken")).toBe(false);
  });

  it("preserves null core axes and extension axes", () => {
    const axes = denormalizeAxes(base());
    expect(axes).toEqual({
      harness: null,
      model: null,
      loadout: null,
      isolationPolicy: "unrestricted",
    });
  });

  function base(): ExecutionPolicyTuple {
    return {
      formatToken: "network.jinn.policy.execution-tuple/1.0",
      harness: null,
      model: null,
      loadout: null,
      isolationPolicy: "unrestricted",
    };
  }
});
