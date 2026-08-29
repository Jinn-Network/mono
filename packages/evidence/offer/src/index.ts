// SPDX-License-Identifier: Apache-2.0

// Pinned identifiers
export {
  OFFER_RECORD_KIND,
  OFFER_RECORD_MEDIA_TYPE,
  OFFER_RECORD_SCHEMA_ID,
  OFFER_TRUST_SCOPE,
} from "./identifiers.js";

// Extension discipline
export { isAbsoluteUri, isNamespacedExtensionKey, namespacedObject } from "./extensions.js";

// Record kind
export {
  isFreeOffer,
  OfferGateSchema,
  OfferRailSchema,
  OfferRecordSchema,
} from "./schema.js";
export type { OfferGate, OfferRail, OfferRecord } from "./schema.js";

// Sealing
export {
  InvalidOfferError,
  parseExactOfferPayload,
  parseOfferEnvelope,
  sealOffer,
  sealOfferPayload,
} from "./seal.js";
export type {
  ParsedOffer,
  SealedOffer,
  SealOfferInput,
  ValidationIssue,
} from "./seal.js";

// Verification
export { verifyOffer } from "./verify.js";
export type {
  OfferVerification,
  OfferVerificationFailureReason,
  VerifyOfferDeps,
  VerifyOfferInput,
} from "./verify.js";

// Supersession
export { resolveLiveOffers } from "./supersession.js";
export type { OfferEntry, SupersessionReport } from "./supersession.js";
