// SPDX-License-Identifier: MIT

/**
 * The DSSE in-toto Statement binding (substrate §5.2).
 *
 * The payload shape is **pinned**: an in-toto Statement whose subject is the sealed manifest
 * (digest + name), `predicateType` = the candidate format token, and the manifest itself as
 * predicate — the stack's Result Evaluation Statement precedent, so verifiers reuse one procedure.
 * Raw-bytes signing is not a conforming alternative, which is why an envelope carrying no
 * signatures is refused here rather than treated as an unsigned-but-structurally-fine document.
 *
 * **What this module checks is the binding, not the signer.** Resolving the proposer IRI and
 * deciding whether its key is trusted is the host's job through the trust layer (§5.2/§5.3).
 * `verifyEd25519Signature` is offered because a verifier needs the DSSE pre-authentication
 * encoding to be computed exactly once and identically by everyone — but a valid signature alone
 * proves nothing about which manifest was signed. That is the whole point of the two negative
 * fixtures: in both, the signature is genuine, and in both the binding is refused.
 */

import { ed25519 } from "@noble/curves/ed25519.js";

import { issue } from "./errors.js";
import { sealCandidateManifest } from "./manifest.js";
import {
  CANDIDATE_MANIFEST_FORMAT_TOKEN,
  DSSE_PAYLOAD_TYPE,
  IN_TOTO_STATEMENT_TYPE,
} from "./tokens.js";
import type { CandidateManifest, ValidationIssue, ValidationResult } from "./types.js";

export interface DsseSignature {
  readonly keyid?: string;
  readonly sig: string;
}

export interface DsseEnvelope {
  readonly payloadType: string;
  /** base64 of the in-toto Statement bytes. */
  readonly payload: string;
  readonly signatures: readonly DsseSignature[];
}

export type StatementBindingResult = ValidationResult;

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const HEX_PATTERN = /^(?:[0-9a-fA-F]{2})+$/;

/**
 * DSSEv1 pre-authentication encoding: `DSSEv1 <len(type)> <type> <len(payload)> <payload>`, with
 * both lengths counted in **bytes**. Signing the bare payload instead would let one signature be
 * replayed under a different payloadType.
 */
export function preAuthenticationEncoding(payloadType: string, payload: Uint8Array): Uint8Array {
  const typeBytes = encoder.encode(payloadType);
  const header = encoder.encode(
    `DSSEv1 ${typeBytes.length} ${payloadType} ${payload.length} `,
  );
  const pae = new Uint8Array(header.length + payload.length);
  pae.set(header, 0);
  pae.set(payload, header.length);
  return pae;
}

function decodeStrictBase64(value: string): Uint8Array | undefined {
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

function decodeHex(value: string): Uint8Array | undefined {
  if (!HEX_PATTERN.test(value)) return undefined;
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

/**
 * Verifies one ed25519 signature over the envelope's PAE. Returns `false` — never throws — for
 * every malformed input, so a caller cannot accidentally treat a decoding failure as a pass.
 */
export function verifyEd25519Signature(
  envelope: DsseEnvelope,
  publicKeyHex: string,
  signatureHex: string,
): boolean {
  const payload = decodeStrictBase64(envelope.payload);
  const publicKey = decodeHex(publicKeyHex);
  const signature = decodeHex(signatureHex);
  if (payload === undefined || publicKey === undefined || signature === undefined) return false;
  try {
    return ed25519.verify(signature, preAuthenticationEncoding(envelope.payloadType, payload), publicKey);
  } catch {
    return false;
  }
}

function refused(errors: ValidationIssue[]): StatementBindingResult {
  return { ok: false, errors };
}

/**
 * Checks that a DSSE envelope carries a conforming in-toto Statement whose subject names the
 * manifest its predicate actually contains.
 *
 * The subject/predicate equality is the check that closes the interesting attack: a verifier that
 * authenticates the envelope and then reads the predicate has accepted a manifest the signer's
 * subject line does not name. Only re-sealing the predicate and requiring the digest to match the
 * subject closes it.
 */
export function verifyCandidateStatementBinding(envelope: unknown): StatementBindingResult {
  if (typeof envelope !== "object" || envelope === null || Array.isArray(envelope)) {
    return refused([issue("statement-binding", "", "a DSSE envelope must be a JSON object")]);
  }
  const candidate = envelope as Record<string, unknown>;
  const errors: ValidationIssue[] = [];

  if (candidate["payloadType"] !== DSSE_PAYLOAD_TYPE) {
    errors.push(issue("statement-binding", "payloadType",
      `payloadType must be ${DSSE_PAYLOAD_TYPE}`));
  }

  const signatures = candidate["signatures"];
  if (!Array.isArray(signatures) || signatures.length === 0) {
    errors.push(issue("statement-binding", "signatures",
      "a conforming envelope carries at least one signature; raw-bytes signing is not an alternative"));
  }

  const rawPayload = candidate["payload"];
  const payloadBytes = typeof rawPayload === "string" ? decodeStrictBase64(rawPayload) : undefined;
  if (payloadBytes === undefined) {
    errors.push(issue("statement-binding", "payload", "payload must be strict base64"));
    return refused(errors);
  }

  let statement: unknown;
  try {
    statement = JSON.parse(decoder.decode(payloadBytes));
  } catch {
    errors.push(issue("statement-binding", "payload",
      "payload is not a UTF-8 JSON in-toto Statement"));
    return refused(errors);
  }
  if (typeof statement !== "object" || statement === null || Array.isArray(statement)) {
    errors.push(issue("statement-binding", "payload", "the Statement must be a JSON object"));
    return refused(errors);
  }
  const parsed = statement as Record<string, unknown>;

  if (parsed["_type"] !== IN_TOTO_STATEMENT_TYPE) {
    errors.push(issue("statement-binding", "payload._type",
      `_type must be ${IN_TOTO_STATEMENT_TYPE}`));
  }
  if (parsed["predicateType"] !== CANDIDATE_MANIFEST_FORMAT_TOKEN) {
    // Not a near-miss to be tolerated: predicateType is a claim about which verification
    // procedure applies, and a candidate manifest does not honor SLSA provenance semantics.
    errors.push(issue("statement-binding", "payload.predicateType",
      `predicateType must be ${CANDIDATE_MANIFEST_FORMAT_TOKEN}`));
  }

  let sealedDigest: string | undefined;
  try {
    sealedDigest = sealCandidateManifest(parsed["predicate"] as CandidateManifest).digest;
  } catch {
    errors.push(issue("statement-binding", "payload.predicate",
      "the predicate is not a valid candidate manifest"));
  }

  const subject = parsed["subject"];
  if (!Array.isArray(subject) || subject.length !== 1) {
    errors.push(issue("statement-binding", "payload.subject",
      "the Statement must name exactly one subject: the sealed manifest"));
  } else {
    const entry = subject[0] as { name?: unknown; digest?: Record<string, unknown> } | null;
    // §5.2 pins the subject as "the sealed manifest (digest + name)". The name is not decorative:
    // a ResourceDescriptor carrying a digest and nothing else tells a verifier what was signed but
    // not what it is, and in-toto's own rule is that a descriptor identifies its artifact by more
    // than the digest alone.
    if (typeof entry?.name !== "string" || entry.name === "") {
      errors.push(issue("statement-binding", "payload.subject.0.name",
        "the subject must name the sealed manifest, not only digest it"));
    }
    if (sealedDigest !== undefined) {
      const named = entry?.digest?.["sha256"];
      if (typeof named !== "string" || `sha256:${named}` !== sealedDigest) {
        errors.push(issue("statement-binding", "payload.subject.0.digest.sha256",
          "the subject digest does not name the manifest carried in the predicate"));
      }
    }
  }

  if (errors.length > 0) return refused(errors);
  return { ok: true, manifest: parsed["predicate"] as CandidateManifest };
}
