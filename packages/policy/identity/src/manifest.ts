// SPDX-License-Identifier: MIT

/**
 * The candidate manifest: validation and sealing (substrate §5.1–§5.3).
 *
 * A candidate is a *proposal*. What validation establishes is that the document is well-formed,
 * internally consistent, and carries the lineage and provenance a consumer needs. What it
 * deliberately does **not** do (§5.3): fetch parents, verify signatures (a host concern via the
 * trust layer), or materialize policies (a backend concern).
 *
 * The manifest carries no score and no self-assessment. That rule cannot be enforced in general;
 * its checkable form is the rejection of any unrecognized **non-namespaced top-level** field,
 * which catches every obvious spelling. FINDING F7 (README): the rule is top-level-only, and
 * unknown *nested* members are tolerated and preserved — so a score hidden in
 * `declaredChanges.score` is not caught here and falls under the consumer-MUST-IGNORE rule §5.3
 * already states. That cost is priced, not overlooked.
 */

import { canonicalJsonBytes, canonicalJsonText } from "./canonical.js";
import { prefixedDigest, SHA256_PREFIXED_PATTERN } from "./digest.js";
import { childPath, issue, PolicyIdentityError, refuseAll } from "./errors.js";
import { CANDIDATE_MANIFEST_FORMAT_TOKEN } from "./tokens.js";
import { assertValidTuple } from "./tuple.js";
import type {
  CandidateManifest,
  ExecutionPolicyTuple,
  SealedDocument,
  ValidationIssue,
  ValidationResult,
} from "./types.js";

/**
 * FINDING F6 (README): §5.1's table marks optionality only inside `compatibility`. This is the
 * pinned reading — everything but `compatibility` is required, and `parents` may be empty (the
 * seed case: a candidate deriving from nothing is legal and must not be rejected for it).
 */
const REQUIRED_FIELDS = [
  "formatToken",
  "policy",
  "parents",
  "proposer",
  "evidenceProvenance",
  "declaredChanges",
] as const;

const KNOWN_FIELDS = new Set<string>([...REQUIRED_FIELDS, "compatibility"]);

const PARENT_KINDS = new Set(["candidate", "tuple"]);

// TEP §21.3's two extension-key spellings, mirrored from the stack's existing rule
// (`packages/evidence/trace/src/extensions.ts`): reverse-DNS, or an absolute URI.
const REVERSE_DNS_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9-]*(\.[A-Za-z][A-Za-z0-9-]*)+$/;
const ABSOLUTE_URI_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9+.-]*:[^\s]+$/;

export function isNamespacedExtensionKey(key: string): boolean {
  return REVERSE_DNS_KEY_PATTERN.test(key) || ABSOLUTE_URI_KEY_PATTERN.test(key);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function checkPolicy(policy: unknown, errors: ValidationIssue[]): void {
  try {
    assertValidTuple(policy);
  } catch (error) {
    // The manifest is not a wrapper that launders a malformed policy: the tuple's own category is
    // reported, at the `policy` member, so the refusal names the rule that was broken rather than
    // a generic shape complaint — and it happens before the manifest ever acquires a digest.
    const category = error instanceof PolicyIdentityError ? error.category : "invalid-document";
    errors.push(issue(category, "policy", "policy is not a valid execution-policy tuple"));
  }
}

/**
 * Substrate §5.1 — parent references are TYPED so a consumer never has to guess which resolver to
 * call. FINDING F8 (README): a repeated `(kind, digest)` pair is refused rather than silently
 * de-duplicated. It is not a second parent; it is free in-degree in the derived lineage graph, and
 * "most-derived-from" is exactly the statistic a proposer would inflate at zero cost. Silent
 * de-duplication would be worse than either choice: it makes the sealed bytes and the parsed
 * meaning disagree, which a sealed document may never do.
 */
function checkParents(parents: unknown, errors: ValidationIssue[]): void {
  if (!Array.isArray(parents)) {
    errors.push(issue("malformed-parent", "parents", "parents must be an array (empty for seeds)"));
    return;
  }

  const seen = new Set<string>();
  parents.forEach((parent, index) => {
    const path = childPath("parents", index);
    if (!isRecord(parent)) {
      errors.push(issue("malformed-parent", path, "a parent reference must be a JSON object"));
      return;
    }
    if (typeof parent["kind"] !== "string" || !PARENT_KINDS.has(parent["kind"])) {
      errors.push(issue("malformed-parent", childPath(path, "kind"),
        'a parent reference kind must be "candidate" or "tuple"'));
      return;
    }
    if (typeof parent["digest"] !== "string" || !SHA256_PREFIXED_PATTERN.test(parent["digest"])) {
      errors.push(issue("malformed-parent", childPath(path, "digest"),
        "a parent digest must be sha256:<64 lowercase hex>"));
      return;
    }
    const identity = JSON.stringify([parent["kind"], parent["digest"]]);
    if (seen.has(identity)) {
      errors.push(issue("malformed-parent", path, "duplicate parent reference"));
      return;
    }
    seen.add(identity);
  });
}

function requireDigestMember(
  container: Record<string, unknown>,
  member: string,
  path: string,
  errors: ValidationIssue[],
): boolean {
  const value = container[member];
  if (typeof value !== "string" || !SHA256_PREFIXED_PATTERN.test(value)) {
    errors.push(issue("missing-provenance", childPath(path, member),
      `${member} must be sha256:<64 lowercase hex>`));
    return false;
  }
  return true;
}

/**
 * Substrate §5.1/§5.3 — the frozen evidence input the proposer consumed, and the only part of the
 * manifest that makes a held-out exclusion checkable after the fact. Absent provenance is not a
 * lesser manifest; it is an unadmittable one.
 *
 * The receipt's own `savedQueryDigest` must agree with the provenance block's. Two spellings of
 * one fact that disagree means the manifest documents one query and receipts another — a free way
 * to attach a clean, replayable receipt to a bundle assembled from a dirtier query. The check
 * needs no fetch capability, so it belongs here rather than in the adapter.
 */
function checkProvenance(provenance: unknown, errors: ValidationIssue[]): void {
  if (!isRecord(provenance)) {
    errors.push(issue("missing-provenance", "evidenceProvenance",
      "evidenceProvenance is required and must be a JSON object"));
    return;
  }

  const savedQueryOk = requireDigestMember(provenance, "savedQueryDigest", "evidenceProvenance", errors);
  requireDigestMember(provenance, "recordListDigest", "evidenceProvenance", errors);

  const receipt = provenance["snapshotReceipt"];
  const receiptPath = "evidenceProvenance.snapshotReceipt";
  if (!isRecord(receipt)) {
    errors.push(issue("missing-provenance", receiptPath,
      "snapshotReceipt is required and must be a JSON object"));
    return;
  }

  const receiptQueryOk = requireDigestMember(receipt, "savedQueryDigest", receiptPath, errors);
  if (savedQueryOk && receiptQueryOk && receipt["savedQueryDigest"] !== provenance["savedQueryDigest"]) {
    errors.push(issue("missing-provenance", childPath(receiptPath, "savedQueryDigest"),
      "the snapshot receipt names a different saved query than the provenance block"));
  }

  if (!isRecord(receipt["sourceSet"])) {
    errors.push(issue("missing-provenance", childPath(receiptPath, "sourceSet"),
      "the snapshot receipt must name its source set"));
  }
  if (!Array.isArray(receipt["sources"])) {
    errors.push(issue("missing-provenance", childPath(receiptPath, "sources"),
      "the snapshot receipt must carry a per-source checkpoint list"));
  }
  if (typeof receipt["evaluatedAt"] !== "string") {
    errors.push(issue("missing-provenance", childPath(receiptPath, "evaluatedAt"),
      "the snapshot receipt must carry the instant it was evaluated"));
  }
  if (receipt["reproducibility"] !== "replayable" && receipt["reproducibility"] !== "not-replayable") {
    errors.push(issue("missing-provenance", childPath(receiptPath, "reproducibility"),
      'reproducibility must be "replayable" or "not-replayable"'));
  }
}

function checkDeclaredChanges(declaredChanges: unknown, errors: ValidationIssue[]): void {
  if (!isRecord(declaredChanges)) {
    errors.push(issue("invalid-document", "declaredChanges",
      "declaredChanges is required and must be a JSON object"));
    return;
  }
  if (typeof declaredChanges["summary"] !== "string") {
    errors.push(issue("invalid-document", "declaredChanges.summary", "summary must be a string"));
  }
  const touched = declaredChanges["touchedComponents"];
  if (!Array.isArray(touched) || touched.some((entry) => typeof entry !== "string")) {
    errors.push(issue("invalid-document", "declaredChanges.touchedComponents",
      "touchedComponents must be an array of strings"));
  }
}

function checkCompatibility(compatibility: unknown, errors: ValidationIssue[]): void {
  if (compatibility === undefined) return; // optional (F6)
  if (!isRecord(compatibility)) {
    errors.push(issue("invalid-document", "compatibility", "compatibility must be a JSON object"));
    return;
  }
  for (const member of ["taskProfiles", "harnesses", "models"]) {
    const value = compatibility[member];
    if (value === undefined) continue;
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
      errors.push(issue("invalid-document", childPath("compatibility", member),
        `${member} must be an array of strings`));
    }
  }
}

export function validateCandidateManifest(input: unknown): ValidationResult {
  if (!isRecord(input)) {
    return {
      ok: false,
      errors: [issue("invalid-document", "", "a candidate manifest must be a JSON object")],
    };
  }

  const errors: ValidationIssue[] = [];

  if (input["formatToken"] !== CANDIDATE_MANIFEST_FORMAT_TOKEN) {
    errors.push(issue("invalid-document", "formatToken",
      `formatToken must be ${CANDIDATE_MANIFEST_FORMAT_TOKEN}`));
  }
  checkPolicy(input["policy"], errors);
  checkParents(input["parents"], errors);
  if (typeof input["proposer"] !== "string" || input["proposer"] === "") {
    errors.push(issue("invalid-document", "proposer",
      "proposer must be the Agent IRI of the party that produced this candidate"));
  }
  checkProvenance(input["evidenceProvenance"], errors);
  checkDeclaredChanges(input["declaredChanges"], errors);
  checkCompatibility(input["compatibility"], errors);

  for (const key of Object.keys(input)) {
    if (KNOWN_FIELDS.has(key) || isNamespacedExtensionKey(key)) continue;
    errors.push(issue("unrecognized-field", key,
      "unrecognized non-namespaced top-level field; a proposer does not grade its own homework"));
  }

  if (errors.length > 0) return { ok: false, errors };
  // The input object itself is returned, extensions and all: a validator that rebuilds the
  // manifest from a known-field allow-list is the natural implementation and the wrong one — it
  // silently drops the namespaced extensions the format promises to preserve.
  return { ok: true, manifest: input as unknown as CandidateManifest };
}

/**
 * Substrate §5.2 — candidate identity is sha256 of the sealed manifest bytes. Sealing validates
 * first, so an invalid manifest never acquires an identity that could be quoted, signed, or
 * exchanged before anyone notices.
 */
export function sealCandidateManifest(manifest: CandidateManifest): SealedDocument {
  const result = validateCandidateManifest(manifest);
  if (!result.ok) refuseAll(result.errors);
  const bytes = canonicalJsonBytes(manifest);
  return { bytes, digest: prefixedDigest(bytes) };
}

const decoder = new TextDecoder("utf-8", { fatal: true });

/**
 * Parses bytes that must already BE the sealed form. Sealed once: re-canonicalizing untrusted
 * bytes and calling the result "the same manifest" is how two hosts end up with two digests for
 * one proposal, so any deviation — a leading space, a reordered member, a different escape — is a
 * refusal rather than a normalization.
 */
export function parseExactCandidateManifest(bytes: Uint8Array): CandidateManifest {
  let text: string;
  try {
    text = decoder.decode(bytes);
  } catch {
    refuseAll([issue("invalid-document", "", "sealed manifest bytes are not valid UTF-8")]);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    refuseAll([issue("invalid-document", "", "sealed manifest bytes are not valid JSON")]);
  }

  const result = validateCandidateManifest(parsed);
  if (!result.ok) refuseAll(result.errors);

  if (canonicalJsonText(result.manifest) !== text) {
    refuseAll([issue("invalid-document", "",
      "these bytes are not the canonical sealed form of the manifest they carry")]);
  }
  return result.manifest;
}
