// SPDX-License-Identifier: Apache-2.0

import { sha256Hex } from "./hashing.js";

export interface TraceIdInput {
  readonly sourceDigest: string;
  readonly formatIri: string;
  readonly decoderId: string;
  readonly decoderVersion: string;
  readonly vocabularyProfile: string;
}

const encoder = new TextEncoder();

/**
 * Length-prefixed framing so that concatenation is injective: no two distinct field
 * tuples share a preimage.
 */
function frame(parts: readonly string[]): Uint8Array {
  return encoder.encode(parts.map((part) => `${part.length}:${part}`).join(""));
}

/**
 * Trace identifier — a deterministic order/reference key derived from declared inputs.
 * Byte identity is the sealed record digest; attribution is the derivation attestation.
 */
export function deriveTraceId(input: TraceIdInput): string {
  return sha256Hex(
    frame([
      "jinn.trajectory.trace",
      input.sourceDigest,
      input.formatIri,
      input.decoderId,
      input.decoderVersion,
      input.vocabularyProfile,
    ]),
  ).slice(0, 32);
}

/** Span identifier — order/reference within a trace, not a security boundary. */
export function deriveSpanId(traceId: string, ordinal: number): string {
  if (!Number.isInteger(ordinal) || ordinal < 0) {
    throw new RangeError("span ordinal must be a non-negative integer");
  }
  return sha256Hex(frame(["jinn.trajectory.span", traceId, String(ordinal)])).slice(0, 16);
}
