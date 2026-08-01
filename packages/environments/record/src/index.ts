// Pinned identifiers (§4.1)
export {
  ENVIRONMENT_RECORD_KIND,
  ENVIRONMENT_RECORD_MEDIA_TYPE,
  ENVIRONMENT_RECORD_SCHEMA_ID,
} from "./identifiers.js";

// Sealing primitives — re-implemented in this package; equivalence is proven by fixtures.
export { compareCodeUnitStrings } from "./order.js";
export {
  assertIJsonInteger,
  assertIJsonString,
  assertIJsonStrings,
  IJsonNumberError,
  IJsonStringError,
  UndefinedArrayElementError,
} from "./json.js";
export type { JsonValue } from "./json.js";
export { serializeCanonicalJson } from "./canonical.js";
export { bareHexDigest, environmentRecordDigest, sha256Hex } from "./hashing.js";
export {
  InvalidDocumentError,
  parseExactWithSchema,
  sealWithSchema,
} from "./sealing.js";
export type { ValidationIssue } from "./sealing.js";

// Extension discipline
export { isNamespacedExtensionKey, topLevelRecordSchema } from "./extensions.js";

// Command shape
export { CommandSpecSchema, SHELL_INTERPRETERS, SHELL_METACHARACTERS } from "./command.js";
export type { CommandSpec } from "./command.js";

// Record kind
export {
  EnvironmentBuildSchema,
  EnvironmentImageSchema,
  EnvironmentInvocationsSchema,
  EnvironmentLineageSchema,
  EnvironmentParserSchema,
  EnvironmentRecordSchema,
  EnvironmentRightsSchema,
  EnvironmentSourceSchema,
  parseEnvironmentRecord,
  REPRODUCIBILITY_TIERS,
  sealEnvironmentRecord,
} from "./schema.js";
export type { EnvironmentRecord } from "./schema.js";
