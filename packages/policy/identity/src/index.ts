// SPDX-License-Identifier: MIT

/**
 * `@jinn-network/policy-identity` — public surface.
 *
 * Canonicalize, digest, seal, and validate two documents: the **execution-policy tuple** (one
 * canonical, derived identity for the configuration that ran) and the **candidate manifest** (a
 * sealed, attributable identity for the configuration someone proposes). Pure: no clock, no
 * network, no filesystem, no randomness.
 *
 * Nothing here is a record kind. Both documents carry format tokens; substrate §5.4 records the
 * single graduation trigger, cross-operator exchange.
 */

export * from "./tokens.js";
export * from "./types.js";

// --- shared primitives ---
export { PolicyIdentityError } from "./errors.js";
export {
  assertIJsonString,
  canonicalJsonBytes,
  canonicalJsonText,
  canonicallyEqual,
  compareCodeUnitStrings,
} from "./canonical.js";
export {
  prefixedDigest,
  sha256Hex,
  sha256HexOfText,
  SHA256_BARE_HEX_PATTERN,
  SHA256_PREFIXED_PATTERN,
} from "./digest.js";

// --- substrate §4.1: the tuple ---
export {
  assertValidTuple,
  canonicalTupleBytes,
  canonicalTupleText,
  expressAsRunPinning,
  tupleDigest,
} from "./tuple.js";
export { deriveExecutionTuple } from "./derive.js";
export {
  CONSTRAINT_MEMBERSHIP_KEYS,
  CORE_KEY_CLASSES,
  EFFORT_TIERS,
  mergeEffectiveRequirements,
} from "./merge.js";
export type { MergeOutcome } from "./merge.js";

// --- substrate §5: the candidate manifest ---
export {
  isNamespacedExtensionKey,
  parseExactCandidateManifest,
  sealCandidateManifest,
  validateCandidateManifest,
} from "./manifest.js";

// --- substrate §5.2: the DSSE in-toto Statement binding ---
export {
  preAuthenticationEncoding,
  verifyCandidateStatementBinding,
  verifyEd25519Signature,
} from "./dsse.js";
export type { DsseEnvelope, DsseSignature, StatementBindingResult } from "./dsse.js";

// --- substrate §4.2: fork healing ---
export { assertMaterializable, hashTreeLearnerPublicV1 } from "./hash-profile.js";
