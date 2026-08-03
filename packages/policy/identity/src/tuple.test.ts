// SPDX-License-Identifier: MIT

/**
 * Tuple canonicalization conformance (substrate §4.1, §8).
 *
 * Everything under test is imported from `./conformance.js` — the single swap point. When C1's
 * implementation lands, this file does not change.
 */

import { describe, expect, it } from "vitest";

import {
  assertValidTuple,
  canonicalTupleBytes,
  canonicalTupleText,
  expressAsRunPinning,
  tupleDigest,
} from "./conformance.js";
import { loadFixtureDirectory, outcomeOf, readFixture } from "./fixtures.js";
import type { ExecutionPolicyTuple } from "./types.js";

const decoder = new TextDecoder("utf-8", { fatal: true });

describe("tuple canonicalization — golden", () => {
  for (const fixture of loadFixtureDirectory("tuple", "golden")) {
    const tuple = fixture.input as ExecutionPolicyTuple;
    const expected = fixture.expect as { canonical: string; digest: string; runPinning: unknown };

    it(`${fixture.name}: emits the expected canonical text`, () => {
      expect(canonicalTupleText(tuple)).toBe(expected.canonical);
    });

    it(`${fixture.name}: the canonical BYTES are the UTF-8 encoding of that text`, () => {
      expect(decoder.decode(canonicalTupleBytes(tuple))).toBe(expected.canonical);
    });

    it(`${fixture.name}: digests to the pinned sha256`, () => {
      expect(tupleDigest(tuple)).toBe(expected.digest);
    });

    it(`${fixture.name}: expresses back as the expected run pinning`, () => {
      expect(expressAsRunPinning(tuple)).toEqual(expected.runPinning);
    });

    it(`${fixture.name}: is idempotent — canonicalizing twice changes nothing`, () => {
      expect(canonicalTupleText(tuple)).toBe(canonicalTupleText(tuple));
    });
  }
});

describe("tuple canonicalization — adversarial", () => {
  for (const fixture of loadFixtureDirectory("tuple", "adversarial")) {
    const expected = fixture.expect as { ok: false; code: string; path: string };
    it(`${fixture.name}: fails closed with ${expected.code}`, () => {
      const outcome = outcomeOf(() => canonicalTupleBytes(fixture.input as ExecutionPolicyTuple));
      expect(outcome.ok).toBe(false);
      expect(outcome.code).toBe(expected.code);
      expect(outcome.path).toBe(expected.path);
    });
  }

  // JSON cannot spell `undefined`, so the runtime-only sibling of the omitted-core-axis case is
  // constructed here. It matters because canonicalization OMITS undefined object members: a
  // validator checking `'harness' in tuple` would pass this and then seal a tuple with no
  // harness member at all.
  it("undefined-core-axis: an explicitly-undefined core axis is rejected, not silently omitted", () => {
    const tuple = {
      formatToken: "network.jinn.policy.execution-tuple/1.0",
      harness: undefined,
      model: null,
      loadout: null,
      isolationPolicy: "unrestricted",
    } as unknown as ExecutionPolicyTuple;
    expect("harness" in tuple).toBe(true); // the naive presence check passes...
    const outcome = outcomeOf(() => canonicalTupleBytes(tuple)); // ...and this still refuses.
    expect(outcome).toEqual({ ok: false, code: "omitted-core-axis", path: "harness" });
  });
});

describe("key-order invariance (substrate §8)", () => {
  it("a permuted tuple produces byte-identical canonical output and the same digest", () => {
    const canonical = readFixture<{ input: ExecutionPolicyTuple; expect: { digest: string } }>(
      "tuple/golden/all-axes.json",
    );
    const permuted = readFixture<{ input: ExecutionPolicyTuple; expect: { digest: string } }>(
      "tuple/golden/key-order-variance.json",
    );

    // The two fixtures are genuinely different documents on disk...
    expect(JSON.stringify(canonical.input)).not.toBe(JSON.stringify(permuted.input));
    // ...and exactly one document after canonicalization.
    expect(canonicalTupleText(permuted.input)).toBe(canonicalTupleText(canonical.input));
    expect(tupleDigest(permuted.input)).toBe(tupleDigest(canonical.input));
    expect(canonical.expect.digest).toBe(permuted.expect.digest);
  });
});

describe("null-vs-absent non-collision (substrate §8)", () => {
  const fixture = readFixture<{
    nullForm: ExecutionPolicyTuple;
    absentForm: ExecutionPolicyTuple;
    expect: {
      nullCanonical: string;
      nullDigest: string;
      absentRejection: { code: string; path: string };
      rawCanonicalOfAbsentForm: string;
    };
  }>("tuple/demonstrations/null-vs-absent-non-collision.json");

  it("the null form seals to the pinned bytes and digest", () => {
    expect(canonicalTupleText(fixture.nullForm)).toBe(fixture.expect.nullCanonical);
    expect(tupleDigest(fixture.nullForm)).toBe(fixture.expect.nullDigest);
  });

  it("the absent form is REJECTED — omission is invalid input, not a second identity", () => {
    const outcome = outcomeOf(() => canonicalTupleBytes(fixture.absentForm));
    expect(outcome.ok).toBe(false);
    expect(outcome.code).toBe(fixture.expect.absentRejection.code);
    expect(outcome.path).toBe(fixture.expect.absentRejection.path);
  });

  it("null and absent are distinct byte sequences — which is what makes the rejection principled", () => {
    // Canonicalized without the tuple validator, the two forms differ: `"harness":null` is
    // present in one and in neither reading of the other. If they collided, rejecting absence
    // would be an arbitrary preference between two spellings of one document.
    expect(fixture.expect.nullCanonical).not.toBe(fixture.expect.rawCanonicalOfAbsentForm);
    expect(fixture.expect.nullCanonical).toContain('"harness":null');
    expect(fixture.expect.rawCanonicalOfAbsentForm).not.toContain('"harness"');
  });
});

describe("extension-key digest sensitivity (substrate §8)", () => {
  const fixture = readFixture<{
    withExtension: ExecutionPolicyTuple;
    stripped: ExecutionPolicyTuple;
    expect: { withExtensionDigest: string; strippedDigest: string };
  }>("tuple/demonstrations/extension-key-sensitivity.json");

  it("both forms are valid tuples — the point is that they are different identities", () => {
    expect(() => assertValidTuple(fixture.withExtension)).not.toThrow();
    expect(() => assertValidTuple(fixture.stripped)).not.toThrow();
  });

  it("stripping a profile-declared axis CHANGES the digest; byte identity is identity", () => {
    expect(tupleDigest(fixture.withExtension)).toBe(fixture.expect.withExtensionDigest);
    expect(tupleDigest(fixture.stripped)).toBe(fixture.expect.strippedDigest);
    expect(tupleDigest(fixture.withExtension)).not.toBe(tupleDigest(fixture.stripped));
  });
});

describe("digest substitution", () => {
  const fixture = readFixture<{ original: ExecutionPolicyTuple; substituted: ExecutionPolicyTuple }>(
    "tuple/demonstrations/digest-substitution.json",
  );

  it("two loadouts sharing a name but not a content digest are different policies", () => {
    expect((fixture.original["loadout"] as { name: string }).name).toBe(
      (fixture.substituted["loadout"] as { name: string }).name,
    );
    expect(tupleDigest(fixture.original)).not.toBe(tupleDigest(fixture.substituted));
  });
});

describe("expression rule (substrate §4.1, the inverse)", () => {
  it("round-trips: expressing a tuple as run pinning and re-deriving the axes is lossless", () => {
    const { input } = readFixture<{ input: ExecutionPolicyTuple }>("tuple/golden/all-axes.json");
    const pinning = expressAsRunPinning(input) as Record<string, unknown>;
    for (const [key, value] of Object.entries(input)) {
      if (key === "formatToken" || value === null) continue;
      expect(pinning[key]).toEqual(value);
    }
  });

  it("emits no entry for a null core axis, and never emits formatToken", () => {
    const { input } = readFixture<{ input: ExecutionPolicyTuple }>("tuple/golden/null-axes.json");
    const pinning = expressAsRunPinning(input) as Record<string, unknown>;
    expect(Object.keys(pinning).sort()).toEqual(["isolationPolicy"]);
    expect(pinning).not.toHaveProperty("formatToken");
  });
});
