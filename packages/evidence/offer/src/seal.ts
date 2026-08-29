// SPDX-License-Identifier: Apache-2.0

import {
  canonicalJsonBytes,
  parseExactDsseEnvelope,
  recordDigest,
  sealSignedPayload,
} from "@jinn-network/trust-core";
import type {
  DsseEnvelopeSignature,
  DsseSigner,
  Sha256Digest,
} from "@jinn-network/trust-core";

import { OFFER_RECORD_MEDIA_TYPE } from "./identifiers.js";
import { OfferRecordSchema, type OfferRecord } from "./schema.js";

export interface ValidationIssue {
  readonly path: string;
  readonly message: string;
}

/**
 * Thrown when a document fails validation at the sealing boundary, or when bytes handed to
 * a parser are not the one exact canonical encoding. Carries the tree-wide plain
 * `{ category: "invalid-document", errors }` shape — catch on `category`, not on the class.
 */
export class InvalidOfferError extends Error {
  readonly category = "invalid-document" as const;
  constructor(readonly errors: readonly ValidationIssue[]) {
    super("offer document failed validation at the sealing boundary");
    this.name = "InvalidOfferError";
  }
}

function invalid(path: string, message: string): never {
  throw new InvalidOfferError([{ path, message }]);
}

/**
 * `JSON.parse` gives `__proto__` as an ordinary own member, but zod's object copy assigns
 * through the prototype setter and the member never reaches the output. Validation would
 * succeed and the sealed bytes would quietly lack content the producer handed in. A seal
 * that drops a member is worse than one that refuses the document, so this refuses.
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
      invalid(memberPath, 'a "__proto__" member cannot survive sealing and is refused, never dropped');
    }
    assertNoPrototypeMember(member, memberPath);
  }
}

/**
 * Zod's loose objects keep a known-optional key that was present-but-undefined in the
 * input. JCS has no undefined token and an object member has a key to omit by, so those
 * members are dropped here — a document that omits `supersedes` and one that spells it
 * `undefined` are the same offer and must seal to the same bytes. An array element cannot
 * be omitted that way, so an undefined element is refused instead.
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

function validate(document: unknown): OfferRecord {
  assertNoPrototypeMember(document, "");
  const parsed = OfferRecordSchema.safeParse(document);
  if (!parsed.success) {
    throw new InvalidOfferError(parsed.error.issues.map((issue) => ({
      path: issue.path.join("."),
      message: issue.message,
    })));
  }
  return parsed.data;
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

/**
 * Validate, then canonicalize once (RFC 8785 JCS over the I-JSON subset, via trust-core's
 * canonicalizer). These bytes are the offer's DSSE payload forever.
 */
export function sealOfferPayload(document: unknown): Uint8Array {
  return canonicalJsonBytes(withoutUndefinedMembers(validate(document), ""));
}

/**
 * Decode, validate, and require the input to be the one exact canonical encoding. A
 * consumer never re-canonicalizes to check a digest — re-canonicalizing would let two
 * distinct byte strings present as the same offer.
 */
export function parseExactOfferPayload(bytes: Uint8Array): OfferRecord {
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    invalid("", "payload bytes are not valid UTF-8 JSON");
  }
  const record = validate(json);
  if (!bytesEqual(canonicalJsonBytes(withoutUndefinedMembers(record, "")), bytes)) {
    invalid("", "payload bytes are not the exact canonical JSON encoding of this offer");
  }
  return record;
}

export interface SealedOffer {
  /** The record: a DSSE envelope over the canonical payload, signed by the holder. */
  readonly envelopeBytes: Uint8Array;
  readonly payloadBytes: Uint8Array;
  /** The offer's identity — the digest of the sealed envelope, and what `supersedes` names. */
  readonly digest: Sha256Digest;
  readonly offer: OfferRecord;
}

export interface SealOfferInput {
  readonly offer: unknown;
  /**
   * Signing is required for this kind. "Only the holder can offer" is enforced by resolving
   * this signature through key-binding records to a bound identity, so there is no unsigned
   * seal entry point: an unsigned offer would be a price anyone could publish for anyone
   * else's bytes.
   */
  readonly signer: DsseSigner;
  readonly signal?: AbortSignal;
}

/** Seals the canonical payload and DSSE-signs it under the offer media type (TEP §21.2). */
export async function sealOffer(input: SealOfferInput): Promise<SealedOffer> {
  const offer = validate(input.offer);
  const payloadBytes = canonicalJsonBytes(withoutUndefinedMembers(offer, ""));
  const sealed = await sealSignedPayload({
    payloadBytes,
    payloadType: OFFER_RECORD_MEDIA_TYPE,
    signer: input.signer,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  return {
    envelopeBytes: sealed.envelopeBytes,
    payloadBytes: sealed.payloadBytes,
    digest: sealed.recordDigest,
    offer,
  };
}

export interface ParsedOffer {
  readonly offer: OfferRecord;
  readonly payloadBytes: Uint8Array;
  readonly signatures: readonly DsseEnvelopeSignature[];
  readonly digest: Sha256Digest;
}

/**
 * Structurally parses a sealed offer envelope: exact producer encoding, expected
 * `payloadType`, exact canonical payload. Deliberately the strict DSSE parser rather than
 * the structural one — the offer's identity is the digest of these envelope bytes, so an
 * alternate JSON or base64 spelling of the same terms would otherwise present as a
 * different offer.
 *
 * No signature is checked here; that is `verifyOffer`'s job, and a structurally valid offer
 * never implies an authorized one.
 */
export function parseOfferEnvelope(envelopeBytes: Uint8Array): ParsedOffer {
  let parsed;
  try {
    parsed = parseExactDsseEnvelope(envelopeBytes);
  } catch (cause) {
    invalid("", `offer envelope is not a well-formed sealed DSSE envelope: ${describe(cause)}`);
  }
  if (parsed.payloadType !== OFFER_RECORD_MEDIA_TYPE) {
    invalid(
      "payloadType",
      `offer envelope payloadType "${parsed.payloadType}" is not ${OFFER_RECORD_MEDIA_TYPE}`,
    );
  }
  return {
    offer: parseExactOfferPayload(parsed.payloadBytes),
    payloadBytes: parsed.payloadBytes,
    signatures: parsed.signatures,
    digest: recordDigest(envelopeBytes),
  };
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
