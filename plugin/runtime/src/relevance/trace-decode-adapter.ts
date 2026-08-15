// SPDX-License-Identifier: Apache-2.0
import {
  createDefaultDecoderRegistry,
  formatIdentity,
  tryDecodeTrace,
  type DecoderRegistry,
} from "@jinn-network/evidence-trace-decode";
import type { Span } from "@jinn-network/evidence-trace";
import type { Sha256Digest } from "@jinn-network/evidence-repository";

export interface TraceSpanRequest {
  readonly formatIri?: string;
  readonly bytes: Uint8Array;
  readonly nativeTraceDigest: Sha256Digest;
  readonly nativeTraceName?: string;
}

export interface TraceSpanSource {
  spansFor(request: TraceSpanRequest): readonly Span[];
}

/**
 * The single point at which this component names the decoder package. Every other module
 * consumes spans, so a decoder-surface change costs exactly this file.
 *
 * Best-effort by contract: no arm of this function throws, and an empty span list is an
 * ordinary result that costs excerpt quality and nothing else.
 */
export function createTraceSpanSource(
  registry: DecoderRegistry = createDefaultDecoderRegistry(),
): TraceSpanSource {
  return {
    spansFor(request: TraceSpanRequest): readonly Span[] {
      const formatIri = request.formatIri;
      if (formatIri === undefined || request.bytes.byteLength === 0) return [];

      // A record's declared trace format is frequently the backend's supervisor-facts
      // blob rather than a harness transcript (producer-side gap filed by C2 against
      // `backend-local/assembly`). Diagnose it as "not a harness trace" instead of
      // burning a decode and reporting "unsupported format".
      if (formatIdentity(formatIri)?.harnessTrace !== true) return [];

      let outcome;
      try {
        outcome = tryDecodeTrace(registry, formatIri, {
          bytes: request.bytes,
          nativeTrace: {
            ...(request.nativeTraceName === undefined ? {} : { name: request.nativeTraceName }),
            digest: { sha256: request.nativeTraceDigest.slice("sha256:".length) },
          },
        });
      } catch {
        // `tryDecodeTrace` is documented never to throw; this belt covers a decoder
        // that violates that contract without letting it fail an index write.
        return [];
      }

      if (!outcome.ok) return [];
      return outcome.document.spans;
    },
  };
}
