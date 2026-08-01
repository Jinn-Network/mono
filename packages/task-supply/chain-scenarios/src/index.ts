// SPDX-License-Identifier: Apache-2.0

export { ScenarioError } from "./errors.js";
export type { ScenarioErrorCategory } from "./errors.js";
export { compareCodeUnitStrings } from "./order.js";
export { canonicalJsonBytes, serializeCanonicalJson } from "./canonical.js";
export type { CanonicalJsonValue } from "./canonical.js";
export {
  assertBareHex,
  assertPrefixedDigest,
  digestsEqual,
  documentDigest,
  sha256Hex,
  toBareHex,
} from "./digest.js";
export type { Sha256Digest } from "./digest.js";
export {
  WELL_KNOWN_DEV_ADDRESSES,
  assertFreshFixtureAddress,
  createFixtureAddressLedger,
  normalizeAddress,
} from "./fixture-accounts.js";
export type {
  FixtureAddressLedger,
  ScenarioAccount,
  ScenarioAccountPort,
  ScenarioAccountRequest,
} from "./fixture-accounts.js";
