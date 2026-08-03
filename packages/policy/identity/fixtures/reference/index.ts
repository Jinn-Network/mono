// SPDX-License-Identifier: MIT

/**
 * The kit's NAIVE REFERENCE implementation of `@jinn-network/policy-identity`.
 *
 * It exists for exactly one reason: substrate §8 requires the derivation-equivalence fixture to
 * be satisfied by **two structurally different implementations**, and the program's C1
 * acceptance criterion is that "the package's deriver must byte-match it on every fixture".
 *
 * It is deliberately simple — longhand loops, one rule per branch, no shared machinery with the
 * real implementation, every step annotated with the design line it implements. It is not
 * optimized and is not meant to be. If it and the implementation ever disagree, the fixture
 * expectations on disk decide which one is wrong.
 */

export * from "./canonical.js";
export * from "./derive.js";
export * from "./dsse.js";
export * from "./errors.js";
export * from "./hash-profile.js";
export * from "./hashing.js";
export * from "./manifest.js";
export * from "./merge.js";
export * from "./tuple.js";
