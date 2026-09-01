// SPDX-License-Identifier: Apache-2.0

/**
 * Record-kind URI. The platform grammar is
 * `https://spec.jinn.network/records/<segment>/v<major>` (DR-2026-08-04, major-only
 * versioning); the authoritative check is discovery's `assertRecordKindUri`, mirrored in
 * `identifiers.test.ts` because this package does not depend on discovery.
 */
export const OFFER_RECORD_KIND =
  "https://spec.jinn.network/records/offer/v1" as const;

/**
 * Media type, vendor tree, one major per record version. It is also the DSSE envelope's
 * `payloadType` (TEP §21.2: a signed record is a DSSE envelope whose payloadType is the
 * record's media type).
 */
export const OFFER_RECORD_MEDIA_TYPE =
  "application/vnd.jinn.offer.v1+json" as const;

/**
 * `$id` an eventual published JSON Schema would carry. Re-homed out of the `records/`
 * prefix (DR-2026-08-04): a record-kind URI must never be a directory prefix of a served
 * document, so this is an independent `schemas/<kind>/v<major>` identifier.
 */
export const OFFER_RECORD_SCHEMA_ID =
  "https://spec.jinn.network/schemas/offer/v1" as const;

/**
 * The trust scope an offer's signing key must carry in its key binding. Spelled at the
 * spec origin, matching the newest scope in the tree (admission receipts) rather than the
 * older bare-`jinn:` spelling.
 */
export const OFFER_TRUST_SCOPE =
  "https://spec.jinn.network/trust-scopes/offers/v1" as const;
