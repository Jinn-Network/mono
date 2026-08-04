// SPDX-License-Identifier: MIT

/**
 * NAIVE REFERENCE — the DSSE in-toto Statement binding (substrate §5.2).
 *
 * "The DSSE payload shape is pinned: an in-toto Statement whose subject is the sealed manifest
 * (digest + name), with `predicateType` = the format token and the manifest as predicate.
 * Raw-bytes signing is not a conforming alternative."
 *
 * What this module checks is the **binding**: that the envelope, the Statement, and the manifest
 * are three views of one document. What it deliberately does NOT check is the signature —
 * §5.3 assigns signature verification to the host via the trust layer, and `policy-identity`
 * ships no trust dependency. `verifyEd25519Signature` below exists for *fixture integrity*
 * (proving the kit's DSSE fixtures carry real signatures rather than plausible-looking noise)
 * and is exercised only by the kit's own tests.
 */

import { ed25519 } from "@noble/curves/ed25519.js";
import { hexToBytes } from "@noble/hashes/utils.js";

import {
  CANDIDATE_MANIFEST_FORMAT_TOKEN,
  DSSE_PAYLOAD_TYPE,
  IN_TOTO_STATEMENT_TYPE,
} from "../../src/tokens.js";
import type { CandidateManifest, ValidationIssue, ValidationResult } from "../../src/types.js";
import { canonicalJsonBytes } from "./canonical.js";
import { sha256Hex, SHA256_BARE_HEX_PATTERN } from "./hashing.js";
import { validateCandidateManifest } from "./manifest.js";

export interface DsseEnvelope {
  readonly payloadType: string;
  /** Standard base64 of the Statement's exact bytes. */
  readonly payload: string;
  readonly signatures: readonly { readonly keyid?: string; readonly sig: string }[];
}

/** DSSE Pre-Authentication Encoding: `DSSEv1 SP len(type) SP type SP len(body) SP body`. */
export function preAuthenticationEncoding(payloadType: string, payload: Uint8Array): Uint8Array {
  const encoder = new TextEncoder();
  const header = encoder.encode(
    `DSSEv1 ${payloadType.length} ${payloadType} ${payload.length} `,
  );
  const out = new Uint8Array(header.length + payload.length);
  out.set(header, 0);
  out.set(payload, header.length);
  return out;
}

export function verifyEd25519Signature(
  envelope: DsseEnvelope,
  publicKeyHex: string,
  signatureHex: string,
): boolean {
  const payload = decodeBase64Strict(envelope.payload);
  if (payload === undefined) return false;
  return ed25519.verify(
    hexToBytes(signatureHex),
    preAuthenticationEncoding(envelope.payloadType, payload),
    hexToBytes(publicKeyHex),
  );
}

const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;

function decodeBase64Strict(value: string): Uint8Array | undefined {
  if (!BASE64_PATTERN.test(value)) return undefined;
  try {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  } catch {
    return undefined;
  }
}

export type StatementBindingResult = ValidationResult;

/**
 * Verifies that `envelope` carries an in-toto Statement that binds to `manifest` — the whole
 * chain, in one place, so a verifier cannot accidentally check only half of it:
 *
 *   payloadType → Statement `_type` → `predicateType` → subject digest → predicate bytes.
 *
 * The last link is the one an attacker reaches for: a Statement whose *subject* names an honest
 * manifest's digest while its *predicate* carries a different manifest. Re-sealing the predicate
 * and requiring the result to equal the subject digest closes it.
 */
export function verifyCandidateStatementBinding(envelope: unknown): StatementBindingResult {
  const errors: ValidationIssue[] = [];
  const push = (path: string, message: string): void => {
    errors.push({ path, code: "statement-binding", message });
  };

  if (typeof envelope !== "object" || envelope === null || Array.isArray(envelope)) {
    return { ok: false, errors: [{ path: "", code: "statement-binding", message: "DSSE envelope must be an object" }] };
  }
  const env = envelope as Record<string, unknown>;

  if (env["payloadType"] !== DSSE_PAYLOAD_TYPE) {
    push("payloadType", `expected ${DSSE_PAYLOAD_TYPE}`);
  }
  if (!Array.isArray(env["signatures"]) || env["signatures"].length === 0) {
    push("signatures", "DSSE envelope requires at least one signature");
  }
  if (typeof env["payload"] !== "string") {
    return { ok: false, errors: [...errors, { path: "payload", code: "statement-binding", message: "payload must be a base64 string" }] };
  }
  const payloadBytes = decodeBase64Strict(env["payload"]);
  if (payloadBytes === undefined) {
    return { ok: false, errors: [...errors, { path: "payload", code: "statement-binding", message: "payload is not strict standard base64" }] };
  }

  let statement: unknown;
  try {
    statement = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(payloadBytes));
  } catch {
    return { ok: false, errors: [...errors, { path: "payload", code: "statement-binding", message: "decoded payload is not valid UTF-8 JSON" }] };
  }
  if (typeof statement !== "object" || statement === null || Array.isArray(statement)) {
    return { ok: false, errors: [...errors, { path: "payload", code: "statement-binding", message: "payload is not an in-toto Statement object" }] };
  }
  const stmt = statement as Record<string, unknown>;

  if (stmt["_type"] !== IN_TOTO_STATEMENT_TYPE) {
    push("payload._type", `expected ${IN_TOTO_STATEMENT_TYPE}`);
  }
  if (stmt["predicateType"] !== CANDIDATE_MANIFEST_FORMAT_TOKEN) {
    push("payload.predicateType", `expected ${CANDIDATE_MANIFEST_FORMAT_TOKEN}`);
  }

  const manifestResult = validateCandidateManifest(stmt["predicate"]);
  if (!manifestResult.ok) {
    for (const issue of manifestResult.errors) {
      errors.push({ path: `payload.predicate.${issue.path}`, code: issue.code, message: issue.message });
    }
    return { ok: false, errors };
  }
  const manifest: CandidateManifest = manifestResult.manifest;
  const expectedHex = sha256Hex(canonicalJsonBytes(manifest));

  const subject = stmt["subject"];
  // Exactly one: §5.2 pins the subject as THE sealed manifest. A second subject would make the
  // Statement's claim ambiguous, and the two implementations must refuse identically.
  if (!Array.isArray(subject) || subject.length !== 1) {
    push("payload.subject", "the Statement must name exactly one subject: the sealed manifest");
    return { ok: false, errors };
  }
  const first = subject[0] as Record<string, unknown> | undefined;
  const digestMap = first?.["digest"] as Record<string, unknown> | undefined;
  const subjectHex = digestMap?.["sha256"];
  if (typeof first?.["name"] !== "string" || first["name"].length === 0) {
    push("payload.subject.0.name", "subject entry requires a name");
  }
  if (typeof subjectHex !== "string" || !SHA256_BARE_HEX_PATTERN.test(subjectHex)) {
    push("payload.subject.0.digest.sha256", "subject digest must be 64 lowercase hex digits");
  } else if (subjectHex !== expectedHex) {
    push(
      "payload.subject.0.digest.sha256",
      `subject digest ${subjectHex} does not equal the sealed predicate's digest ${expectedHex}`,
    );
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, manifest };
}
