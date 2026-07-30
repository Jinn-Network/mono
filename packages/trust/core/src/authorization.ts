// SPDX-License-Identifier: Apache-2.0

import { z } from "zod";

import { compareCodeUnitStrings } from "./order.js";
import type { DsseSigner, SealedRecord } from "./dsse.js";
import { parseSignedRecordEnvelope, sealSignedRecord } from "./dsse.js";
import { invalidInput } from "./errors.js";
import {
  AUTHORIZATION_PREDICATE_TYPE,
  DSSE_PAYLOAD_TYPE,
  IN_TOTO_STATEMENT_TYPE,
} from "./identifiers.js";
import { Sha256DigestSchema } from "./types.js";
import type { ValidationDiagnostic } from "./types.js";
import { AgentIriSchema } from "./spellings.js";

// ---------------------------------------------------------------------------
// The authorization statement family (§8.1) -- an in-toto Statement (DSSE,
// generic DSSE_PAYLOAD_TYPE) carrying UCAN-style capability semantics.
// ---------------------------------------------------------------------------

/** TEP §6.4 in-toto ResourceDescriptor, minimal shape (name + digest, plus
 * any namespaced extension fields). */
export const ResourceDescriptorSchema = z.looseObject({
  name: z.string().min(1),
  digest: z.looseObject({ sha256: z.string().regex(/^[a-f0-9]{64}$/) }),
});
export type ResourceDescriptor = z.infer<typeof ResourceDescriptorSchema>;

/** Exact-string capability. §8.1: attenuation is exact-string set inclusion
 * -- no wildcard semantics, no qualification arrays (deliberate
 * simplification of ReCap's `att` structure). */
export const AuthorizationCapabilitySchema = z.string().min(1);

export const AuthorizationPredicateSchema = z.looseObject({
  issuer: AgentIriSchema,
  /** Agent IRI or an identity class -- kept as a bare non-empty string; a
   * class name is not itself an Agent IRI. */
  audience: z.string().min(1).optional(),
  capabilities: z.array(AuthorizationCapabilitySchema).min(1),
  expiry: z.iso.datetime(),
  nonce: z.string().min(1),
  /** Digest references to parent authorizations -- attenuation-only. */
  proofs: z.array(Sha256DigestSchema).optional(),
  /** Digest reference to a companion revocation statement, where the form
   * is not declared irrevocable (§8.2). */
  revocation: Sha256DigestSchema.optional(),
});
export type AuthorizationPredicate = z.infer<typeof AuthorizationPredicateSchema>;

export const AuthorizationStatementSchema = z.looseObject({
  _type: z.literal(IN_TOTO_STATEMENT_TYPE),
  subject: z.array(ResourceDescriptorSchema).min(1),
  predicateType: z.literal(AUTHORIZATION_PREDICATE_TYPE),
  predicate: AuthorizationPredicateSchema,
});
export type AuthorizationStatement = z.infer<typeof AuthorizationStatementSchema>;

export interface AttenuationCheckResult {
  readonly valid: boolean;
  readonly reason?: string;
}

/**
 * §8.1 attenuation order: the child's capability set MUST be a subset of
 * the parent's, by exact string equality. No wildcard expansion -- a bare
 * `"*"` capability is compared as a literal string like any other.
 */
export function checkAttenuation(
  child: AuthorizationStatement,
  parent: AuthorizationStatement,
): AttenuationCheckResult {
  const parentCapabilities = new Set(parent.predicate.capabilities);
  const missing = child.predicate.capabilities.filter(
    (capability) => !parentCapabilities.has(capability),
  );
  if (missing.length > 0) {
    const sorted = [...missing].sort(compareCodeUnitStrings);
    return {
      valid: false,
      reason: `child capabilities not held by parent: ${sorted.join(", ")}`,
    };
  }
  return { valid: true };
}

export interface AuthorizationValidationReport {
  readonly conforms: boolean;
  readonly diagnostics: readonly ValidationDiagnostic[];
  readonly value?: AuthorizationStatement;
}

/** Structurally parses and schema-validates a sealed authorization
 * envelope. No cryptographic or ceremony-content-match verification here
 * (§7.5 step 1/3 territory, T9). */
export function validateAuthorization(envelopeBytes: Uint8Array): AuthorizationValidationReport {
  let payloadBytes: Uint8Array;
  try {
    ({ payloadBytes } = parseSignedRecordEnvelope(envelopeBytes, DSSE_PAYLOAD_TYPE));
  } catch (cause) {
    return {
      conforms: false,
      diagnostics: [{ code: "ENVELOPE_INVALID", path: "", message: describeError(cause) }],
    };
  }

  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(payloadBytes));
  } catch (cause) {
    return {
      conforms: false,
      diagnostics: [{ code: "PAYLOAD_NOT_JSON", path: "", message: describeError(cause) }],
    };
  }

  const result = AuthorizationStatementSchema.safeParse(payload);
  if (!result.success) {
    return {
      conforms: false,
      diagnostics: result.error.issues.map((issue) => ({
        code: "SCHEMA_VIOLATION",
        path: issue.path.join("."),
        message: issue.message,
      })),
    };
  }

  return { conforms: true, diagnostics: [], value: result.data };
}

/** Canonicalizes and DSSE-seals an authorization Statement under the
 * generic in-toto media type (§8.1; TEP §21.2 -- an assertion *about*
 * records uses DSSE_PAYLOAD_TYPE, unlike the other three record families). */
export async function sealAuthorization(
  statement: AuthorizationStatement,
  signer: DsseSigner,
  signal?: AbortSignal,
): Promise<SealedRecord> {
  let parsed: AuthorizationStatement;
  try {
    parsed = AuthorizationStatementSchema.parse(statement);
  } catch (cause) {
    return invalidInput(
      "Authorization statement does not conform to AuthorizationStatementSchema.",
      cause,
    );
  }
  return sealSignedRecord({
    record: parsed,
    payloadType: DSSE_PAYLOAD_TYPE,
    signer,
    ...(signal === undefined ? {} : { signal }),
  });
}

function describeError(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
