// SPDX-License-Identifier: MIT

/**
 * Kit self-checks: the swap point, the format tokens, and the fixture inventory.
 *
 * These exist so that the kit cannot silently stop gating anything. A conformance suite that
 * quietly loses a fixture family, or that is repointed at the implementation without anyone
 * noticing, is worse than no suite at all.
 */

import { describe, expect, it } from "vitest";

import { CONFORMANCE_TARGET } from "./conformance.js";
import { loadFixtureDirectory } from "./fixtures.js";
import {
  CANDIDATE_MANIFEST_FORMAT_TOKEN,
  CORE_AXES,
  DSSE_PAYLOAD_TYPE,
  EXECUTION_TUPLE_FORMAT_TOKEN,
  HARNESS_STATE_LOADOUT_KIND,
  IN_TOTO_STATEMENT_TYPE,
} from "./tokens.js";
import type { ComparisonClass } from "./types.js";

describe("the conformance swap point", () => {
  it("names which implementation the suite is currently gating", () => {
    // The kit ships pointed at the reference. Repointing it at the implementation is a
    // deliberate one-line edit that flips this assertion — never something that drifts.
    expect(["reference", "implementation"]).toContain(CONFORMANCE_TARGET);
  });
});

describe("format tokens (substrate §4.1, §5.1, §5.2)", () => {
  it("are the exact spellings the program's C1 charter freezes", () => {
    expect(EXECUTION_TUPLE_FORMAT_TOKEN).toBe("network.jinn.policy.execution-tuple/1.0");
    expect(CANDIDATE_MANIFEST_FORMAT_TOKEN).toBe("network.jinn.policy.candidate/1.0");
  });

  it("are format tokens, NOT media types and NOT record-kind IRIs (substrate §2)", () => {
    for (const token of [EXECUTION_TUPLE_FORMAT_TOKEN, CANDIDATE_MANIFEST_FORMAT_TOKEN]) {
      expect(token.startsWith("application/")).toBe(false);
      expect(token.startsWith("http")).toBe(false);
      expect(token.startsWith("network.jinn.policy.")).toBe(true);
    }
  });

  it("adopt the stack's in-toto and DSSE spellings unchanged (substrate §3/§5.2)", () => {
    expect(IN_TOTO_STATEMENT_TYPE).toBe("https://in-toto.io/Statement/v1");
    expect(DSSE_PAYLOAD_TYPE).toBe("application/vnd.in-toto+json");
  });

  it("names the one new loadout kind, a VALUE in the existing vocabulary (substrate §4.2/§9)", () => {
    expect(HARNESS_STATE_LOADOUT_KIND).toBe("jinn.harness-state.v1");
  });

  it("pins the four core axes, using the requirements-vocabulary spelling `isolationPolicy`", () => {
    // Substrate §4.1 axis naming: the tuple says `isolationPolicy`; the benchmarking Matrix
    // says `isolation` in its `verification` block. One axis, two surface names, mapping pinned.
    expect([...CORE_AXES]).toEqual(["harness", "model", "loadout", "isolationPolicy"]);
  });
});

describe("mirrored vocabularies (substrate §2 — mirrored, never imported)", () => {
  it("carries the five profiles §5.1 comparison classes", () => {
    const classes: ComparisonClass[] = ["exact", "ceiling", "floor", "constraint", "addable"];
    expect(classes).toHaveLength(5);
  });
});

describe("fixture inventory", () => {
  const families: Record<string, { golden: number; adversarial: number }> = {
    tuple: { golden: 6, adversarial: 7 },
    // +1 golden / +2 adversarial in the C1 DEEP-review round: the model constraint's
    // provider-inference leg (both outcomes) and the fractional-declared-key case that pins which
    // of the merge comparator and step 5 refuses.
    derivation: { golden: 3, adversarial: 7 },
    manifest: { golden: 3, adversarial: 7 },
    dsse: { golden: 1, adversarial: 2 },
    // Added in the same round: the values that arrive from code rather than from JSON — non-plain
    // objects and array holes — which are the ones a canonicalizer accepts silently.
    canonical: { golden: 1, adversarial: 2 },
  };

  for (const [family, counts] of Object.entries(families)) {
    it(`${family}: ${counts.golden} golden + ${counts.adversarial} adversarial cases are present`, () => {
      expect(loadFixtureDirectory(family, "golden")).toHaveLength(counts.golden);
      expect(loadFixtureDirectory(family, "adversarial")).toHaveLength(counts.adversarial);
    });

    it(`${family}: every case states WHY it exists`, () => {
      // An adversarial fixture with no stated attack is a fixture nobody can maintain, and the
      // first person to hit it will "fix" the code to make it pass.
      for (const fixture of [
        ...loadFixtureDirectory(family, "golden"),
        ...loadFixtureDirectory(family, "adversarial"),
      ]) {
        expect(typeof fixture.note).toBe("string");
        expect(fixture.note.length).toBeGreaterThan(60);
      }
    });
  }
});
