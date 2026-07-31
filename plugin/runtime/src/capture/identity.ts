// SPDX-License-Identifier: Apache-2.0

import { TRAJECTORY_RECORD_IDENTIFIER_PROPERTY } from "@jinn-network/evidence-trajectory";

import { PluginRuntimeError } from "../errors.js";

/**
 * The declared format of the session feed. The recorder binds the feed bytes and this IRI
 * without opening either (`packages/evidence/execution-recorder/src/graph.ts:757-771`), so
 * this constant is the whole of the format contract a consumer sees.
 *
 * C2 owns the platform format-identity registry. This constant is deliberately local: C4
 * must not depend on C2's branch. Reconciling the two is a recorded finding.
 */
export const SESSION_FEED_FORMAT_IRI =
  "https://jinn.network/formats/agent-session-feed/v1" as const;

export const SESSION_FEED_MEDIA_TYPE = "application/x-ndjson" as const;

/** Bumped only when the feed's event shapes change incompatibly. */
export const SESSION_FEED_VERSION = 1 as const;

/**
 * The trajectory producer's identity. `decoderId` must be a lowercase slug
 * (`DerivationSchema` in `@jinn-network/evidence-trajectory`), and `decoderVersion` is the
 * span-building rule's own version — deliberately independent of the package version, so a
 * release that does not change span construction does not invalidate earlier records.
 */
export const TRAJECTORY_BUILDER_ID = "agent-session-feed" as const;
export const TRAJECTORY_BUILDER_VERSION = "1.0.0" as const;

export const PRODUCER_IRI = "https://jinn.network/software/plugin-runtime" as const;
export const PRODUCER_NAME = "Jinn plugin runtime" as const;

export const SESSION_ID_PROPERTY =
  "https://jinn.network/schemes/agent-session-id" as const;

/**
 * Re-exports C1's authority for the forward-link identifier IRI. Carried as an identifier on
 * the native-trace artifact entity, which is how the sealed execution record points forward at
 * its trajectory record. The trajectory record is stored as a repository artifact rather than
 * a record because `EVIDENCE_RECORD_FAMILIES` is a closed set
 * (`packages/evidence/repository/src/types.ts:1-5`).
 */
export { TRAJECTORY_RECORD_IDENTIFIER_PROPERTY };

export const CAPTURE_LICENSE = "https://spdx.org/licenses/Apache-2.0.html" as const;

const SLUG_STRIP = /[^a-z0-9]+/gu;

/** A stable absolute IRI for the observed host, which the protocol requires of the Executor. */
export function executorIri(hostName: string): `${string}:${string}` {
  const slug = hostName.toLowerCase().replace(SLUG_STRIP, "-").replace(/^-+|-+$/gu, "");
  if (slug.length === 0) {
    throw new PluginRuntimeError(
      "capture-feed-invalid",
      "The session feed's host name does not yield an executor identity.",
    );
  }
  return `https://jinn.network/software/agent-host/${slug}`;
}
