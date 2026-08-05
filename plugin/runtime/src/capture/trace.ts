// SPDX-License-Identifier: Apache-2.0

import {
  TRACE_MEDIA_TYPE,
  TRACE_PROTOCOL,
  TRACE_VOCABULARY_PROFILE,
  deriveTraceId,
  documentDigest,
  sealTrace,
} from "@jinn-network/evidence-trace";

import type { ParsedSessionFeed } from "./feed.js";
import {
  SESSION_FEED_FORMAT_IRI,
  SESSION_FEED_MEDIA_TYPE,
  TRACE_BUILDER_ID,
  TRACE_BUILDER_VERSION,
} from "./identity.js";
import { buildTraceSpans } from "./spans.js";

export const TRACE_ARTIFACT_MEDIA_TYPE = TRACE_MEDIA_TYPE;

export interface BuiltTrace {
  readonly bytes: Uint8Array;
  readonly digest: `sha256:${string}`;
  readonly traceId: string;
  readonly spanCount: number;
}

/**
 * Produces the sealed Trace record for one session, directly from the live hook feed
 * (program finding F2 — this product is a trace producer and never parses a transcript).
 *
 * `source.execution` is deliberately absent: the execution record's digest does not exist
 * yet at this point in the seal, because the feed must be attached as the native trace before
 * `finalize()` and this record's digest must exist before that so it can ride along as an
 * identifier. The join survives anyway — `source.nativeTrace.digest.sha256` is the same
 * digest the sealed execution record carries on its trace entity.
 */
export function buildTraceRecord(
  feed: ParsedSessionFeed,
  feedBytes: Uint8Array,
): BuiltTrace {
  const sourceDigest = documentDigest(feedBytes);
  const traceId = deriveTraceId({
    sourceDigest,
    formatIri: SESSION_FEED_FORMAT_IRI,
    decoderId: TRACE_BUILDER_ID,
    decoderVersion: TRACE_BUILDER_VERSION,
    vocabularyProfile: TRACE_VOCABULARY_PROFILE,
  });
  const spans = buildTraceSpans({ feed, traceId });

  const sealed = sealTrace({
    protocol: TRACE_PROTOCOL,
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
      decoderId: TRACE_BUILDER_ID,
      decoderVersion: TRACE_BUILDER_VERSION,
      vocabularyProfile: TRACE_VOCABULARY_PROFILE,
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
