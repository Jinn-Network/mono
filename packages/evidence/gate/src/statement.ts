// SPDX-License-Identifier: Apache-2.0

import { isNormalizedAbsoluteUri, namespacedObject } from "@jinn-network/evidence-offer";
import {
  canonicalJsonBytes,
  isCalendarStrictRfc3339,
  parseExactDsseEnvelope,
  recordDigest,
  sealSignedPayload,
  Sha256DigestSchema,
} from "@jinn-network/trust-core";
import type {
  DsseEnvelopeSignature,
  DsseSigner,
  Sha256Digest,
} from "@jinn-network/trust-core";
import { z } from "zod";

import {
  DELIVERY_STATEMENT_RECORD_KIND,
  DELIVERY_STATEMENT_RECORD_MEDIA_TYPE,
} from "./identifiers.js";

export interface ValidationIssue {
  readonly path: string;
  readonly message: string;
}

/**
 * Thrown when a document fails validation at the sealing boundary, or when bytes handed to
 * a parser are not the one exact canonical encoding. Carries the tree-wide plain
 * `{ category: "invalid-document", errors }` shape — catch on `category`, not on the class.
 */
export class InvalidDeliveryStatementError extends Error {
  readonly category = "invalid-document" as const;
  override readonly name = "InvalidDeliveryStatementError";

  constructor(readonly errors: readonly ValidationIssue[]) {
    super("delivery statement failed validation at the sealing boundary");
  }
}

function invalid(path: string, message: string): never {
  throw new InvalidDeliveryStatementError([{ path, message }]);
}

/**
 * The same two rules the offer schema puts on a payment destination, on the field with the
 * same job and for the same reason: a payment reference is what a human reads back in a
 * dispute, so it must carry something visible and must not be able to render as a different
 * reference. Restated here rather than imported because the offer package exports its
 * *identifier* discipline and not its field vocabulary; the authority is
 * `packages/evidence/offer/src/schema.ts`, and the two must not drift apart.
 */
const DISPLAY_UNSAFE_CHARACTER =
  /[\u0000-\u001F\u007F-\u009F\u061C\u200E\u200F\u2028\u2029\u202A-\u202E\u2066-\u2069]/u;
const VISIBLE_CHARACTER = /[^\s\p{Cf}]/u;

const PaymentReference = z
  .string()
  .refine(
    (value) => VISIBLE_CHARACTER.test(value),
    "reference must carry at least one character that is neither whitespace nor a Unicode "
      + "format character",
  )
  .refine(
    (value) => !DISPLAY_UNSAFE_CHARACTER.test(value),
    "reference must not carry control characters, line separators, or Unicode bidi "
      + "controls, which make one payment reference display as another",
  );

/**
 * Which payment this delivery was against.
 *
 * `reference` is a string rather than open JSON. On every rail that exists it is a
 * transaction hash or an invoice id, and keeping it a string keeps a sealed statement inside
 * the I-JSON subset without inheriting the whole opaque-value canonicalization problem for a
 * generality no rail has asked for. A rail that genuinely needs structure puts it in a
 * namespaced extension key, which this object stays open to.
 */
export const DeliveryStatementPaymentSchema = namespacedObject({
  rail: z
    .string()
    .refine(
      isNormalizedAbsoluteUri,
      "rail must be the same normalized absolute URI the offer's sealed rail entry carries",
    ),
  reference: PaymentReference,
});
export type DeliveryStatementPayment = z.infer<typeof DeliveryStatementPaymentSchema>;

/**
 * What the holder says they handed over, and on what terms.
 *
 * `payment` absent is the free path — an offer with no rails is served on sight, and there
 * is no payment to name. Absence is the only spelling of that, for the same reason an empty
 * `rails` list is the only spelling of a free offer: two spellings of one fact seal to two
 * digests.
 *
 * The statement carries no price. The offer it names carries the terms, sealed; restating an
 * amount here would be a second copy of a number that can disagree with the first.
 */
export const DeliveryStatementSchema = namespacedObject({
  kind: z.literal(DELIVERY_STATEMENT_RECORD_KIND),
  offer: Sha256DigestSchema,
  subject: Sha256DigestSchema,
  payment: DeliveryStatementPaymentSchema.optional(),
  deliveredAt: z
    .string()
    .refine(isCalendarStrictRfc3339, "deliveredAt must be a calendar-strict RFC 3339 instant"),
});
export type DeliveryStatement = z.infer<typeof DeliveryStatementSchema>;

/**
 * `JSON.parse` gives `__proto__` as an ordinary own member, but zod's object copy assigns
 * through the prototype setter and the member never reaches the output. A seal that drops a
 * member is worse than one that refuses the document, so this refuses. (The offer package
 * makes the same refusal for the same reason and keeps it private; this is the sibling.)
 */
function assertNoPrototypeMember(value: unknown, path: string): void {
  if (Array.isArray(value)) {
    value.forEach((element, index) =>
      assertNoPrototypeMember(element, `${path}${path ? "." : ""}${index}`));
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, member] of Object.entries(value)) {
    const memberPath = `${path}${path ? "." : ""}${key}`;
    if (key === "__proto__") {
      invalid(
        memberPath,
        'a "__proto__" member cannot survive sealing and is refused, never dropped',
      );
    }
    assertNoPrototypeMember(member, memberPath);
  }
}

/**
 * Zod keeps a known-optional key that was present-but-undefined in the input. JCS has no
 * undefined token and an object member has a key to omit by, so those members are dropped
 * here: a statement that omits `payment` and one that spells it `undefined` are the same
 * delivery and must seal to the same bytes. An array element cannot be omitted that way, so
 * an undefined element is refused instead.
 */
function withoutUndefinedMembers(value: unknown, path: string): unknown {
  if (Array.isArray(value)) {
    return value.map((element, index) => {
      const elementPath = `${path}${path ? "." : ""}${index}`;
      if (element === undefined) {
        invalid(elementPath, "array elements must not be undefined; JCS has no undefined token");
      }
      return withoutUndefinedMembers(element, elementPath);
    });
  }
  if (value === null || typeof value !== "object") return value;
  const output: Record<string, unknown> = {};
  for (const [key, member] of Object.entries(value)) {
    if (member === undefined) continue;
    output[key] = withoutUndefinedMembers(member, `${path}${path ? "." : ""}${key}`);
  }
  return output;
}

function validate(document: unknown): DeliveryStatement {
  assertNoPrototypeMember(document, "");
  const parsed = DeliveryStatementSchema.safeParse(document);
  if (!parsed.success) {
    throw new InvalidDeliveryStatementError(
      parsed.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    );
  }
  return parsed.data;
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * Validated record to its one canonical encoding — the single canonicalization point.
 *
 * The schema stays open to namespaced extension keys, so a value can validate here and still
 * sit outside the I-JSON subset the canonicalizer accepts (a non-integral number, a string
 * holding an unpaired surrogate). Those reach this function from a hostile envelope, not only
 * from a local producer, so trust-core's error is converted rather than allowed to escape:
 * this boundary promises `category: "invalid-document"`.
 */
function canonicalBytes(statement: DeliveryStatement): Uint8Array {
  try {
    return canonicalJsonBytes(withoutUndefinedMembers(statement, ""));
  } catch (cause) {
    invalid("", `delivery statement is not canonicalizable JSON: ${describe(cause)}`);
  }
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

/** Validate, then canonicalize once. These bytes are the statement's DSSE payload forever. */
export function sealDeliveryStatementPayload(document: unknown): Uint8Array {
  return canonicalBytes(validate(document));
}

/**
 * Decode, validate, and require the input to be the one exact canonical encoding. A consumer
 * never re-canonicalizes to check a digest — re-canonicalizing would let two distinct byte
 * strings present as the same statement.
 */
export function parseExactDeliveryStatementPayload(bytes: Uint8Array): DeliveryStatement {
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    invalid("", "payload bytes are not valid UTF-8 JSON");
  }
  const statement = validate(json);
  if (!bytesEqual(canonicalBytes(statement), bytes)) {
    invalid("", "payload bytes are not the exact canonical JSON encoding of this statement");
  }
  return statement;
}

export interface SealedDeliveryStatement {
  /** The record: a DSSE envelope over the canonical payload, signed by the holder. */
  readonly envelopeBytes: Uint8Array;
  readonly payloadBytes: Uint8Array;
  /** The statement's identity — the digest of the sealed envelope. */
  readonly digest: Sha256Digest;
  readonly statement: DeliveryStatement;
}

export interface SealDeliveryStatementInput {
  readonly statement: unknown;
  /**
   * Signing is required. An unsigned statement would be provenance anyone could write for
   * anyone else's sale, which is the opposite of what a buyer wants it for.
   */
  readonly signer: DsseSigner;
  readonly signal?: AbortSignal;
}

/** Seals the canonical payload and DSSE-signs it under the statement media type (TEP §21.2). */
export async function sealDeliveryStatement(
  input: SealDeliveryStatementInput,
): Promise<SealedDeliveryStatement> {
  const statement = validate(input.statement);
  const payloadBytes = canonicalBytes(statement);
  const sealed = await sealSignedPayload({
    payloadBytes,
    payloadType: DELIVERY_STATEMENT_RECORD_MEDIA_TYPE,
    signer: input.signer,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  return {
    envelopeBytes: sealed.envelopeBytes,
    payloadBytes: sealed.payloadBytes,
    digest: sealed.recordDigest,
    statement,
  };
}

export interface ParsedDeliveryStatement {
  readonly statement: DeliveryStatement;
  readonly payloadBytes: Uint8Array;
  readonly signatures: readonly DsseEnvelopeSignature[];
  readonly digest: Sha256Digest;
}

/**
 * Structurally parses a sealed statement envelope: exact producer encoding, expected
 * `payloadType`, exact canonical payload. The strict DSSE parser rather than the structural
 * one, because the statement's identity is the digest of these envelope bytes.
 *
 * No signature is checked here. Resolving the holder's signature through key-binding records
 * is the buyer's own step, exactly as it is for the offer, and a structurally valid statement
 * never implies an authentic one.
 */
export function parseDeliveryStatementEnvelope(
  envelopeBytes: Uint8Array,
): ParsedDeliveryStatement {
  let parsed;
  try {
    parsed = parseExactDsseEnvelope(envelopeBytes);
  } catch (cause) {
    invalid(
      "",
      `statement envelope is not a well-formed sealed DSSE envelope: ${describe(cause)}`,
    );
  }
  if (parsed.payloadType !== DELIVERY_STATEMENT_RECORD_MEDIA_TYPE) {
    invalid(
      "payloadType",
      `statement envelope payloadType "${parsed.payloadType}" is not `
        + DELIVERY_STATEMENT_RECORD_MEDIA_TYPE,
    );
  }
  return {
    statement: parseExactDeliveryStatementPayload(parsed.payloadBytes),
    payloadBytes: parsed.payloadBytes,
    signatures: parsed.signatures,
    digest: recordDigest(envelopeBytes),
  };
}
