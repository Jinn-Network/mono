// SPDX-License-Identifier: MIT

/**
 * `deriveExecutionTuple` — substrate §4.1's total function, in five stages.
 *
 * The input is exactly one **triple**: the sealed Task, the sealed Submission, and the resolved
 * task-profile document the Task pins by digest (amended 2026-08-03; FINDING F1 — steps 1 and 2
 * both need the profile's `requirementKeys`, which the Task carries only as a pin). Two honest
 * derivers holding these three documents MUST produce identical bytes, so every stage below is
 * either a copy or a refusal — never a choice.
 *
 *   0. profile pin-check      the supplied profile is the one the Task pinned, or nothing derives
 *   1. reserved members       a profile may not declare a member the tuple owns
 *   2. effective requirements the tighten-only merge; a refusal yields no tuple
 *   3. closed key rule        four core axes always, plus declared-and-present profile keys
 *   4. byte-exact copy        no enrichment, then canonicalize and validate
 */

import { refuse } from "./errors.js";
import { CORE_KEY_CLASSES, mergeEffectiveRequirements } from "./merge.js";
import { CORE_AXES, EXECUTION_TUPLE_FORMAT_TOKEN } from "./tokens.js";
import { assertValidTuple } from "./tuple.js";
import type {
  ComparisonClass,
  ExecutionPolicyTuple,
  JsonValue,
  ResolvedTaskProfile,
  SealedSubmissionDoc,
  SealedTaskDoc,
} from "./types.js";

/** Tuple members that are the document's own metadata and can never be a requirement key (F5). */
const RESERVED_TUPLE_MEMBERS = new Set(["formatToken"]);

function assertDocument(value: unknown, path: string, what: string): void {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    refuse("invalid-document", path, `${what} must be a JSON object`);
  }
}

/**
 * Stage 0. profiles §6.2 already forbids validating against a cached profile whose digest differs
 * from the Task's pin; the derivation honors the same rule, because handing two honest derivers
 * different revisions of one profile URI is the quietest way to fork the identity space —
 * `requirementKeys` decides the tuple's key set, so one added key is one new digest for identical
 * execution. A deriver that trusts whatever profile it was handed passes every other fixture in
 * the kit and still forks in production.
 */
function assertProfileMatchesPin(task: SealedTaskDoc, profile: ResolvedTaskProfile): void {
  const pin = task.profile;
  assertDocument(pin, "task.profile", "the Task's profile pin");

  const pinnedDigest = pin.digest?.["sha256"];
  if (typeof pinnedDigest !== "string") {
    refuse("invalid-document", "task.profile.digest.sha256", "the Task pins no profile digest");
  }
  if (profile.digest !== `sha256:${pinnedDigest}`) {
    refuse(
      "invalid-document",
      "task.profile.digest.sha256",
      "the supplied profile document is not the revision the Task pinned",
    );
  }
  if (typeof pin.uri === "string" && pin.uri !== profile.profile) {
    refuse(
      "invalid-document",
      "task.profile.uri",
      "the supplied profile document does not carry the Task's profile URI",
    );
  }
}

/** Stage 1 + the profile's contribution to the class map, read once. */
function profileKeyClasses(profile: ResolvedTaskProfile): Record<string, ComparisonClass> {
  const classes: Record<string, ComparisonClass> = {};
  for (const declared of profile.requirementKeys) {
    if (RESERVED_TUPLE_MEMBERS.has(declared.key)) {
      // Honoring it would copy the effective value over the tuple's own metadata and produce a
      // "tuple" whose format token is not the format token; silently dropping it would violate
      // the closed key rule. Fail closed instead (F5).
      refuse(
        "invalid-document",
        `profile.requirementKeys.${declared.key}`,
        `${declared.key} is a reserved tuple member and may not be declared as a requirement key`,
      );
    }
    classes[declared.key] = declared.comparisonClass;
  }
  return classes;
}

export function deriveExecutionTuple(
  task: SealedTaskDoc,
  submission: SealedSubmissionDoc,
  profile: ResolvedTaskProfile,
): ExecutionPolicyTuple {
  assertDocument(task, "task", "the sealed Task");
  assertDocument(submission, "submission", "the sealed Submission");
  assertDocument(profile, "profile", "the resolved task profile");

  assertProfileMatchesPin(task, profile);
  const declaredClasses = profileKeyClasses(profile);

  // Stage 2. The merge decides. Where it refuses there is no tuple, and the caller sees
  // `requirement-conflict` rather than a treatment the Task never admitted.
  const merged = mergeEffectiveRequirements(task.requirements, submission.requirements, {
    ...CORE_KEY_CLASSES,
    ...declaredClasses,
  });
  if (!merged.ok) {
    refuse(
      "requirement-conflict",
      `requirements.${merged.key}`,
      "the Task and Submission values do not merge under this key's comparison class",
    );
  }
  const effective = merged.effective;

  // Stage 3 + 4. Core axes are always present and null-filled when unconstrained. Profile-declared
  // keys enter only when the effective requirements actually carry them — declared-but-unset keys
  // are OMITTED, never null-filled, because null-filling every declared key gives every task
  // family a different digest for the same treatment and the populations never join. Every other
  // requirement key is excluded, which is the priced consequence §4.1 states: two Submissions
  // differing only on an excluded key share one tupleDigest.
  //
  // Values are copied byte-exactly. Enrichment is forbidden: a venue that knows the harness binary
  // digest does not add it to a value the requirements carried as `{id, version}`, because the
  // tuple names the treatment that was *requested*, and a venue-enriched tuple is an identity only
  // that venue can reproduce.
  const tuple: Record<string, JsonValue> = { formatToken: EXECUTION_TUPLE_FORMAT_TOKEN };
  for (const axis of CORE_AXES) {
    tuple[axis] = Object.hasOwn(effective, axis) ? (effective[axis] as JsonValue) : null;
  }
  for (const key of Object.keys(declaredClasses)) {
    if ((CORE_AXES as readonly string[]).includes(key)) continue; // already null-filled or set
    if (!Object.hasOwn(effective, key)) continue; // declared but unset: omitted
    tuple[key] = effective[key] as JsonValue;
  }

  const derived = tuple as ExecutionPolicyTuple;
  assertValidTuple(derived);
  return derived;
}
