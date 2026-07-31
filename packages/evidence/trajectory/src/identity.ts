// SPDX-License-Identifier: Apache-2.0

import { sha256Hex } from "./hashing.js";

export interface TraceIdInput {
  readonly sourceDigest: string;
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
 * The trace identifier is a pure function of the declared derivation inputs, so a
 * consumer can recompute it from the record alone.
 */
export function deriveTraceId(input: TraceIdInput): string {
  return sha256Hex(
    frame([
      "jinn.trajectory.trace",
      input.sourceDigest,
      input.decoderId,
      input.decoderVersion,
      input.vocabularyProfile,
    ]),
  ).slice(0, 32);
}

/** The span identifier is a pure function of its trace and its ordinal position. */
export function deriveSpanId(traceId: string, ordinal: number): string {
  if (!Number.isInteger(ordinal) || ordinal < 0) {
    throw new RangeError("span ordinal must be a non-negative integer");
  }
  return sha256Hex(frame(["jinn.trajectory.span", traceId, String(ordinal)])).slice(0, 16);
}
