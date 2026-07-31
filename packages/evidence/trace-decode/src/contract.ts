// SPDX-License-Identifier: Apache-2.0

import {
  GEN_AI_ATTRIBUTES,
  JINN_ATTRIBUTES,
  TIMEBASES,
  compareCodeUnitStrings,
} from "@jinn-network/evidence-trajectory";
import type {
  Attribute,
  Span,
  SpanEvent,
  SpanStatus,
  Timebase,
} from "@jinn-network/evidence-trajectory";

export { TIMEBASES };
export type { Timebase };

/** Structurally the Trajectory record's `completeness` block. */
export interface Completeness {
  readonly decoded: "full" | "partial" | "empty";
  readonly skipped?: number;
  readonly reason?: string;
}

/**
 * A span before identity. Decoders never derive identifiers: they emit drafts in source
 * order and reference their parent by its ordinal, and `finalizeSpans` assigns every id
 * as an order/reference identifier only.
 */
export interface SpanDraft {
  readonly parentOrdinal: number | null;
  readonly name: string;
  readonly kind: 1 | 2 | 3 | 4 | 5;
  readonly startTimeUnixNano: string;
  readonly endTimeUnixNano: string;
  readonly attributes: readonly Attribute[];
  readonly events: readonly SpanEvent[];
  readonly status: SpanStatus;
}

export interface DecodeResult {
  readonly drafts: readonly SpanDraft[];
  readonly completeness: Completeness;
  readonly timebase: Timebase;
}

/**
 * A decoder for one native trace format.
 *
 * `decode` must be a pure function of its bytes: no clock, no randomness, no I/O, no
 * ambient state. It must not throw on malformed input — unreadable regions are reported
 * through `completeness`, because a partially readable trace is still evidence.
 */
export interface TraceDecoder {
  /** The canonical format identity this decoder claims; see `./formats.js`. */
  readonly formatIri: string;
  /** A stable lowercase slug, matching the record schema's `derivation.decoderId`. */
  readonly decoderId: string;
  /** Semver of this decoder's behavior. A bump produces new records, never the same ones. */
  readonly decoderVersion: string;
  decode(bytes: Uint8Array): DecodeResult;
}

/**
 * One byte-to-span case. The corpus of these *is* the determinism proof: a decoder that
 * reached for a clock or a random source fails `expected.spans` on its first run.
 */
export interface TraceDecoderFixture {
  readonly id: string;
  readonly description: string;
  readonly bytes: Uint8Array;
  readonly expected: {
    readonly timebase: Timebase;
    readonly completeness: Completeness;
    readonly spans: readonly Span[];
    /** The sealed record digest, when the corpus pins one. */
    readonly recordDigest?: string;
  };
}

/**
 * The only attribute keys a decoder may emit: the vocabulary profile C1 owns. The frozen
 * parsers emitted `message.content`, `tool.args`, and `tool.result`; none of them are here,
 * which is program finding F5 made mechanical rather than advisory.
 */
export const ADMITTED_ATTRIBUTE_KEYS: ReadonlySet<string> = new Set<string>([
  ...Object.values(GEN_AI_ATTRIBUTES),
  ...Object.values(JINN_ATTRIBUTES),
]);

export const DECODE_FAILURE_REASONS = [
  "unsupported-format",
  "source-digest-mismatch",
  "decoder-contract",
] as const;
export type DecodeFailureReason = (typeof DECODE_FAILURE_REASONS)[number];

export class UnsupportedFormatError extends Error {
  readonly category = "unsupported-format" as const;
  constructor(readonly formatIri: string) {
    super(`no decoder is registered for format ${formatIri}`);
    this.name = "UnsupportedFormatError";
  }
}

export class SourceDigestMismatchError extends Error {
  readonly category = "source-digest-mismatch" as const;
  constructor(
    readonly declared: string,
    readonly actual: string,
  ) {
    super(
      `the supplied bytes digest to ${actual}, but the native trace declares ${declared}`,
    );
    this.name = "SourceDigestMismatchError";
  }
}

export class DecoderContractError extends Error {
  readonly category = "decoder-contract" as const;
  constructor(readonly violations: readonly string[]) {
    super(`decoder output violates the record surface: ${violations.join("; ")}`);
    this.name = "DecoderContractError";
  }
}

/**
 * The single ordering rule for span attributes. OTLP JSON defines none (attributes are an
 * ordered list), so this profile fixes one — sorted by key, unique — which is what makes
 * byte-for-byte decoder determinism checkable at all (program finding F4).
 */
export function sortAttributes(attributes: readonly Attribute[]): Attribute[] {
  const violations: string[] = [];
  const seen = new Set<string>();
  for (const entry of attributes) {
    if (seen.has(entry.key)) violations.push(`duplicate attribute key ${entry.key}`);
    seen.add(entry.key);
    if (!ADMITTED_ATTRIBUTE_KEYS.has(entry.key)) {
      violations.push(`attribute key ${entry.key} is outside the vocabulary profile`);
    }
  }
  if (violations.length > 0) throw new DecoderContractError(violations);
  return [...attributes].sort((left, right) =>
    compareCodeUnitStrings(left.key, right.key),
  );
}
