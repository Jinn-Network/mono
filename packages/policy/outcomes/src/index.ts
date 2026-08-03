export * from "./observation.js";
export * from "./projection.js";
export * from "./serialize.js";
export { denormalizeAxes } from "./axes.js";
// F-C2-1 closure: `@jinn-network/policy-identity` now ships its real canonicalization/digest
// surface (program §1 C1 "Produces"). Re-exported here as a pass-through so existing consumers of
// this package's public surface (and this package's own kit-parity era) keep one import path;
// `axes.test.ts`'s cross-package smoke assertion pins that this really is identity's own
// implementation, not a reintroduced local copy.
export { canonicalTupleBytes, canonicalTupleText, tupleDigest } from "@jinn-network/policy-identity";
