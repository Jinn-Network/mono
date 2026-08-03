// SPDX-License-Identifier: MIT

/**
 * NAIVE REFERENCE — candidate manifest sealing and validation (substrate §5.1–§5.3).
 *
 * `validateCandidateManifest` checks shape, digest forms, typed parent references, tuple
 * canonicalization round-trip, extension preservation, and rejects any unrecognized
 * **non-namespaced** top-level field. It does **not** fetch parents, verify signatures (host
 * concern via the trust layer), or materialize policies (backend concern). Fail-closed on
 * malformed input, and it collects *every* issue rather than stopping at the first — a proposer
 * fixing one field at a time is a worse experience than one honest list.
 */

import { CANDIDATE_MANIFEST_FORMAT_TOKEN } from "../../src/tokens.js";
import type {
  CandidateManifest,
  SealedDocument,
  ValidationIssue,
  ValidationResult,
} from "../../src/types.js";
import { canonicalJsonBytes, canonicalJsonText } from "./canonical.js";
import { ReferencePolicyIdentityError } from "./errors.js";
import { prefixedDigest, SHA256_PREFIXED_PATTERN } from "./hashing.js";
import { assertValidTuple } from "./tuple.js";

const KNOWN_TOP_LEVEL_FIELDS = new Set([
  "formatToken",
  "policy",
  "parents",
  "proposer",
  "evidenceProvenance",
  "declaredChanges",
  "compatibility",
]);

/** TEP §21.3 extension names: reverse-DNS, or an absolute URI. Mirrored, not imported. */
const REVERSE_DNS_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9-]*(\.[A-Za-z][A-Za-z0-9-]*)+$/;

export function isNamespacedExtensionKey(key: string): boolean {
  if (REVERSE_DNS_KEY_PATTERN.test(key)) return true;
  try {
    return new URL(key).protocol.length > 1;
  } catch {
    return false;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

/**
 * Substrate §5.2 — candidate identity is sha256 of the sealed manifest bytes. Sealed once:
 * whatever these bytes are, they are the manifest forever.
 */
export function sealCandidateManifest(manifest: CandidateManifest): SealedDocument {
  const result = validateCandidateManifest(manifest);
  if (!result.ok) {
    throw new ReferencePolicyIdentityError(
      result.errors[0]?.code ?? "invalid-document",
      `candidate manifest failed validation at sealing: ${result.errors.map((e) => `${e.path}: ${e.message}`).join("; ")}`,
      result.errors,
    );
  }
  const bytes = canonicalJsonBytes(manifest);
  return { bytes, digest: prefixedDigest(bytes) };
}

/**
 * Sealed-bytes round-trip: the input bytes must already BE the one canonical encoding. A
 * document that merely *parses* is not the document — re-canonicalizing untrusted bytes and
 * calling the result "the same manifest" is how two hosts end up with two digests for one
 * proposal.
 */
export function parseExactCandidateManifest(bytes: Uint8Array): CandidateManifest {
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new ReferencePolicyIdentityError("invalid-document", "manifest bytes are not valid UTF-8 JSON");
  }
  const result = validateCandidateManifest(json);
  if (!result.ok) {
    throw new ReferencePolicyIdentityError(
      result.errors[0]?.code ?? "invalid-document",
      "manifest bytes failed validation",
      result.errors,
    );
  }
  const canonical = canonicalJsonBytes(result.manifest);
  if (canonical.length !== bytes.length || !canonical.every((byte, index) => byte === bytes[index])) {
    throw new ReferencePolicyIdentityError(
      "invalid-document",
      "manifest bytes are not the exact canonical JSON encoding",
    );
  }
  return result.manifest;
}

export function validateCandidateManifest(input: unknown): ValidationResult {
  const errors: ValidationIssue[] = [];
  const push = (path: string, code: ValidationIssue["code"], message: string): void => {
    errors.push({ path, code, message });
  };

  if (!isPlainObject(input)) {
    return { ok: false, errors: [{ path: "", code: "invalid-document", message: "candidate manifest must be a JSON object" }] };
  }

  // --- unrecognized non-namespaced top-level fields (§5.3) ------------------------------------
  // This is the *checkable* form of the no-self-score rule: `score`, `confidence`, `rank` and
  // friends are all caught here. Extension-borne self-assessment cannot be prevented by
  // validation and is a consumer-MUST-ignore rule instead (§5.3).
  for (const key of Object.keys(input)) {
    if (KNOWN_TOP_LEVEL_FIELDS.has(key)) continue;
    if (isNamespacedExtensionKey(key)) continue;
    push(key, "unrecognized-field", `unrecognized non-namespaced top-level field "${key}"`);
  }

  if (input["formatToken"] !== CANDIDATE_MANIFEST_FORMAT_TOKEN) {
    push("formatToken", "invalid-document", `expected ${CANDIDATE_MANIFEST_FORMAT_TOKEN}`);
  }

  // --- policy: a valid tuple, and canonicalization round-trips --------------------------------
  const policy = input["policy"];
  try {
    assertValidTuple(policy);
    // Round-trip: canonicalizing and re-parsing must reproduce the same value. Catches anything
    // the canonical encoding cannot carry losslessly.
    const reparsed = JSON.parse(canonicalJsonText(policy)) as unknown;
    if (canonicalJsonText(reparsed) !== canonicalJsonText(policy)) {
      push("policy", "invalid-document", "tuple does not survive a canonicalization round-trip");
    }
  } catch (error) {
    const category = error instanceof ReferencePolicyIdentityError ? error.category : "invalid-document";
    const message = error instanceof Error ? error.message : String(error);
    push("policy", category, message);
  }

  // --- parents[]: typed references (§5.1) -----------------------------------------------------
  const parents = input["parents"];
  if (!Array.isArray(parents)) {
    push("parents", "malformed-parent", "parents must be an array (empty for seeds)");
  } else {
    parents.forEach((parent, index) => {
      const path = `parents.${index}`;
      if (!isPlainObject(parent)) {
        push(path, "malformed-parent", "parent reference must be an object");
        return;
      }
      if (parent["kind"] !== "candidate" && parent["kind"] !== "tuple") {
        push(`${path}.kind`, "malformed-parent", 'parent kind must be "candidate" or "tuple"');
      }
      if (typeof parent["digest"] !== "string" || !SHA256_PREFIXED_PATTERN.test(parent["digest"])) {
        push(`${path}.digest`, "malformed-parent", "parent digest must be sha256:<64 lowercase hex>");
      }
    });
    // A repeated `(kind, digest)` pair is not a second parent; it inflates the lineage graph's
    // in-degree for free. Refuse rather than silently de-duplicate.
    const seen = new Set<string>();
    parents.forEach((parent, index) => {
      if (!isPlainObject(parent)) return;
      const key = `${String(parent["kind"])}${String(parent["digest"])}`;
      if (seen.has(key)) {
        push(`parents.${index}`, "malformed-parent", "duplicate parent reference");
      }
      seen.add(key);
    });
  }

  if (typeof input["proposer"] !== "string" || input["proposer"].length === 0) {
    push("proposer", "invalid-document", "proposer must be a non-empty Agent IRI");
  }

  // --- evidenceProvenance (§5.1): digests-only, all three legs required -----------------------
  const provenance = input["evidenceProvenance"];
  if (!isPlainObject(provenance)) {
    push("evidenceProvenance", "missing-provenance", "evidenceProvenance is required");
  } else {
    for (const digestField of ["savedQueryDigest", "recordListDigest"]) {
      const value = provenance[digestField];
      if (typeof value !== "string" || !SHA256_PREFIXED_PATTERN.test(value)) {
        push(
          `evidenceProvenance.${digestField}`,
          "missing-provenance",
          `${digestField} must be sha256:<64 lowercase hex>`,
        );
      }
    }
    const receipt = provenance["snapshotReceipt"];
    if (!isPlainObject(receipt)) {
      push("evidenceProvenance.snapshotReceipt", "missing-provenance", "snapshotReceipt is required");
    } else {
      if (typeof receipt["savedQueryDigest"] !== "string" || !SHA256_PREFIXED_PATTERN.test(receipt["savedQueryDigest"])) {
        push("evidenceProvenance.snapshotReceipt.savedQueryDigest", "missing-provenance", "must be sha256:<64 lowercase hex>");
      } else if (receipt["savedQueryDigest"] !== provenance["savedQueryDigest"]) {
        // Two spellings of the same fact must agree, or the provenance names two queries.
        push(
          "evidenceProvenance.snapshotReceipt.savedQueryDigest",
          "missing-provenance",
          "snapshot receipt names a different saved query than evidenceProvenance.savedQueryDigest",
        );
      }
      if (!isPlainObject(receipt["sourceSet"])) {
        push("evidenceProvenance.snapshotReceipt.sourceSet", "missing-provenance", "sourceSet is required");
      }
      if (!Array.isArray(receipt["sources"])) {
        push("evidenceProvenance.snapshotReceipt.sources", "missing-provenance", "sources must be an array");
      }
      if (typeof receipt["evaluatedAt"] !== "string") {
        push("evidenceProvenance.snapshotReceipt.evaluatedAt", "missing-provenance", "evaluatedAt is required");
      }
      if (receipt["reproducibility"] !== "replayable" && receipt["reproducibility"] !== "not-replayable") {
        push(
          "evidenceProvenance.snapshotReceipt.reproducibility",
          "missing-provenance",
          'reproducibility must be "replayable" or "not-replayable"',
        );
      }
    }
  }

  // --- declaredChanges (§5.1) -----------------------------------------------------------------
  const declared = input["declaredChanges"];
  if (!isPlainObject(declared)) {
    push("declaredChanges", "invalid-document", "declaredChanges is required");
  } else {
    if (typeof declared["summary"] !== "string") {
      push("declaredChanges.summary", "invalid-document", "summary must be a string");
    }
    if (!isStringArray(declared["touchedComponents"])) {
      push("declaredChanges.touchedComponents", "invalid-document", "touchedComponents must be an array of strings");
    }
  }

  // --- compatibility: optional, declared, not verified (§5.1) ---------------------------------
  const compatibility = input["compatibility"];
  if (compatibility !== undefined) {
    if (!isPlainObject(compatibility)) {
      push("compatibility", "invalid-document", "compatibility must be an object when present");
    } else {
      for (const field of ["taskProfiles", "harnesses", "models"]) {
        const value = compatibility[field];
        if (value !== undefined && !isStringArray(value)) {
          push(`compatibility.${field}`, "invalid-document", `${field} must be an array of strings`);
        }
      }
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  // Extension preservation: the input object is returned as-is, so namespaced extensions ride
  // through untouched. Nothing is reconstructed, stripped, or defaulted.
  return { ok: true, manifest: input as unknown as CandidateManifest };
}
