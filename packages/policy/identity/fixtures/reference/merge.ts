// SPDX-License-Identifier: MIT

/**
 * NAIVE REFERENCE — the profiles §5.1 tighten-only requirements merge, substrate §4.1 step 1.
 *
 * Deliberately **re-implemented from the design text** rather than imported from
 * `@jinn-network/task-execution-protocol`. That is the point: the kit's job is to prove two
 * structurally different code paths agree, and importing the very function the implementation
 * will call would prove nothing. `merge-parity.test.ts` asserts this reimplementation and
 * protocol's `mergeRequirements` agree on every derivation fixture — the equivalence is
 * *checked*, not assumed.
 *
 * FINDING F2 (see README): the shipped venues disagree on the core-axis comparison classes.
 * `CORE_KEY_CLASSES` below pins one map; `merge-parity.test.ts` demonstrates the disagreement is
 * behaviorally inert on the core four, which is why pinning either map is safe today.
 */

import type { ComparisonClass, JsonValue } from "../../src/types.js";
import { canonicallyEqual } from "./canonical.js";

export type MergeResult =
  | { readonly ok: true; readonly effective: Record<string, JsonValue> }
  | { readonly ok: false; readonly key: string; readonly category: "invalid-document" };

/**
 * The core-axis classes, taken from `packages/marketplace/binding/src/capabilities.ts`, which
 * cites profiles §5/§5.1 directly: `harness`/`model`/`isolationPolicy` are `constraint` (the Task
 * names an admissible set, the Submission pins a member); `loadout` is `addable` (free when the
 * Task declares no loadout constraint).
 */
export const CORE_KEY_CLASSES: Readonly<Record<string, ComparisonClass>> = {
  harness: "constraint",
  model: "constraint",
  isolationPolicy: "constraint",
  loadout: "addable",
};

/**
 * The local backend's rival map (`backend-local/assembly/src/backend.ts`), kept here purely so
 * `merge-parity.test.ts` can demonstrate the two produce identical effective requirements.
 */
export const LOCAL_BACKEND_CORE_KEY_CLASSES: Readonly<Record<string, ComparisonClass>> = {
  harness: "exact",
  model: "constraint",
  loadout: "exact",
  isolationPolicy: "exact",
};

const EFFORT_TIERS = ["low", "medium", "high", "xhigh", "max"] as const;

function effortRank(value: unknown): number | undefined {
  const index = (EFFORT_TIERS as readonly string[]).indexOf(value as string);
  return index === -1 ? undefined : index;
}

/**
 * The only `constraint`-class membership test the stack registers is `model`'s (protocol's
 * `CONSTRAINT_MEMBERSHIP`). The kit exercises only its provider-to-provider and id-to-id legs;
 * protocol's model-id prefix table is a private inference heuristic, and a kit that pinned it
 * would be gating an implementation detail rather than the design.
 */
function modelConstraintAdmits(taskConstraint: unknown, submissionValue: unknown): boolean {
  if (typeof taskConstraint !== "object" || taskConstraint === null) return false;
  if (typeof submissionValue !== "object" || submissionValue === null) return false;
  const constraint = taskConstraint as { provider?: unknown; id?: unknown };
  const pinned = submissionValue as { provider?: unknown; id?: unknown };
  if (typeof constraint.provider === "string") return pinned.provider === constraint.provider;
  if (typeof constraint.id === "string") return pinned.id === constraint.id;
  return false;
}

export function mergeRequirementsNaive(
  taskRequirements: Readonly<Record<string, JsonValue>> | undefined,
  submissionRequirements: Readonly<Record<string, JsonValue>> | undefined,
  keyClasses: Readonly<Record<string, ComparisonClass>>,
): MergeResult {
  const task = taskRequirements ?? {};
  const submission = submissionRequirements ?? {};
  const effective: Record<string, JsonValue> = {};

  const keys = [...new Set([...Object.keys(task), ...Object.keys(submission)])];
  for (const key of keys) {
    const inTask = Object.hasOwn(task, key);
    const inSubmission = Object.hasOwn(submission, key);

    // Only one side declares the key: it stands, unmerged.
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
    const keyClass = keyClasses[key];
    let admitted: boolean;

    switch (keyClass) {
      case "exact":
        admitted = canonicallyEqual(taskValue, submissionValue);
        break;
      case "ceiling":
        admitted = typeof taskValue === "number"
          && typeof submissionValue === "number"
          && submissionValue <= taskValue;
        break;
      case "floor": {
        const taskTier = effortRank(taskValue);
        const submissionTier = effortRank(submissionValue);
        if (taskTier !== undefined && submissionTier !== undefined) {
          admitted = submissionTier >= taskTier;
        } else {
          admitted = typeof taskValue === "number"
            && typeof submissionValue === "number"
            && submissionValue >= taskValue;
        }
        break;
      }
      case "constraint":
        // Unknown constraint keys fall through to the conservative byte-equality default.
        admitted = key === "model"
          ? modelConstraintAdmits(taskValue, submissionValue)
          : canonicallyEqual(taskValue, submissionValue);
        break;
      case "addable":
      default:
        // `addable`'s relation only applies when the key is absent from the Task, which is
        // handled above. Present in both, under `addable`, an unknown class, or no declared
        // class at all: the conservative default is byte-equality or rejection.
        admitted = canonicallyEqual(taskValue, submissionValue);
        break;
    }

    if (!admitted) return { ok: false, key, category: "invalid-document" };
    // On every successful branch the *winning value is the Submission's*. This is what makes the
    // §4.1 "byte-exactly from the effective requirements" copy well-defined.
    effective[key] = submissionValue as JsonValue;
  }

  return { ok: true, effective };
}
