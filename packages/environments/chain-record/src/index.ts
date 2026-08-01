// Public surface of @jinn-network/chain-environment-record.
//
// Two sealed record kinds, the primitives that seal them, and the port TYPE declarations four
// consumers need without taking a dependency on the capability that implements them.

// Pinned identifiers (§4.1, §14)
export {
  BLACKHOLE_EGRESS_POLICY_ID,
  CHAIN_ENVIRONMENT_KIND,
  CHAIN_ENVIRONMENT_MEDIA_TYPE,
  CHAIN_ENVIRONMENT_SCHEMA_ID,
  CRYPTO_ENVIRONMENT_KIND,
  CRYPTO_ENVIRONMENT_MEDIA_TYPE,
  CRYPTO_ENVIRONMENT_SCHEMA_ID,
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
export {
  bareHexDigest,
  chainEnvironmentRecordDigest,
  cryptoEnvironmentRecordDigest,
  prefixedDigest,
  sealedRecordDigest,
  sha256Hex,
} from "./hashing.js";
export {
  InvalidDocumentError,
  parseExactWithSchema,
  sealWithSchema,
} from "./sealing.js";
export type { ValidationIssue } from "./sealing.js";

// Extension discipline
export { isNamespacedExtensionKey, topLevelRecordSchema } from "./extensions.js";

// Shared record primitives
export {
  Address,
  BareSha256Hex,
  Bytes32,
  Caip2ChainId,
  Count,
  DigestPinnedDescriptorSchema,
  ExactSemanticVersion,
  HttpOrigin,
  NonEmpty,
  PrefixedSha256,
  Quantity,
  RecordKindUri,
  ResourceDescriptorSchema,
  Rfc3339Utc,
} from "./primitives.js";

// Chain record blocks
export { ChainRuntimeImageSchema, ChainRuntimeSchema, RUNTIME_FAMILIES } from "./runtime.js";
export type { ChainRuntime } from "./runtime.js";
export {
  anchorAuthenticityBoundOf,
  ChainSourceAnchorSchema,
  FINALITY_POLICIES,
} from "./anchor.js";
export type { AnchorAuthenticityBound, ChainSourceAnchor } from "./anchor.js";
export {
  ChainStateMaterializationSchema,
  CLOSURE_CLASSES,
  CONSTRUCTION_METHODS,
  DURABLE_SUPPLY_CLOSURE_CLASS,
  FIDELITY_CLASSES,
  FixtureCoverageSchema,
  SourceProofManifestSchema,
  StateArtifactSchema,
  StateEntryCountsSchema,
} from "./state.js";
export type { ChainStateMaterialization, StateEntryCounts } from "./state.js";
export { isWellKnownDevAddress, WELL_KNOWN_DEV_ADDRESSES } from "./dev-addresses.js";
export {
  ChainFixturesSchema,
  FIXTURE_MODULE_KINDS,
  FixtureAccountSchema,
  FixtureModuleSchema,
} from "./fixture-modules.js";
export type { ChainFixtures } from "./fixture-modules.js";
export {
  DeterminismControlsSchema,
  MEMPOOL_POLICIES,
  MINING_MODES,
  NONCE_POLICIES,
  ORDERING_POLICIES,
  REPLACEMENT_POLICIES,
  RESET_MECHANISMS,
  TIMEOUT_CLOCKS,
} from "./determinism.js";
export type { DeterminismControls } from "./determinism.js";
export { CapabilityEnvelopeSchema } from "./envelope.js";
export type { CapabilityEnvelope } from "./envelope.js";
export { MINIMUM_VERIFICATION_RUNS, VerificationContractSchema } from "./verification-contract.js";
export type { VerificationContract } from "./verification-contract.js";

// The two record kinds
export {
  ChainEnvironmentRecordSchema,
  parseChainEnvironmentRecord,
  requiresStateBackend,
  sealChainEnvironmentRecord,
} from "./chain-record.js";
export type { ChainEnvironmentRecord } from "./chain-record.js";
export {
  CompositionSchema,
  CryptoEnvironmentRecordSchema,
  InformationWorldReferenceSchema,
  parseCryptoEnvironmentRecord,
  sealCryptoEnvironmentRecord,
  ServiceRuntimeSchema,
  WorldReferenceSchema,
} from "./composite.js";
export type { CryptoEnvironmentRecord } from "./composite.js";

// The solution script the replayer consumes
export {
  CHAIN_SOLUTION_MEDIA_TYPE,
  ChainSolutionScriptSchema,
  parseChainSolutionScript,
  sealChainSolutionScript,
  SOLUTION_OPERATION_KINDS,
} from "./solution.js";
export type { ChainSolutionOperation, ChainSolutionScript } from "./solution.js";

// Port contracts (types only — the implementations are the verification capability's)
export type {
  ArtifactEntryObservation,
  ChainInstance,
  ChainMaterializer,
  ChainStateBackend,
  IsolationObservation,
  MaterializationCost,
  MaterializationReport,
  MaterializationRequest,
  NetworkPolicy,
  ProbeExecutionRequest,
  ProbeExecutionResult,
  ProbeExecutor,
  ReplayOutcome,
  ReplayRefusal,
  ReplayRequest,
  ResolvedResources,
  RuntimeIdentityObservation,
  ScriptReplayer,
  VerifiedChainInstance,
} from "./ports.js";
