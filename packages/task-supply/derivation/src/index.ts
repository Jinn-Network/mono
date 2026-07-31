// SPDX-License-Identifier: Apache-2.0

export { DerivationError } from "./errors.js";
export type { DerivationErrorCategory } from "./errors.js";
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
  SOURCE_COMMITMENT_RULE,
  computeSourceCommitment,
  sourceCommitmentPreImage,
  statementDigest,
} from "./source-commitment.js";
export type { UpstreamIdentity } from "./source-commitment.js";
export {
  ENVIRONMENT_RECORD_EXTENSION_KEY,
  buildEnvironmentRecordExtension,
  readEnvironmentRecordExtension,
} from "./environment-extension.js";
export type { EnvironmentRecordExtension } from "./environment-extension.js";
