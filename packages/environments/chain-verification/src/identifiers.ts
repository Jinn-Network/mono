// SPDX-License-Identifier: Apache-2.0

/** in-toto `predicateType` for this attestation (design §5.3, §14). */
export const CHAIN_ENVIRONMENT_VERIFICATION_PREDICATE_TYPE =
  "https://jinn.network/attestations/chain-environment-verification/v1" as const;

/** The protocol the predicate's `protocol` field names (design §5.1, §5.2). */
export const CHAIN_ENVIRONMENT_VERIFICATION_PROTOCOL_URI =
  "https://jinn.network/chain-environment-verification/protocol/1.0" as const;

/** Schema id inside the canonical observation, so a stored observation says what shape it
 * is without depending on where it was found. */
export const CHAIN_OBSERVATION_SCHEMA_ID =
  "https://jinn.network/chain-environment/observation/1.0" as const;

/** The composite observation spans the chain plane and the information plane (design §5.1
 * step 6, "the K-run observation covers chain and information planes together"). */
export const COMPOSITE_OBSERVATION_SCHEMA_ID =
  "https://jinn.network/crypto-environment/observation/1.0" as const;

/**
 * K for the v1 profile. Design E4: K inherits the parent floor and does not drop below it
 * because chain probe runs are cheap. A declared floor for a bounded observation, never a
 * convergence threshold.
 */
export const MINIMUM_RUN_COUNT = 5;

/** Per-instance probe-suite wall-clock ceiling in seconds for the v1 profile. */
export const DEFAULT_PROBE_TIMEOUT_SECONDS = 600;

/** Media type of the sealed solution script the replayer consumes (design §14). */
export const CHAIN_SOLUTION_MEDIA_TYPE =
  "application/vnd.jinn.chain-solution.v1+json" as const;
