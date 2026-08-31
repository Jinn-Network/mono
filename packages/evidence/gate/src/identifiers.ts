// SPDX-License-Identifier: Apache-2.0

/**
 * The delivery statement's record-kind URI. The platform grammar is
 * `https://spec.jinn.network/records/<segment>/v<major>` (DR-2026-08-04, major-only
 * versioning); the authoritative check is discovery's `assertRecordKindUri`, mirrored in
 * `identifiers.test.ts` because this package does not depend on discovery.
 *
 * The gate itself has no record kind — a gate is a running service, not a document. This
 * is the one document it may produce.
 */
export const DELIVERY_STATEMENT_RECORD_KIND =
  "https://spec.jinn.network/records/delivery-statement/v1" as const;

/**
 * Media type, vendor tree, one major per record version. It is also the DSSE envelope's
 * `payloadType` (TEP §21.2: a signed record is a DSSE envelope whose payloadType is the
 * record's media type).
 */
export const DELIVERY_STATEMENT_RECORD_MEDIA_TYPE =
  "application/vnd.jinn.delivery-statement.v1+json" as const;

/**
 * `$id` an eventual published JSON Schema would carry. Independent of the record kind,
 * because a record-kind URI must never be a directory prefix of a served document
 * (DR-2026-08-04).
 */
export const DELIVERY_STATEMENT_RECORD_SCHEMA_ID =
  "https://spec.jinn.network/schemas/delivery-statement/v1" as const;

/**
 * The trust scope a delivery statement's signing key must carry in its key binding. A
 * statement says "I, the holder, handed these bytes over on these terms", so it is the
 * holder's voice in the same sense the offer is, and it gets its own scope rather than
 * borrowing the offers scope: a key authorized to price bytes is not thereby authorized
 * to write sales history, and one compromised without the other should cost only its half.
 */
export const DELIVERY_STATEMENT_TRUST_SCOPE =
  "https://spec.jinn.network/trust-scopes/delivery-statements/v1" as const;
