// SPDX-License-Identifier: MIT

/**
 * THE CONFORMANCE ENTRY — the single swap point of this kit.
 *
 * Every test in `src/*.test.ts` imports the functions under test from **here and nowhere else**.
 * Today this module re-exports the kit's naive reference implementation
 * (`fixtures/reference/`). When C1's real implementation lands, one edit repoints these bindings
 * at `./index.js`, the whole suite runs unchanged, and any byte-level disagreement between the
 * two implementations surfaces as a failing fixture rather than as a code review opinion.
 *
 * **Do not** widen this file into an adapter. If the implementation needs a shim to satisfy a
 * binding below, that is a frozen-interface change and a program event (program §7 R1), not a
 * kit edit.
 */

export {
  // --- substrate §4.1: the tuple ---
  deriveExecutionTuple,
  canonicalTupleBytes,
  canonicalTupleText,
  tupleDigest,
  expressAsRunPinning,
  assertValidTuple,
  // --- substrate §5: the candidate manifest ---
  sealCandidateManifest,
  validateCandidateManifest,
  parseExactCandidateManifest,
  // --- substrate §5.2: the DSSE in-toto Statement binding ---
  verifyCandidateStatementBinding,
  preAuthenticationEncoding,
  verifyEd25519Signature,
  // --- substrate §4.2: fork healing ---
  hashTreeLearnerPublicV1,
  assertMaterializable,
  // --- shared primitives the fixtures are expressed in terms of ---
  canonicalJsonBytes,
  canonicalJsonText,
  compareCodeUnitStrings,
  sha256Hex,
  prefixedDigest,
} from "../fixtures/reference/index.js";

export type { DsseEnvelope } from "../fixtures/reference/dsse.js";

/**
 * Names the implementation the suite is currently gating. Asserted by `conformance.test.ts` so
 * the swap is a deliberate, visible edit rather than something that happens by accident.
 */
export const CONFORMANCE_TARGET: "reference" | "implementation" = "reference";
