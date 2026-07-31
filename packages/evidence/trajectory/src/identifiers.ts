// SPDX-License-Identifier: Apache-2.0

/**
 * Record-kind URIs follow the platform grammar `https://jinn.network/records/<segment>/<major>.<minor>`.
 * Media types follow `application/vnd.jinn.<segment>.v<major>+json`.
 */
export const TRAJECTORY_PROTOCOL =
  "https://jinn.network/protocols/trajectory/1.0" as const;

export const TRAJECTORY_RECORD_KIND =
  "https://jinn.network/records/trajectory/1.0" as const;

export const TRAJECTORY_MEDIA_TYPE =
  "application/vnd.jinn.trajectory.v1+json" as const;

/**
 * The vocabulary profile is Jinn-owned and versioned here. Upstream GenAI semantic
 * conventions publish no release, tag, or schema URL, so there is no upstream version to
 * pin; `VOCABULARY_UPSTREAM` records the snapshot this profile was derived from.
 */
export const TRAJECTORY_VOCABULARY_PROFILE =
  "https://jinn.network/profiles/trajectory-vocabulary/1.0" as const;

export const TRAJECTORY_DERIVATION_PREDICATE_TYPE =
  "https://jinn.network/attestations/trajectory-derivation/v1" as const;

export const TRAJECTORY_DERIVATION_STATEMENT_KIND =
  "https://jinn.network/records/trajectory-derivation-statement/1.0" as const;

export const TRAJECTORY_SUBJECT_NAME = "trajectory.json" as const;

/** C1 owns this IRI. Forward-link PropertyValue.value MUST be a repository digest. */
export const TRAJECTORY_RECORD_IDENTIFIER_PROPERTY =
  "https://jinn.network/schemes/trajectory-record-sha256" as const;

/** Closed linkage modes attested in derivation predicates. C2 uses sealed-parent; C4 uses forward-linked. */
export const LINKAGE_MODES = ["forward-linked", "sealed-parent"] as const;

export type LinkageMode = (typeof LINKAGE_MODES)[number];
