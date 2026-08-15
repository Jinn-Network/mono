// SPDX-License-Identifier: Apache-2.0

import { z } from "zod";

import type { DsseSigner, SealedRecord } from "./dsse.js";
import { parseSignedRecordEnvelope, sealSignedRecord } from "./dsse.js";
import { invalidInput } from "./errors.js";
import { TRUST_REVOCATION_FORMAT, TRUST_REVOCATION_MEDIA_TYPE } from "./identifiers.js";
import { AnchorReferenceSchema, Sha256DigestSchema } from "./types.js";
import type { ValidationDiagnostic } from "./types.js";
import { DidKeySchema, DidPkhSchema } from "./spellings.js";

/**
 * Revocation companion record (§7.4b). The record shape and non-retroactivity
 * field semantics are pinned here; the *signer-authority* rule ("valid only
 * when signed by the binding's voucher account via a fresh ceremony, or a
 * currently-valid working key of the same Agent with scope: bindings") is a
 * resolution-time rule enforced by `verify.ts` (T9), not by this schema.
 */
export const RevocationSchema = z.looseObject({
  protocol: z.literal(TRUST_REVOCATION_FORMAT),
  /** Digest of the revoked binding. */
  target: Sha256DigestSchema,
  /** The signer's identity: either the binding's voucher account (a fresh
   * ceremony) or a currently-bound working key (`scope: bindings`). */
  revokedBy: z.union([DidPkhSchema, DidKeySchema]),
  anchors: z.array(AnchorReferenceSchema),
  /** Revocation is never retroactive (§7.4b): its effect starts at its own
   * anchor time, not before. */
  effectiveFrom: z.iso.datetime(),
});
export type Revocation = z.infer<typeof RevocationSchema>;

export interface RevocationValidationReport {
  readonly conforms: boolean;
  readonly diagnostics: readonly ValidationDiagnostic[];
  readonly value?: Revocation;
}

/** Structurally parses and schema-validates a sealed revocation envelope. No
 * signer-authority or non-retroactivity resolution happens here (T9). */
export function validateRevocation(envelopeBytes: Uint8Array): RevocationValidationReport {
  let payloadBytes: Uint8Array;
  try {
    ({ payloadBytes } = parseSignedRecordEnvelope(envelopeBytes, TRUST_REVOCATION_MEDIA_TYPE));
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

  const result = RevocationSchema.safeParse(payload);
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

/** Canonicalizes and DSSE-seals a revocation record under its own vendor
 * media type (TEP §21.2). */
export async function sealRevocation(
  revocation: Revocation,
  signer: DsseSigner,
  signal?: AbortSignal,
): Promise<SealedRecord> {
  let parsed: Revocation;
  try {
    parsed = RevocationSchema.parse(revocation);
  } catch (cause) {
    return invalidInput("Revocation record does not conform to RevocationSchema.", cause);
  }
  return sealSignedRecord({
    record: parsed,
    payloadType: TRUST_REVOCATION_MEDIA_TYPE,
    signer,
    ...(signal === undefined ? {} : { signal }),
  });
}

function describeError(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
