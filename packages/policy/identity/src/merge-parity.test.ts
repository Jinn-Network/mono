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

import { mergeRequirements } from "@jinn-network/task-execution-protocol";

import { canonicalTupleText, deriveExecutionTuple } from "./conformance.js";
import {
  CORE_KEY_CLASSES,
  LOCAL_BACKEND_CORE_KEY_CLASSES,
  mergeRequirementsNaive,
} from "../fixtures/reference/merge.js";
import { mergeEffectiveRequirements } from "./merge.js";
import { loadFixtureDirectory } from "./fixtures.js";
import type { ComparisonClass, JsonValue, ResolvedTaskProfile, SealedSubmissionDoc, SealedTaskDoc } from "./types.js";

interface DerivationFixture {
  readonly name: string;
  readonly profile: ResolvedTaskProfile;
  readonly task: SealedTaskDoc;
  readonly submission: SealedSubmissionDoc;
}

const golden = loadFixtureDirectory("derivation", "golden") as unknown as DerivationFixture[];
const adversarial = loadFixtureDirectory("derivation", "adversarial") as unknown as DerivationFixture[];

/**
 * Both reproductions, projected onto protocol's own result shape, so the three can be compared as
 * values rather than described in prose. `mergeRequirements` is the function the shipped venues
 * call; everything else in this file is a claim about it, and a claim about a function you never
 * call is a comment.
 */
type Projected =
  | { ok: true; effective: Record<string, unknown> }
  | { ok: false; key: string };

const viaProtocol = (
  task: Record<string, JsonValue> | undefined,
  submission: Record<string, JsonValue> | undefined,
  classes: Record<string, ComparisonClass>,
): Projected => {
  const result = mergeRequirements(task, submission, classes);
  return result.ok ? { ok: true, effective: result.effective } : { ok: false, key: result.key };
};

const viaReference = (
  task: Record<string, JsonValue> | undefined,
  submission: Record<string, JsonValue> | undefined,
  classes: Record<string, ComparisonClass>,
): Projected => {
  const result = mergeRequirementsNaive(task, submission, classes);
  return result.ok ? { ok: true, effective: result.effective } : { ok: false, key: result.key };
};

const viaPackage = (
  task: Record<string, JsonValue> | undefined,
  submission: Record<string, JsonValue> | undefined,
  classes: Record<string, ComparisonClass>,
): Projected => {
  const result = mergeEffectiveRequirements(task, submission, classes);
  return result.ok ? { ok: true, effective: result.effective } : { ok: false, key: result.key };
};

function classesFor(fixture: DerivationFixture): Record<string, ComparisonClass> {
  return {
    ...CORE_KEY_CLASSES,
    ...Object.fromEntries(fixture.profile.requirementKeys.map((entry) => [entry.key, entry.comparisonClass])),
  };
}

describe("both reproductions execute protocol's merge, and agree with it", () => {
  // The reproduction lives in this package because a pure tier-3 substrate depends on no Jinn
  // package (substrate §2). That is a dependency decision, not a licence to drift: protocol owns
  // the semantics, and this suite runs the real function beside both reproductions on every
  // fixture and on the relation semantics no fixture happens to reach.
  for (const fixture of [...golden, ...adversarial]) {
    it(`${fixture.name}: protocol, the package, and the reference agree`, () => {
      const classes = classesFor(fixture);
      const task = fixture.task.requirements as Record<string, JsonValue> | undefined;
      const submission = fixture.submission.requirements as Record<string, JsonValue> | undefined;
      const expected = viaProtocol(task, submission, classes);
      expect(viaPackage(task, submission, classes)).toEqual(expected);
      expect(viaReference(task, submission, classes)).toEqual(expected);
    });
  }
});

describe("relation semantics, case by case, against the real protocol merge", () => {
  const table: {
    name: string;
    why: string;
    classes: Record<string, ComparisonClass>;
    task: Record<string, JsonValue>;
    submission: Record<string, JsonValue>;
  }[] = [
    {
      name: "floor admits an equal tier",
      why: "`>=`, not `>`. An off-by-one here refuses every Submission that asks for exactly what the Task asked for.",
      classes: { effort: "floor" },
      task: { effort: "high" },
      submission: { effort: "high" },
    },
    {
      name: "floor admits a tighter tier and refuses a looser one",
      why: "The direction of the relation, pinned in both directions so a sign flip cannot pass.",
      classes: { effort: "floor" },
      task: { effort: "medium" },
      submission: { effort: "low" },
    },
    {
      name: "floor on numbers rather than effort tiers",
      why: "The non-tier branch: a floor over a numeric key falls through to `>=` on numbers.",
      classes: { budget: "floor" },
      task: { budget: 10 },
      submission: { budget: 4 },
    },
    {
      name: "ceiling admits an equal value",
      why: "The mirror of the floor case, on the relation that runs the other way.",
      classes: { maxTokens: "ceiling" },
      task: { maxTokens: 120000 },
      submission: { maxTokens: 120000 },
    },
    {
      name: "ceiling refuses a looser value",
      why: "A Submission asking for more headroom than the Task allowed is a different treatment.",
      classes: { maxTokens: "ceiling" },
      task: { maxTokens: 1000 },
      submission: { maxTokens: 2000 },
    },
    {
      name: "byte-equality ignores member order",
      why: "The comparator canonicalizes before comparing, so `{a,b}` and `{b,a}` are one value.",
      classes: { harness: "exact" },
      task: { harness: { id: "claude-code", version: "2.1.34" } as unknown as JsonValue },
      submission: { harness: { version: "2.1.34", id: "claude-code" } as unknown as JsonValue },
    },
    {
      name: "byte-equality distinguishes an absent member from a null one",
      why: "The undefined-member case: `{id}` and `{id, version: null}` are different requirements, and a comparator that drops nullish members would merge two distinct treatments into one.",
      classes: { harness: "exact" },
      task: { harness: { id: "claude-code" } as unknown as JsonValue },
      submission: { harness: { id: "claude-code", version: null } as unknown as JsonValue },
    },
    {
      name: "addable with the key present in BOTH documents",
      why: "`addable`'s relation only covers the Task-absent case; present in both it must fall through to the conservative byte-equality default rather than letting the Submission overwrite.",
      classes: { loadout: "addable" },
      task: { loadout: { kind: "jinn.skill.v1", name: "alpha" } as unknown as JsonValue },
      submission: { loadout: { kind: "jinn.skill.v1", name: "beta" } as unknown as JsonValue },
    },
    {
      name: "addable with the key absent from the Task",
      why: "The other half: no Task constraint exists to violate, so the Submission sets it freely.",
      classes: { loadout: "addable" },
      task: {},
      submission: { loadout: { kind: "jinn.skill.v1", name: "beta" } as unknown as JsonValue },
    },
    {
      name: "constraint on a key with no registered membership test",
      why: "`constraint` consults a per-key registry that registers `model` only; every other key falls through to byte-equality. This is the whole reason F2's two class maps are behaviorally inert.",
      classes: { isolationPolicy: "constraint" },
      task: { isolationPolicy: "unrestricted" },
      submission: { isolationPolicy: "sandboxed" },
    },
    {
      name: "constraint on model, provider to provider",
      why: "The registered test's direct leg.",
      classes: { model: "constraint" },
      task: { model: { provider: "anthropic" } as unknown as JsonValue },
      submission: { model: { provider: "anthropic", id: "claude-haiku-4-5" } as unknown as JsonValue },
    },
    {
      name: "constraint on model, provider inferred from the id prefix",
      why: "BLOCKER B3's case: the reference omitted this leg, so it refused a Submission every shipped venue admits.",
      classes: { model: "constraint" },
      task: { model: { provider: "anthropic" } as unknown as JsonValue },
      submission: { model: { id: "claude-haiku-4-5" } as unknown as JsonValue },
    },
    {
      name: "constraint on model, inference resolving to the wrong provider",
      why: "The prefix table must be consulted AND its answer compared.",
      classes: { model: "constraint" },
      task: { model: { provider: "anthropic" } as unknown as JsonValue },
      submission: { model: { id: "llama-3" } as unknown as JsonValue },
    },
    {
      name: "a fractional requirement value compares without sealing",
      why: "BLOCKER B3's other half: the merge compares requirement values, which may legally be fractional; only step 5 seals. A comparator built on the sealed-document canonicalizer throws here instead of merging.",
      classes: { temperature: "exact" },
      task: { temperature: 0.7 },
      submission: { temperature: 0.7 },
    },
    {
      name: "an unknown comparison class falls through to the conservative default",
      why: "A profile declaring a class this stack does not know must not become a free pass.",
      classes: {},
      task: { reviewDepth: "deep" },
      submission: { reviewDepth: "shallow" },
    },
  ];

  for (const row of table) {
    it(`${row.name} — ${row.why.split(".")[0]}`, () => {
      const expected = viaProtocol(row.task, row.submission, row.classes);
      expect(viaPackage(row.task, row.submission, row.classes)).toEqual(expected);
      expect(viaReference(row.task, row.submission, row.classes)).toEqual(expected);
    });
  }

  it("the table exercises every one of the five comparison classes", () => {
    const exercised = new Set(table.flatMap((row) => Object.values(row.classes)));
    expect([...exercised].sort()).toEqual(["addable", "ceiling", "constraint", "exact", "floor"]);
  });
});

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
