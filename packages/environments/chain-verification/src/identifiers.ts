// SPDX-License-Identifier: Apache-2.0

/** in-toto `predicateType` for this attestation (design §5.3, §14). */
export const CHAIN_ENVIRONMENT_VERIFICATION_PREDICATE_TYPE =
  "https://spec.jinn.network/attestations/chain-environment-verification/v1" as const;

/** The protocol the predicate's `protocol` field names (design §5.1, §5.2). */
export const CHAIN_ENVIRONMENT_VERIFICATION_PROTOCOL_URI =
  "https://spec.jinn.network/chain-environment-verification/protocol/v1" as const;

/** Schema id inside the canonical observation, so a stored observation says what shape it
 * is without depending on where it was found. */
export const CHAIN_OBSERVATION_SCHEMA_ID =
  "https://spec.jinn.network/chain-environment/observation/v1" as const;

/** The composite observation spans the chain plane and the information plane (design §5.1
 * step 6, "the K-run observation covers chain and information planes together"). */
export const COMPOSITE_OBSERVATION_SCHEMA_ID =
  "https://spec.jinn.network/crypto-environment/observation/v1" as const;

/**
 * K for the v1 profile. Design E4: K inherits the parent floor and does not drop below it
 * because chain probe runs are cheap. A declared floor for a bounded observation, never a
 * convergence threshold.
 */
export const MINIMUM_RUN_COUNT = 5;

/**
 * Archive observation (design §5.2) may run with fewer materializations when the caller
 * establishes a connected baseline (CE4 `BASELINE_RUN_COUNT`). Closed-state verification
 * still requires `MINIMUM_RUN_COUNT`.
 */
export const ARCHIVE_OBSERVATION_MINIMUM_RUN_COUNT = 2;

/** Per-instance probe-suite wall-clock ceiling in seconds for the v1 profile. */
export const DEFAULT_PROBE_TIMEOUT_SECONDS = 600;

/** Media type of the sealed solution script the replayer consumes (design §14). */
export const CHAIN_SOLUTION_MEDIA_TYPE =
  "application/vnd.jinn.chain-solution.v1+json" as const;
