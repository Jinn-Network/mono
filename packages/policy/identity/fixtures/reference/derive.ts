// SPDX-License-Identifier: MIT

/**
 * NAIVE REFERENCE DERIVER — substrate §4.1's total function, written out step by step.
 *
 * The five normative steps, in order, with nothing clever in between:
 *
 *   1. Effective requirements = the Task∪Submission merge under the profiles §5.1 comparison
 *      classes. The winning value per key is the merge result, never either source alone.
 *   2. Closed key rule: the four core axes are always present, `null` when unconstrained; plus
 *      every key the Task's profile declares in `requirementKeys` **that is present** in the
 *      effective requirements. Declared-but-unset profile keys are omitted, never null-filled.
 *      Every other requirement key is excluded.
 *   3. Values are copied **byte-exactly**. Enrichment is forbidden — this function is given no
 *      venue knowledge to enrich from, which is the structural way to honor the ban.
 *   4. Constraint-shaped values enter byte-exactly.
 *   5. Canonicalize; `tupleDigest = sha256:<hex>` over those bytes.
 *
 * FINDING F1 (see README): the third parameter. The program's frozen signature is
 * `deriveExecutionTuple(task, submission)`, but steps 1 and 2 both need the **resolved
 * task-profile document** — step 1 for the comparison classes of profile-added keys, step 2 for
 * `requirementKeys` itself — and `Task.profile` only *pins* that document by digest. Passing it
 * explicitly keeps the function total and keeps the "two honest derivers agree" claim true: the
 * Task determines the profile uniquely, so the pair still determines the tuple.
 */

import { CORE_AXES, EXECUTION_TUPLE_FORMAT_TOKEN } from "../../src/tokens.js";
import type {
  ComparisonClass,
  ExecutionPolicyTuple,
  JsonValue,
  ResolvedTaskProfile,
  SealedSubmissionDoc,
  SealedTaskDoc,
} from "../../src/types.js";
import { fail } from "./errors.js";
import { CORE_KEY_CLASSES, mergeRequirementsNaive } from "./merge.js";
import { assertValidTuple } from "./tuple.js";

/**
 * The profile document a Task pins must be the one supplied. Checked rather than trusted: a
 * deriver handed a *different* revision of the same profile URI would silently select a
 * different key set, which is precisely the divergence §4.1 exists to rule out.
 */
function assertProfileMatchesTask(task: SealedTaskDoc, profile: ResolvedTaskProfile): void {
  const pinned = task.profile?.digest?.["sha256"];
  if (typeof pinned !== "string" || pinned.length === 0) {
    fail("invalid-document", "task.profile.digest.sha256", "sealed Task must pin its profile by sha256 digest");
  }
  const expected = profile.digest.startsWith("sha256:") ? profile.digest.slice("sha256:".length) : profile.digest;
  if (pinned !== expected) {
    fail(
      "invalid-document",
      "task.profile.digest.sha256",
      `resolved profile digest ${expected} does not match the digest the Task pins (${pinned})`,
    );
  }
}

export function deriveExecutionTuple(
  task: SealedTaskDoc,
  submission: SealedSubmissionDoc,
  profile: ResolvedTaskProfile,
): ExecutionPolicyTuple {
  assertProfileMatchesTask(task, profile);

  // FINDING F5 (see README): a profile that declares `formatToken` as a requirement key would
  // collide with the tuple's own metadata member. The design states no rule; failing closed is
  // the only option that cannot silently produce a tuple whose `formatToken` is not the token.
  const declaredKeys: string[] = [];
  const profileClasses: Record<string, ComparisonClass> = {};
  for (const entry of profile.requirementKeys) {
    if (entry.key === "formatToken") {
      fail(
        "invalid-document",
        "profile.requirementKeys.formatToken",
        "a profile requirement key must not collide with the tuple's reserved `formatToken` member",
      );
    }
    declaredKeys.push(entry.key);
    profileClasses[entry.key] = entry.comparisonClass;
  }

  // Step 1 — effective requirements. Core classes first, then the resolved profile document's
  // own declarations, which are authoritative for their keys.
  const keyClasses: Record<string, ComparisonClass> = { ...CORE_KEY_CLASSES, ...profileClasses };
  const merged = mergeRequirementsNaive(task.requirements, submission.requirements, keyClasses);
  if (!merged.ok) {
    fail(
      "requirement-conflict",
      `requirements.${merged.key}`,
      `requirement "${merged.key}" violates its ${keyClasses[merged.key] ?? "conservative"} comparison class`,
    );
  }
  const effective = merged.effective;

  // Step 2 — the closed key rule, assembled longhand.
  const tuple: Record<string, JsonValue> = { formatToken: EXECUTION_TUPLE_FORMAT_TOKEN };

  for (const axis of CORE_AXES) {
    // Present-always, null when the effective requirements do not constrain it. Steps 3 and 4:
    // the value is copied out of `effective` verbatim, whatever its shape.
    tuple[axis] = Object.hasOwn(effective, axis) ? effective[axis] : null;
  }

  for (const key of declaredKeys) {
    if ((CORE_AXES as readonly string[]).includes(key)) continue; // already null-filled above
    // "that is present" — declared-but-unset profile keys are omitted, never null-filled.
    if (!Object.hasOwn(effective, key)) continue;
    tuple[key] = effective[key];
  }

  // Every other requirement key is excluded. Nothing else is copied: the loop above is the
  // whole allow-list, so a foreign Submission key cannot reach the tuple by any path.

  assertValidTuple(tuple);
  return tuple;
}
