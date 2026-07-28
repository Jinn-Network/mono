// SPDX-License-Identifier: Apache-2.0

import { z } from "zod";

import type { DsseSigner, SealedRecord } from "./dsse.js";
import { parseSignedRecordEnvelope, sealSignedRecord } from "./dsse.js";
import { TrustCoreError, invalidInput } from "./errors.js";
import { TRUST_KEY_BINDING_FORMAT, TRUST_KEY_BINDING_MEDIA_TYPE } from "./identifiers.js";
import { AnchorReferenceSchema, Sha256DigestSchema } from "./types.js";
import { AgentIriSchema, DidKeySchema, RelationshipSchema, ScopeSchema, VoucherIdentitySchema } from "./spellings.js";

// ---------------------------------------------------------------------------
// Ceremonies (design §7.2 table). `ceremony.ts` (T8) owns cryptographic
// ceremony verification and content-matching; this module only pins the
// shape of the `ceremony` reference embedded in / referenced by a
// key-binding record, and the `strength` derivation rule.
// ---------------------------------------------------------------------------

export const CEREMONY_TYPES = ["eoa", "safe", "agentId", "oidc-machine", "github-human"] as const;
export type CeremonyType = (typeof CEREMONY_TYPES)[number];
export const CeremonyTypeSchema = z.enum(CEREMONY_TYPES);

/** Embedded or digest-referenced ceremony evidence (§7.2): `type` + a digest
 * naming the ceremony evidence bytes, with room for embedded evidence
 * fields (message, signature, witness, ...) as namespaced extensions. */
export const CeremonyReferenceSchema = z.looseObject({
  type: CeremonyTypeSchema,
  digest: Sha256DigestSchema,
});
export type CeremonyReference = z.infer<typeof CeremonyReferenceSchema>;

export const STRENGTH_VALUES = ["strong", "weak"] as const;
export type Strength = (typeof STRENGTH_VALUES)[number];
export const StrengthSchema = z.enum(STRENGTH_VALUES);

/**
 * §7.2 table: account ceremonies (EOA, Safe, agentId composition) and OIDC
 * machine ceremonies are `strong`; GitHub-human is always `weak`. `strength`
 * is derived from the ceremony type -- never producer-asserted (§7.1).
 */
export function deriveStrength(ceremonyType: CeremonyType): Strength {
  return ceremonyType === "github-human" ? "weak" : "strong";
}

// ---------------------------------------------------------------------------
// Key-binding record (§7.1).
// ---------------------------------------------------------------------------

const IRI_CONSENT_COUNTERSIGNATURE = z.object({
  keyid: DidKeySchema,
  sig: z.string().min(1),
});

export const KeyBindingSchema = z.looseObject({
  protocol: z.literal(TRUST_KEY_BINDING_FORMAT),
  agent: AgentIriSchema,
  key: z.object({
    publicKey: z.string().min(1),
    keyid: z.string().min(1),
    algorithm: z.string().min(1),
    didKey: DidKeySchema,
  }),
  voucher: VoucherIdentitySchema,
  relationship: RelationshipSchema,
  scope: z.array(ScopeSchema).min(1),
  validFrom: z.iso.datetime(),
  expiresAt: z.iso.datetime().optional(),
  ceremony: CeremonyReferenceSchema,
  strength: StrengthSchema,
  supersedes: Sha256DigestSchema.optional(),
  consent: IRI_CONSENT_COUNTERSIGNATURE.optional(),
  anchors: z.array(AnchorReferenceSchema),
});
export type KeyBinding = z.infer<typeof KeyBindingSchema>;

export interface ValidationDiagnostic {
  readonly code: string;
  readonly path: string;
  readonly message: string;
}

export interface KeyBindingValidationReport {
  readonly conforms: boolean;
  readonly diagnostics: readonly ValidationDiagnostic[];
  readonly value?: KeyBinding;
}

/**
 * Structurally parses a sealed key-binding envelope and checks schema
 * conformance plus the derived-`strength` consistency rule. Does **not**
 * cryptographically verify the envelope signature or the ceremony's
 * authority -- a valid binding never implies trust (§7.5 rungs stay
 * separate); that verification is `verify.ts`'s job (T9).
 */
export function validateKeyBinding(envelopeBytes: Uint8Array): KeyBindingValidationReport {
  let payloadBytes: Uint8Array;
  try {
    ({ payloadBytes } = parseSignedRecordEnvelope(envelopeBytes, TRUST_KEY_BINDING_MEDIA_TYPE));
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

  const result = KeyBindingSchema.safeParse(payload);
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

  const value = result.data;
  const expectedStrength = deriveStrength(value.ceremony.type);
  if (value.strength !== expectedStrength) {
    return {
      conforms: false,
      diagnostics: [
        {
          code: "STRENGTH_MISMATCH",
          path: "strength",
          message: `ceremony type "${value.ceremony.type}" derives strength "${expectedStrength}", but the record asserts "${value.strength}".`,
        },
      ],
      value,
    };
  }

  return { conforms: true, diagnostics: [], value };
}

/**
 * Canonicalizes and DSSE-seals a key-binding record under its own vendor
 * media type (TEP §21.2). The envelope signature proves possession of the
 * working key only -- binding authority comes exclusively from the
 * ceremony; `sealKeyBinding` does not (and must not) grant authority.
 */
export async function sealKeyBinding(
  binding: KeyBinding,
  signer: DsseSigner,
  signal?: AbortSignal,
): Promise<SealedRecord> {
  let parsed: KeyBinding;
  try {
    parsed = KeyBindingSchema.parse(binding);
  } catch (cause) {
    return invalidInput("Key-binding record does not conform to KeyBindingSchema.", cause);
  }
  return sealSignedRecord({
    record: parsed,
    payloadType: TRUST_KEY_BINDING_MEDIA_TYPE,
    signer,
    ...(signal === undefined ? {} : { signal }),
  });
}

function describeError(cause: unknown): string {
  return cause instanceof TrustCoreError || cause instanceof Error ? cause.message : String(cause);
}
