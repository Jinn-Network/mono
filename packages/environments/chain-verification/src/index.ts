// SPDX-License-Identifier: Apache-2.0

export {
  CHAIN_ENVIRONMENT_VERIFICATION_PREDICATE_TYPE,
  CHAIN_ENVIRONMENT_VERIFICATION_PROTOCOL_URI,
  CHAIN_OBSERVATION_SCHEMA_ID,
  COMPOSITE_OBSERVATION_SCHEMA_ID,
  DEFAULT_PROBE_TIMEOUT_SECONDS,
  MINIMUM_RUN_COUNT,
} from "./identifiers.js";

export type { ChainVerificationDeps } from "./ports.js";
export {
  observeArchiveEnvironment,
  type ArchiveProviderSpec,
  type ObserveArchiveOptions,
} from "./archive.js";
export {
  verifyChainEnvironment,
  type SealedAttestation,
  type VerifyChainEnvironmentOptions,
} from "./verify.js";
export {
  assessOriginRouting,
  verifyCryptoEnvironment,
  type RoutingCollision,
  type RoutingEntry,
  type VerifyCryptoEnvironmentOptions,
} from "./composite.js";

export function createAnvilMaterializer(): void {}

export function createProbeExecutor(): void {}

export function createScriptReplayer(): void {}
