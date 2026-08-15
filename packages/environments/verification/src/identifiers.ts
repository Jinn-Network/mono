// SPDX-License-Identifier: Apache-2.0

/** in-toto `predicateType` for this attestation (design §5.1). */
export const ENVIRONMENT_VERIFICATION_PREDICATE_TYPE =
  "https://spec.jinn.network/attestations/environment-verification/v1" as const;

/** The protocol the predicate's `protocol` field names (design §5.2, §5.3). */
export const ENVIRONMENT_VERIFICATION_PROTOCOL_URI =
  "https://spec.jinn.network/environment-verification/protocol/v1" as const;

/**
 * K for the v1 profile. Rerun studies put flaky-test detection on an
 * asymptote in the number of reruns (research note §9), so this is a declared
 * floor for a bounded observation -- never a convergence threshold.
 */
export const MINIMUM_RUN_COUNT = 5;

/** Per-run wall-clock ceiling in seconds for the v1 profile. */
export const DEFAULT_TIMEOUT_SECONDS = 1800;
