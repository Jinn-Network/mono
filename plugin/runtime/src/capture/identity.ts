// SPDX-License-Identifier: Apache-2.0

import { TRACE_RECORD_IDENTIFIER_PROPERTY } from "@jinn-network/evidence-trace";

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
  "https://spec.jinn.network/formats/agent-session-feed/v1" as const;

export const SESSION_FEED_MEDIA_TYPE = "application/x-ndjson" as const;

/** Bumped only when the feed's event shapes change incompatibly. */
export const SESSION_FEED_VERSION = 1 as const;

/**
 * The trace producer's identity. `decoderId` must be a lowercase slug
 * (`DerivationSchema` in `@jinn-network/evidence-trace`), and `decoderVersion` is the
 * span-building rule's own version — deliberately independent of the package version, so a
 * release that does not change span construction does not invalidate earlier records.
 */
export const TRACE_BUILDER_ID = "agent-session-feed" as const;
export const TRACE_BUILDER_VERSION = "1.0.0" as const;

export const PRODUCER_IRI = "https://spec.jinn.network/software/plugin-runtime" as const;
export const PRODUCER_NAME = "Jinn plugin runtime" as const;

export const SESSION_ID_PROPERTY =
  "https://spec.jinn.network/schemes/agent-session-id" as const;

/**
 * The base repository state's identifiers. The commit and tree object names are the content
 * binding a verifier resolves; branch and target base are the context that makes them legible.
 */
export const BASE_COMMIT_PROPERTY = "https://spec.jinn.network/schemes/git-commit" as const;
export const BASE_TREE_PROPERTY = "https://spec.jinn.network/schemes/git-tree" as const;
export const BRANCH_PROPERTY = "https://spec.jinn.network/schemes/git-branch" as const;
export const TARGET_BASE_PROPERTY = "https://spec.jinn.network/schemes/git-target-base" as const;

/** Which class of producer-controlled input one bound artifact is. */
export const CONTROLLED_INPUT_ROLE_PROPERTY =
  "https://spec.jinn.network/schemes/controlled-input-role" as const;

/** Entity ids for the two gap-closing input families. */
export const REPOSITORY_STATE_ENTITY_ID = "inputs/repository.json" as const;
export const REPOSITORY_BASE_STATE_ENTITY_ID = "inputs/repository/base-state.json" as const;
export const MODEL_SERVICE_ENTITY_ID = "runtime/model-service.json" as const;

/**
 * A crate-local entity id for one controlled input. The ordinal keeps it unique — the recorder
 * refuses duplicate entity ids, and two skills can share a basename — and the slug keeps the
 * host-written name from reaching the crate as a path.
 */
export function controlledInputEntityId(ordinal: number, name: string): string {
  const slugged = slug(name);
  const suffix = slugged.length === 0 ? "input" : slugged.slice(0, 64);
  return `inputs/controlled/${String(ordinal).padStart(2, "0")}-${suffix}`;
}

/**
 * Re-exports C1's authority for the forward-link identifier IRI. Carried as an identifier on
 * the native-trace artifact entity, which is how the sealed execution record points forward at
 * its trace record. The trace record is stored as a repository artifact rather than
 * a record because `EVIDENCE_RECORD_FAMILIES` is a closed set
 * (`packages/evidence/repository/src/types.ts:1-5`).
 */
export { TRACE_RECORD_IDENTIFIER_PROPERTY };

export const CAPTURE_LICENSE = "https://spdx.org/licenses/Apache-2.0.html" as const;

const SLUG_STRIP = /[^a-z0-9]+/gu;

function slug(value: string): string {
  return value.toLowerCase().replace(SLUG_STRIP, "-").replace(/^-+|-+$/gu, "");
}


/** A stable absolute IRI for the observed host, which the protocol requires of the Executor. */
export function executorIri(hostName: string): `${string}:${string}` {
  const slugged = slug(hostName);
  if (slugged.length === 0) {
    throw new PluginRuntimeError(
      "capture-feed-invalid",
      "The session feed's host name does not yield an executor identity.",
    );
  }
  return `https://spec.jinn.network/software/agent-host/${slugged}`;
}
