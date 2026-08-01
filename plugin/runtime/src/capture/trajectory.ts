// SPDX-License-Identifier: Apache-2.0

import {
  TRAJECTORY_MEDIA_TYPE,
  TRAJECTORY_PROTOCOL,
  TRAJECTORY_VOCABULARY_PROFILE,
  deriveTraceId,
  documentDigest,
  sealTrajectory,
} from "@jinn-network/evidence-trajectory";

import type { ParsedSessionFeed } from "./feed.js";
import {
  SESSION_FEED_FORMAT_IRI,
  SESSION_FEED_MEDIA_TYPE,
  TRAJECTORY_BUILDER_ID,
  TRAJECTORY_BUILDER_VERSION,
} from "./identity.js";
import { buildTrajectorySpans } from "./spans.js";

export const TRAJECTORY_ARTIFACT_MEDIA_TYPE = TRAJECTORY_MEDIA_TYPE;

export interface BuiltTrajectory {
  readonly bytes: Uint8Array;
  readonly digest: `sha256:${string}`;
  readonly traceId: string;
  readonly spanCount: number;
}

/**
 * Produces the sealed Trajectory record for one session, directly from the live hook feed
 * (program finding F2 — this product is a trajectory producer and never parses a transcript).
 *
 * `source.execution` is deliberately absent: the execution record's digest does not exist
 * yet at this point in the seal, because the feed must be attached as the native trace before
 * `finalize()` and this record's digest must exist before that so it can ride along as an
 * identifier. The join survives anyway — `source.nativeTrace.digest.sha256` is the same
 * digest the sealed execution record carries on its trace entity.
 */
export function buildTrajectoryRecord(
  feed: ParsedSessionFeed,
  feedBytes: Uint8Array,
): BuiltTrajectory {
  const sourceDigest = documentDigest(feedBytes);
  const traceId = deriveTraceId({
    sourceDigest,
    formatIri: SESSION_FEED_FORMAT_IRI,
    decoderId: TRAJECTORY_BUILDER_ID,
    decoderVersion: TRAJECTORY_BUILDER_VERSION,
    vocabularyProfile: TRAJECTORY_VOCABULARY_PROFILE,
  });
  const spans = buildTrajectorySpans({ feed, traceId });

  const sealed = sealTrajectory({
    protocol: TRAJECTORY_PROTOCOL,
    timebase: "source-epoch-ns",
    source: {
      nativeTrace: {
        name: "feed.ndjson",
        mediaType: SESSION_FEED_MEDIA_TYPE,
        digest: { sha256: sourceDigest.slice("sha256:".length) },
      },
      formatIri: SESSION_FEED_FORMAT_IRI,
    },
    derivation: {
      decoderId: TRAJECTORY_BUILDER_ID,
      decoderVersion: TRAJECTORY_BUILDER_VERSION,
      vocabularyProfile: TRAJECTORY_VOCABULARY_PROFILE,
    },
    traceId,
    spans,
    // parseSessionFeed is strict, so an uninterpretable feed is a refused capture rather
    // than a partial one; there is no state in which source lines were skipped.
    completeness: { decoded: "full" },
  });

  return {
    bytes: sealed.bytes,
    digest: sealed.digest,
    traceId,
    spanCount: spans.length,
  };
}
