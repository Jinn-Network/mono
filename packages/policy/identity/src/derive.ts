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

import { decodeStrictBase64 } from "./base64.js";
import { canonicalJsonText } from "./canonical.js";
import { sha256Hex } from "./digest.js";
import { refuse } from "./errors.js";
import { CORE_KEY_CLASSES, mergeEffectiveRequirements } from "./merge.js";
import { CORE_AXES, EXECUTION_TUPLE_FORMAT_TOKEN } from "./tokens.js";
import { assertValidTuple, canonicalTupleBytes } from "./tuple.js";
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

/** The parsed profile document, read out of the sealed bytes rather than out of the caller. */
interface ProfileDocument {
  readonly profile: string;
  readonly requirementKeys: readonly { readonly key: string; readonly comparisonClass: ComparisonClass }[];
}

const COMPARISON_CLASSES = new Set<string>(["exact", "ceiling", "floor", "constraint", "addable"]);

/** An order-independent identity for a set of declared requirement keys. */
function declarationIdentity(
  entries: readonly { readonly key: string; readonly comparisonClass: ComparisonClass }[],
): string {
  return canonicalJsonText(
    [...entries]
      .map(({ key, comparisonClass }) => ({ key, comparisonClass }))
      .sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0)),
  );
}

function readProfileDocument(document: unknown): ProfileDocument {
  assertDocument(document, "profile.sealedBytes", "the sealed profile document");
  const parsed = document as Record<string, unknown>;

  if (typeof parsed["profile"] !== "string" || parsed["profile"] === "") {
    refuse("invalid-document", "profile.sealedBytes.profile",
      "the sealed profile document must name its profile URI");
  }
  const declared = parsed["requirementKeys"];
  if (!Array.isArray(declared)) {
    refuse("invalid-document", "profile.sealedBytes.requirementKeys",
      "the sealed profile document must declare requirementKeys as an array");
  }

  const seen = new Set<string>();
  const requirementKeys = declared.map((entry, index) => {
    const path = `profile.sealedBytes.requirementKeys.${index}`;
    assertDocument(entry, path, "a declared requirement key");
    const record = entry as Record<string, unknown>;
    if (typeof record["key"] !== "string" || record["key"] === "") {
      refuse("invalid-document", `${path}.key`, "a declared requirement key must name a key");
    }
    if (typeof record["comparisonClass"] !== "string"
      || !COMPARISON_CLASSES.has(record["comparisonClass"])) {
      refuse("invalid-document", `${path}.comparisonClass`,
        "a declared requirement key must carry one of the five profiles §5.1 comparison classes");
    }
    // A key declared twice, under two classes, would make the merge depend on which entry the
    // reader happened to keep. Refuse rather than pick.
    if (seen.has(record["key"])) {
      refuse("invalid-document", `profile.requirementKeys.${record["key"]}`,
        "a profile may declare each requirement key at most once");
    }
    seen.add(record["key"]);
    return { key: record["key"], comparisonClass: record["comparisonClass"] as ComparisonClass };
  });

  return { profile: parsed["profile"], requirementKeys };
}

/**
 * Stage 0 — the profile pin-check, done against the document's own bytes.
 *
 * profiles §6.2 already forbids validating against a cached profile whose digest differs from the
 * Task's pin; the derivation honors the same rule, because handing two honest derivers different
 * revisions of one profile URI is the quietest way to fork the identity space — `requirementKeys`
 * decides the tuple's key set, so one added key is one new digest for identical execution.
 *
 * The check recomputes sha256 over `sealedBytes` rather than reading a digest the caller asserts.
 * A label-only comparison checks that two strings agree about a document neither of them holds:
 * a caller with revision B can label it with revision A's digest and derive under A's key set,
 * which is the fork this stage exists to rule out. The caller's parsed view is then verified to be
 * a faithful reading of the same bytes, so there is no second place for the two to disagree.
 */
function resolveProfile(task: SealedTaskDoc, profile: ResolvedTaskProfile): ProfileDocument {
  const pin = task.profile;
  assertDocument(pin, "task.profile", "the Task's profile pin");

  const pinnedDigest = pin.digest?.["sha256"];
  if (typeof pinnedDigest !== "string") {
    refuse("invalid-document", "task.profile.digest.sha256", "the Task pins no profile digest");
  }

  if (typeof profile.sealedBytes !== "string") {
    refuse("invalid-document", "profile.sealedBytes",
      "the resolved profile must carry the sealed document's exact bytes");
  }
  const bytes = decodeStrictBase64(profile.sealedBytes);
  if (bytes === undefined) {
    refuse("invalid-document", "profile.sealedBytes", "sealed profile bytes must be strict base64");
  }

  if (sha256Hex(bytes) !== pinnedDigest) {
    refuse(
      "invalid-document",
      "task.profile.digest.sha256",
      "the supplied profile bytes do not hash to the digest the Task pinned",
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    refuse("invalid-document", "profile.sealedBytes",
      "sealed profile bytes are not a UTF-8 JSON document");
  }
  const document = readProfileDocument(parsed);

  // The caller's parsed view must be what the bytes say. Anything else is a caller deriving under
  // one key set while claiming another.
  if (typeof profile.profile !== "string" || profile.profile !== document.profile) {
    refuse("invalid-document", "profile.profile",
      "the supplied profile URI is not the one the sealed bytes carry");
  }
  // Checked before it is read. A malformed caller view is invalid input and must arrive as a typed
  // refusal — a `TypeError` out of a spread would be the same fact in a form no caller can branch
  // on, and would read like a bug in this package rather than a rejection of theirs.
  if (!Array.isArray(profile.requirementKeys)) {
    refuse("invalid-document", "profile.requirementKeys",
      "the resolved profile must carry its declared requirement keys as an array");
  }
  for (const [index, entry] of profile.requirementKeys.entries()) {
    const path = `profile.requirementKeys.${index}`;
    assertDocument(entry, path, "a declared requirement key");
    if (typeof (entry as { key?: unknown }).key !== "string") {
      refuse("invalid-document", `${path}.key`, "a declared requirement key must name a key");
    }
  }

  // Compared as a SET, keyed by `key`. The sealed bytes are authoritative for the content of the
  // declaration — which keys, under which classes — and the order they happen to be listed in is
  // spelling, which the derivation is a function of nothing about. A view carrying the same pairs
  // in a different order is the same declaration; a view carrying a different key or a different
  // class is a caller deriving under one key set while claiming another.
  if (declarationIdentity(profile.requirementKeys) !== declarationIdentity(document.requirementKeys)) {
    refuse("invalid-document", "profile.requirementKeys",
      "the supplied requirement keys are not the ones the sealed bytes carry");
  }

  if (typeof pin.uri === "string" && pin.uri !== document.profile) {
    refuse(
      "invalid-document",
      "task.profile.uri",
      "the sealed profile document does not carry the Task's profile URI",
    );
  }

  return document;
}

/** Stage 1 + the profile's contribution to the class map, read once. */
function profileKeyClasses(profile: ProfileDocument): Record<string, ComparisonClass> {
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

  const resolved = resolveProfile(task, profile);
  const declaredClasses = profileKeyClasses(resolved);

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

  // Stage 5 is part of this function, not a favour the caller does afterwards: §4.1 ends at
  // "canonical bytes, and tupleDigest over those bytes". So the derivation canonicalizes here and
  // refuses if the result will not seal. A requirement value that merges cleanly but is not
  // I-JSON — a fractional number is the reachable case — would otherwise produce a tuple object
  // that every consumer accepts and no consumer can digest, and the refusal would surface at
  // whichever call site happened to seal it first.
  const derived = tuple as ExecutionPolicyTuple;
  assertValidTuple(derived);
  canonicalTupleBytes(derived);
  return derived;
}
