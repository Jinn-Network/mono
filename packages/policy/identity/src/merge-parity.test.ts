// SPDX-License-Identifier: MIT

/**
 * FINDING F2's fixture (see README) — the core-key comparison-class disagreement.
 *
 * Substrate §4.1 step 1 says "the profiles §5.1 comparison classes (`mergeRequirements`
 * semantics)" without pinning the core-axis class map. The two shipped venues disagree:
 *
 *   marketplace  (`packages/marketplace/binding/src/capabilities.ts`)
 *     harness: constraint, model: constraint, isolationPolicy: constraint, loadout: addable
 *   local backend (`packages/task-execution/backend-local/assembly/src/backend.ts`)
 *     harness: exact,      model: constraint, loadout: exact,               isolationPolicy: exact
 *
 * Read naively that is a fork in the derivation: the same pair could derive at one venue and be
 * refused at the other. This suite establishes the actual scope of the divergence rather than
 * asserting a hunch — because a finding that says "these two files differ" is a diff, and a
 * finding that says "and here is exactly what that costs" is information.
 */

import { describe, expect, it } from "vitest";

import { canonicalTupleText, deriveExecutionTuple } from "./conformance.js";
import {
  CORE_KEY_CLASSES,
  LOCAL_BACKEND_CORE_KEY_CLASSES,
  mergeRequirementsNaive,
} from "../fixtures/reference/merge.js";
import { loadFixtureDirectory } from "./fixtures.js";
import type { ResolvedTaskProfile, SealedSubmissionDoc, SealedTaskDoc } from "./types.js";

interface DerivationFixture {
  readonly name: string;
  readonly profile: ResolvedTaskProfile;
  readonly task: SealedTaskDoc;
  readonly submission: SealedSubmissionDoc;
}

const golden = loadFixtureDirectory("derivation", "golden") as unknown as DerivationFixture[];

describe("core-key class maps agree on every derivation fixture", () => {
  for (const fixture of golden) {
    it(`${fixture.name}: the marketplace and local-backend maps yield identical effective requirements`, () => {
      const profileClasses = Object.fromEntries(
        fixture.profile.requirementKeys.map((entry) => [entry.key, entry.comparisonClass]),
      );
      const underMarketplace = mergeRequirementsNaive(
        fixture.task.requirements,
        fixture.submission.requirements,
        { ...CORE_KEY_CLASSES, ...profileClasses },
      );
      const underLocal = mergeRequirementsNaive(
        fixture.task.requirements,
        fixture.submission.requirements,
        { ...LOCAL_BACKEND_CORE_KEY_CLASSES, ...profileClasses },
      );
      expect(underLocal).toEqual(underMarketplace);
    });
  }
});

describe("why the disagreement is behaviorally inert on the core four (F2's evidence)", () => {
  const bothPresent = { harness: { id: "claude-code", version: "2.1.34" } };

  it("every class the two maps disagree on collapses to byte-equality for these keys", () => {
    // `exact` compares byte-equality by definition. `constraint` consults a per-key membership
    // registry that registers ONLY `model` (protocol's `CONSTRAINT_MEMBERSHIP`), so for
    // `harness`/`loadout`/`isolationPolicy` it falls through to the conservative byte-equality
    // default. `addable`'s relation applies only when the key is absent from the Task — present
    // in both, it is the same conservative default. Three names, one behavior.
    for (const classMap of [CORE_KEY_CLASSES, LOCAL_BACKEND_CORE_KEY_CLASSES]) {
      expect(mergeRequirementsNaive(bothPresent, bothPresent, classMap)).toEqual({
        ok: true,
        effective: bothPresent,
      });
      expect(
        mergeRequirementsNaive(bothPresent, { harness: { id: "codex", version: "0.9.0" } }, classMap),
      ).toEqual({ ok: false, key: "harness", category: "invalid-document" });
    }
  });

  it("`model` — the one key with a real membership test — is `constraint` in BOTH maps", () => {
    // This is the load-bearing half of the finding. The maps differ on three keys where the
    // class name has no behavioral consequence, and AGREE on the single key where it does.
    expect(CORE_KEY_CLASSES["model"]).toBe("constraint");
    expect(LOCAL_BACKEND_CORE_KEY_CLASSES["model"]).toBe("constraint");
  });

  it("on every successful merge branch the winning value is the Submission's, so bytes cannot fork", () => {
    const task = { model: { provider: "anthropic" } };
    const submission = { model: { provider: "anthropic", id: "claude-haiku-4-5" } };
    for (const classMap of [CORE_KEY_CLASSES, LOCAL_BACKEND_CORE_KEY_CLASSES]) {
      const merged = mergeRequirementsNaive(task, submission, classMap);
      expect(merged).toEqual({ ok: true, effective: submission });
    }
  });

  it("the tripwire: if a future release registers a membership test for another core key, this fails", () => {
    // Today `harness: {id}` vs `harness: {id, version}` is refused under every class. The day a
    // `harness` membership test is registered, `constraint` would admit it and `exact` would
    // not — and the two venues WOULD fork. This assertion is the alarm for that day.
    const taskPin = { harness: { id: "claude-code" } };
    const submissionPin = { harness: { id: "claude-code", version: "2.1.34" } };
    for (const classMap of [CORE_KEY_CLASSES, LOCAL_BACKEND_CORE_KEY_CLASSES]) {
      expect(mergeRequirementsNaive(taskPin, submissionPin, classMap).ok).toBe(false);
    }
  });
});

describe("the derivation itself is stable under the class-map choice", () => {
  it("equivalence-primary derives identical bytes regardless of which venue's map is used", () => {
    const fixture = golden.find((entry) => entry.name === "equivalence-primary");
    if (fixture === undefined) throw new Error("equivalence-primary fixture is missing");
    // The reference deriver pins the marketplace map internally; this asserts the merge stage —
    // the only stage the map touches — produces the same effective requirements either way, so
    // the derived bytes cannot depend on the choice.
    const profileClasses = Object.fromEntries(
      fixture.profile.requirementKeys.map((entry) => [entry.key, entry.comparisonClass]),
    );
    expect(
      mergeRequirementsNaive(fixture.task.requirements, fixture.submission.requirements, {
        ...LOCAL_BACKEND_CORE_KEY_CLASSES,
        ...profileClasses,
      }),
    ).toEqual(
      mergeRequirementsNaive(fixture.task.requirements, fixture.submission.requirements, {
        ...CORE_KEY_CLASSES,
        ...profileClasses,
      }),
    );
    expect(canonicalTupleText(deriveExecutionTuple(fixture.task, fixture.submission, fixture.profile)))
      .toContain('"harness"');
  });
});
