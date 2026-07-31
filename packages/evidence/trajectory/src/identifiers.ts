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
