// Public surface of @jinn-network/information-world.
//
// The record layer (tier 2), the canonical request key, and the loopback replay service
// (tier 3). ./testing is a separate entrypoint and is never re-exported here; nor are the
// fixture loaders, which read from disk.

export { asciiLowercase, asciiUppercase, isAsciiHost, isHttpToken } from "./ascii.js";
export { serializeCanonicalJson } from "./canonical.js";
export { isNamespacedExtensionKey, topLevelRecordSchema } from "./extensions.js";
export { bareHexDigest, informationWorldRecordDigest, sha256Hex } from "./hashing.js";
export {
  INFORMATION_WORLD_KIND,
  INFORMATION_WORLD_MEDIA_TYPE,
  INFORMATION_WORLD_SCHEMA_ID,
} from "./identifiers.js";
export {
  IJsonNumberError,
  IJsonStringError,
  UndefinedArrayElementError,
  type JsonValue,
} from "./json.js";
export { compareCodeUnitStrings } from "./order.js";
export {
  CREDENTIAL_HEADER_NAMES,
  REQUEST_KEY_VERSION,
  RequestKeyPolicySchema,
  assertRequestKeyPolicy,
  type RequestKeyPolicy,
} from "./request-key-policy.js";
export {
  InvalidRequestError,
  canonicalRequestKey,
  canonicalRequestKeyFromParts,
  canonicalRequestParts,
  type CanonicalRequestParts,
  type CanonicalizableRequest,
  type HeaderInput,
  type QueryPair,
} from "./request-key.js";
export {
  CorpusIntegrityError,
  buildReplayIndex,
  resolveReplay,
  type Consumed,
  type CorpusArtifactReader,
  type ReplayIndex,
  type ReplayIndexOptions,
  type ReplayOutcome,
  type RequestBudget,
} from "./replay.js";
export {
  CanonicalRequestPartsSchema,
  CaptureProvenanceSchema,
  CorpusEntrySchema,
  InformationWorldRecordSchema,
  MISS_BODY_MAX_BYTES,
  MissPolicySchema,
  ResourceDescriptorSchema,
  parseInformationWorldRecord,
  sealInformationWorldRecord,
  type CorpusEntry,
  type InformationWorldRecord,
  type MissPolicy,
} from "./schema.js";
export {
  InvalidDocumentError,
  parseExactWithSchema,
  sealWithSchema,
  type ValidationIssue,
} from "./sealing.js";
export {
  LOOPBACK_HOSTS,
  NonLoopbackBindError,
  createReplayService,
  type ListenAddress,
  type ReplayEvent,
  type ReplayService,
  type ReplayServiceOptions,
  type ReplayStats,
} from "./service.js";
