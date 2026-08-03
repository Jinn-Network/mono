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
import { canonicalJsonText } from "./canonical.js";
import { fail } from "./errors.js";
import { sha256Hex } from "./hashing.js";
import { CORE_KEY_CLASSES, mergeRequirementsNaive } from "./merge.js";
import { assertValidTuple, canonicalTupleBytes } from "./tuple.js";

interface ProfileDocument {
  readonly profile: string;
  readonly requirementKeys: { key: string; comparisonClass: ComparisonClass }[];
}

const COMPARISON_CLASSES = ["exact", "ceiling", "floor", "constraint", "addable"];

function decodeBase64(value: string): Uint8Array | undefined {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return undefined;
  try {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  } catch {
    return undefined;
  }
}

/**
 * The profile document a Task pins must be the one supplied, and "the one supplied" is decided by
 * hashing the document's own bytes — not by reading a digest the caller wrote down. A deriver
 * handed a *different* revision of the same profile URI silently selects a different key set,
 * which is precisely the divergence §4.1 exists to rule out, and a self-asserted digest field
 * cannot detect it: the caller writes both the label and the document.
 */
function resolveProfileDocument(task: SealedTaskDoc, profile: ResolvedTaskProfile): ProfileDocument {
  const pinned = task.profile?.digest?.["sha256"];
  if (typeof pinned !== "string" || pinned.length === 0) {
    fail("invalid-document", "task.profile.digest.sha256", "sealed Task must pin its profile by sha256 digest");
  }

  if (typeof profile.sealedBytes !== "string") {
    fail("invalid-document", "profile.sealedBytes", "the resolved profile must carry its sealed bytes");
  }
  const bytes = decodeBase64(profile.sealedBytes);
  if (bytes === undefined) {
    fail("invalid-document", "profile.sealedBytes", "sealed profile bytes must be strict base64");
  }

  const recomputed = sha256Hex(bytes);
  if (recomputed !== pinned) {
    fail(
      "invalid-document",
      "task.profile.digest.sha256",
      `supplied profile bytes hash to ${recomputed}, not the digest the Task pins (${pinned})`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    fail("invalid-document", "profile.sealedBytes", "sealed profile bytes are not a UTF-8 JSON document");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    fail("invalid-document", "profile.sealedBytes", "the sealed profile document must be a JSON object");
  }

  const document = parsed as Record<string, unknown>;
  if (typeof document["profile"] !== "string" || document["profile"] === "") {
    fail("invalid-document", "profile.sealedBytes.profile", "the sealed profile document must name its URI");
  }
  if (!Array.isArray(document["requirementKeys"])) {
    fail("invalid-document", "profile.sealedBytes.requirementKeys", "requirementKeys must be an array");
  }

  const requirementKeys: { key: string; comparisonClass: ComparisonClass }[] = [];
  const seen: string[] = [];
  for (let index = 0; index < document["requirementKeys"].length; index += 1) {
    const entry = document["requirementKeys"][index] as unknown;
    const path = `profile.sealedBytes.requirementKeys.${index}`;
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      fail("invalid-document", path, "a declared requirement key must be a JSON object");
    }
    const record = entry as Record<string, unknown>;
    if (typeof record["key"] !== "string" || record["key"] === "") {
      fail("invalid-document", `${path}.key`, "a declared requirement key must name a key");
    }
    if (typeof record["comparisonClass"] !== "string"
      || !COMPARISON_CLASSES.includes(record["comparisonClass"])) {
      fail("invalid-document", `${path}.comparisonClass`, "unknown comparison class");
    }
    // Declared twice under two classes, the merge would depend on which entry a reader kept.
    if (seen.includes(record["key"])) {
      fail("invalid-document", `profile.requirementKeys.${record["key"]}`,
        "a profile may declare each requirement key at most once");
    }
    seen.push(record["key"]);
    requirementKeys.push({
      key: record["key"],
      comparisonClass: record["comparisonClass"] as ComparisonClass,
    });
  }

  // The caller's view is checked before it is read: a malformed view is invalid input and must
  // arrive as a typed refusal, not as a TypeError out of a spread.
  if (!Array.isArray(profile.requirementKeys)) {
    fail("invalid-document", "profile.requirementKeys", "requirementKeys must be an array");
  }
  for (let index = 0; index < profile.requirementKeys.length; index += 1) {
    const entry = profile.requirementKeys[index] as unknown;
    const path = `profile.requirementKeys.${index}`;
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      fail("invalid-document", path, "a declared requirement key must be a JSON object");
    }
    if (typeof (entry as { key?: unknown }).key !== "string") {
      fail("invalid-document", `${path}.key`, "a declared requirement key must name a key");
    }
  }

  // The caller's parsed view must be a faithful reading of the same bytes.
  if (typeof profile.profile !== "string" || profile.profile !== document["profile"]) {
    fail("invalid-document", "profile.profile", "the supplied profile URI is not the one in the sealed bytes");
  }
  // Compared as a SET: the sealed bytes decide WHICH keys under WHICH classes, and the order they
  // are listed in is spelling. The derivation is a function of the documents, not of their
  // spelling, so a reordered view is the same declaration.
  const asSet = (entries: readonly { key: string; comparisonClass: ComparisonClass }[]): string =>
    canonicalJsonText(
      [...entries]
        .map((entry) => ({ key: entry.key, comparisonClass: entry.comparisonClass }))
        .sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0)),
    );
  if (asSet(profile.requirementKeys) !== asSet(requirementKeys)) {
    fail("invalid-document", "profile.requirementKeys",
      "the supplied requirement keys are not the ones in the sealed bytes");
  }

  const uri = task.profile?.uri;
  if (typeof uri === "string" && uri !== document["profile"]) {
    fail("invalid-document", "task.profile.uri", "the sealed profile document does not carry the Task's profile URI");
  }

  return { profile: document["profile"], requirementKeys };
}

export function deriveExecutionTuple(
  task: SealedTaskDoc,
  submission: SealedSubmissionDoc,
  profile: ResolvedTaskProfile,
): ExecutionPolicyTuple {
  const resolved = resolveProfileDocument(task, profile);

  // FINDING F5 (see README): a profile that declares `formatToken` as a requirement key would
  // collide with the tuple's own metadata member. The design states no rule; failing closed is
  // the only option that cannot silently produce a tuple whose `formatToken` is not the token.
  const declaredKeys: string[] = [];
  const profileClasses: Record<string, ComparisonClass> = {};
  for (const entry of resolved.requirementKeys) {
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

  // Step 5 belongs to this function: §4.1 ends at canonical bytes. A value that merges cleanly but
  // is not I-JSON (a fractional number is the reachable case) yields a tuple every consumer
  // accepts and no consumer can digest, so canonicalize here and refuse rather than hand it back.
  assertValidTuple(tuple);
  canonicalTupleBytes(tuple);
  return tuple;
}
