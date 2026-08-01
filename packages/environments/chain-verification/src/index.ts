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
  verifyChainEnvironment,
  type SealedAttestation,
  type VerifyChainEnvironmentOptions,
} from "./verify.js";

// Scaffold placeholders for the public runtime surface; replaced in later tasks.
export function verifyCryptoEnvironment(): void {}

export function createAnvilMaterializer(): void {}

export function createProbeExecutor(): void {}

export function createScriptReplayer(): void {}
