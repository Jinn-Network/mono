// SPDX-License-Identifier: MIT

/**
 * THE REFERENCE CONFORMANCE ENTRY — the kit's original swap-point binding, kept live.
 *
 * `src/conformance.ts` now points the suite at the shipped implementation. This module is the
 * other half of the acceptance criterion: it binds the identical surface to the naive reference
 * deriver, so the same 165 assertions can be run against **two structurally different code paths**
 * on demand rather than only historically.
 *
 *     yarn test:conformance:reference
 *
 * `vitest.config.ts` aliases `./conformance.js` here when `JINN_POLICY_CONFORMANCE=reference`.
 * Neither implementation may be edited to accommodate the other; the fixtures on disk decide.
 */

export {
  deriveExecutionTuple,
  canonicalTupleBytes,
  canonicalTupleText,
  tupleDigest,
  expressAsRunPinning,
  assertValidTuple,
  sealCandidateManifest,
  validateCandidateManifest,
  parseExactCandidateManifest,
  verifyCandidateStatementBinding,
  preAuthenticationEncoding,
  verifyEd25519Signature,
  hashTreeLearnerPublicV1,
  assertMaterializable,
  canonicalJsonBytes,
  canonicalJsonText,
  compareCodeUnitStrings,
  sha256Hex,
  prefixedDigest,
} from "./index.js";

export type { DsseEnvelope } from "./dsse.js";

export const CONFORMANCE_TARGET: "reference" | "implementation" = "reference";
