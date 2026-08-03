// SPDX-License-Identifier: MIT

/**
 * The Task ∪ Submission effective-requirements merge — substrate §4.1 step 1.
 *
 * **Semantics authority:** `packages/task-execution/protocol/src/requirements.ts`
 * (`mergeRequirements`). This module reproduces that function's behavior rather than importing
 * it: `@jinn-network/policy-identity` is a pure package that depends on no Jinn package
 * (substrate §2 — the kit's frozen `types.ts` already mirrors `ComparisonClass` rather than
 * importing it), and the tighten-only relation is small enough to state once per side and pin
 * against drift. `.github/scripts/policy-identity-guards.test.mjs` asserts that the class map and
 * the constraint-membership key set here still match protocol's; the day they diverge, that guard
 * fails rather than two venues quietly deriving different tuples.
 *
 * FINDING F2 (README) — the core-axis comparison-class map was unpinned, and the two shipped
 * venues declare different maps. `merge-parity.test.ts` establishes that the disagreement is
 * behaviorally inert today: `constraint` consults a per-key membership registry that registers a
 * test for `model` only, so on `harness`/`loadout`/`isolationPolicy` it falls through to
 * byte-equality — the same behavior `exact` has, and the same behavior `addable` has for a key
 * present in both documents. The one key where the class has a consequence, `model`, is
 * `constraint` in both maps. `CORE_KEY_CLASSES` below is this package's pin (the marketplace
 * spelling, which cites profiles §5/§5.1 with its rationale); both venues migrate to it.
 */

import { compareCodeUnitStrings } from "./canonical.js";
import type { ComparisonClass, JsonValue } from "./types.js";

export type MergeOutcome =
  | { readonly ok: true; readonly effective: Record<string, JsonValue> }
  | { readonly ok: false; readonly key: string };

/**
 * The pinned core-axis comparison classes (F2). `harness`/`model`/`isolationPolicy` are
 * `constraint` — the Task names an admissible set and the Submission pins a member;
 * `loadout` is `addable` — free when the Task declares no loadout constraint.
 */
export const CORE_KEY_CLASSES: Readonly<Record<string, ComparisonClass>> = Object.freeze({
  harness: "constraint",
  model: "constraint",
  loadout: "addable",
  isolationPolicy: "constraint",
});

/** profiles §5.1 effort ordinals, lowest first. Mirrors protocol's `EFFORT_TIERS`. */
export const EFFORT_TIERS = ["low", "medium", "high", "xhigh", "max"] as const;

function effortRank(value: unknown): number | undefined {
  const index = (EFFORT_TIERS as readonly string[]).indexOf(value as string);
  return index === -1 ? undefined : index;
}

/**
 * Structural equality over **arbitrary requirement values**, deliberately without the I-JSON
 * restrictions `canonical.ts` enforces: this compares two requirement maps, not sealed bytes, and
 * a Task carrying a fractional requirement must merge or conflict rather than crash. Protocol's
 * `byteEqual` makes the same distinction for the same reason.
 */
function structurallyEqual(left: unknown, right: unknown): boolean {
  return lenientCanonical(left) === lenientCanonical(right);
}

function lenientCanonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "undefined";
  if (Array.isArray(value)) return `[${value.map(lenientCanonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort(compareCodeUnitStrings)
    .map((key) => `${JSON.stringify(key)}:${lenientCanonical(record[key])}`)
    .join(",")}}`;
}

/**
 * The `constraint`-class membership registry. Protocol registers exactly one entry, `model`;
 * every other `constraint` key falls through to the conservative byte-equality default. The
 * provider-inference leg is protocol's, reproduced so the two sides admit the same submissions.
 */
const MODEL_ID_PROVIDER_PREFIXES: Readonly<Record<string, string>> = {
  "claude-": "anthropic",
  "gpt-": "openai",
  "o1-": "openai",
  "gemini-": "google",
  "llama-": "meta",
  "mistral-": "mistralai",
};

function inferProviderFromModelId(id: string): string | undefined {
  for (const [prefix, provider] of Object.entries(MODEL_ID_PROVIDER_PREFIXES)) {
    if (id.startsWith(prefix)) return provider;
  }
  return undefined;
}

function modelConstraintAdmits(taskConstraint: unknown, submissionValue: unknown): boolean {
  if (typeof taskConstraint !== "object" || taskConstraint === null) return false;
  if (typeof submissionValue !== "object" || submissionValue === null) return false;
  const constraint = taskConstraint as { provider?: unknown; id?: unknown };
  const pinned = submissionValue as { provider?: unknown; id?: unknown };
  if (typeof constraint.provider === "string") {
    if (typeof pinned.provider === "string") return pinned.provider === constraint.provider;
    if (typeof pinned.id === "string") return inferProviderFromModelId(pinned.id) === constraint.provider;
    return false;
  }
  if (typeof constraint.id === "string") return pinned.id === constraint.id;
  return false;
}

const CONSTRAINT_MEMBERSHIP: Readonly<
  Record<string, (task: unknown, submission: unknown) => boolean>
> = { model: modelConstraintAdmits };

/** The membership keys, exported so the drift guard can compare them with protocol's registry. */
export const CONSTRAINT_MEMBERSHIP_KEYS = Object.freeze(Object.keys(CONSTRAINT_MEMBERSHIP));

/**
 * The tighten-only merge. `keyClasses` is the caller's assembly of `CORE_KEY_CLASSES` plus the
 * resolved profile document's declared classes.
 *
 * Where both documents declare a key the class decides, and **the winning value is the merge
 * result, never either source alone** (§4.1 step 1) — which in every successful branch is the
 * Submission's value, because tightening is the only admitted direction. Where the merge refuses,
 * there is no tuple: a deriver that fell back to the Submission's value would mint an identity for
 * a treatment the Task never admitted.
 */
export function mergeEffectiveRequirements(
  taskRequirements: Readonly<Record<string, JsonValue>> | undefined,
  submissionRequirements: Readonly<Record<string, JsonValue>> | undefined,
  keyClasses: Readonly<Record<string, ComparisonClass>>,
): MergeOutcome {
  const task = taskRequirements ?? {};
  const submission = submissionRequirements ?? {};
  const effective: Record<string, JsonValue> = {};

  for (const key of new Set([...Object.keys(task), ...Object.keys(submission)])) {
    const inTask = Object.hasOwn(task, key);
    const inSubmission = Object.hasOwn(submission, key);

    // Only one side asserts: nothing to reconcile. A Task-only value stands as mandatory; a
    // Submission-only value has no Task constraint to violate (this is also `addable`'s relation).
    if (inTask && !inSubmission) {
      effective[key] = task[key] as JsonValue;
      continue;
    }
    if (!inTask && inSubmission) {
      effective[key] = submission[key] as JsonValue;
      continue;
    }

    const taskValue = task[key];
    const submissionValue = submission[key];
    if (!admits(keyClasses[key], key, taskValue, submissionValue)) return { ok: false, key };
    effective[key] = submissionValue as JsonValue;
  }

  return { ok: true, effective };
}

function admits(
  keyClass: ComparisonClass | undefined,
  key: string,
  taskValue: unknown,
  submissionValue: unknown,
): boolean {
  switch (keyClass) {
    case "ceiling":
      return (
        typeof taskValue === "number"
        && typeof submissionValue === "number"
        && submissionValue <= taskValue
      );
    case "floor": {
      const taskTier = effortRank(taskValue);
      const submissionTier = effortRank(submissionValue);
      if (taskTier !== undefined && submissionTier !== undefined) return submissionTier >= taskTier;
      return (
        typeof taskValue === "number"
        && typeof submissionValue === "number"
        && submissionValue >= taskValue
      );
    }
    case "constraint": {
      const membershipTest = CONSTRAINT_MEMBERSHIP[key];
      return membershipTest === undefined
        ? structurallyEqual(taskValue, submissionValue)
        : membershipTest(taskValue, submissionValue);
    }
    // `exact`, `addable` with the key present in both, an unknown class, and no declared class at
    // all are one behavior: the conservative byte-equality default.
    default:
      return structurallyEqual(taskValue, submissionValue);
  }
}
