// SPDX-License-Identifier: Apache-2.0

import {
  SpanSchema,
  TRACE_PROTOCOL,
  TRACE_VOCABULARY_PROFILE,
  compareCodeUnitStrings,
  deriveSpanId,
  deriveTraceId,
  sha256Hex,
} from "@jinn-network/evidence-trace";
import type { Attribute, Span } from "@jinn-network/evidence-trace";

import {
  ADMITTED_ATTRIBUTE_KEYS,
  DecoderContractError,
  SourceDigestMismatchError,
  TIMEBASES,
  UnsupportedFormatError,
} from "./contract.js";
import type {
  Completeness,
  DecodeFailureReason,
  SpanDraft,
  Timebase,
} from "./contract.js";
import type { DecoderRegistry } from "./registry.js";

/** A reference whose acquisition hints may vary but whose identity may not. */
export interface DigestBearingDescriptor {
  readonly name?: string;
  readonly mediaType?: string;
  readonly uri?: string;
  readonly digest: { readonly sha256: string };
}

export interface DecodeTraceInput {
  /** The exact native-trace bytes. Digest-checked against `nativeTrace` before decoding. */
  readonly bytes: Uint8Array;
  readonly nativeTrace: DigestBearingDescriptor;
}

/** The unsealed Trace record document; hand it to `sealTrace` to get bytes. */
export interface TraceDocument {
  readonly protocol: string;
  readonly source: {
    readonly nativeTrace: DigestBearingDescriptor;
    readonly formatIri: string;
  };
  readonly derivation: {
    readonly decoderId: string;
    readonly decoderVersion: string;
    readonly vocabularyProfile: string;
  };
  readonly timebase: Timebase;
  readonly traceId: string;
  readonly spans: readonly Span[];
  readonly completeness: Completeness;
}

export type DecodeOutcome =
  | { readonly ok: true; readonly document: TraceDocument }
  | {
      readonly ok: false;
      readonly reason: DecodeFailureReason;
      readonly detail: string;
    };

function checkAttributes(
  attributes: readonly Attribute[],
  where: string,
  violations: string[],
): void {
  for (let index = 0; index < attributes.length; index += 1) {
    const key = attributes[index]!.key;
    if (!ADMITTED_ATTRIBUTE_KEYS.has(key)) {
      violations.push(`${where}: attribute key ${key} is outside the vocabulary profile`);
    }
    if (index === 0) continue;
    if (compareCodeUnitStrings(attributes[index - 1]!.key, key) >= 0) {
      violations.push(`${where}: attributes must be sorted by key and unique`);
    }
  }
}

/**
 * Assigns every identifier in the span list.
 *
 * Decoders emit drafts in source order and name their parent by ordinal; identity is
 * derived here from `(traceId, ordinal)` as order/reference identifiers only.
 */
export function finalizeSpans(
  traceId: string,
  drafts: readonly SpanDraft[],
): Span[] {
  const violations: string[] = [];

  drafts.forEach((draft, ordinal) => {
    const where = `span ${String(ordinal)}`;
    if (
      draft.parentOrdinal !== null &&
      (!Number.isInteger(draft.parentOrdinal) ||
        draft.parentOrdinal < 0 ||
        draft.parentOrdinal >= ordinal)
    ) {
      violations.push(`${where}: parentOrdinal must name an earlier span in this trace`);
    }
    checkAttributes(draft.attributes, where, violations);
    draft.events.forEach((event, eventIndex) => {
      checkAttributes(
        event.attributes,
        `${where} event ${String(eventIndex)}`,
        violations,
      );
    });
  });

  if (violations.length > 0) throw new DecoderContractError(violations);

  return drafts.map((draft, ordinal) => ({
    spanId: deriveSpanId(traceId, ordinal),
    parentSpanId:
      draft.parentOrdinal === null ? null : deriveSpanId(traceId, draft.parentOrdinal),
    name: draft.name,
    kind: draft.kind,
    startTimeUnixNano: draft.startTimeUnixNano,
    endTimeUnixNano: draft.endTimeUnixNano,
    attributes: [...draft.attributes],
    events: draft.events.map((event) => ({
      timeUnixNano: event.timeUnixNano,
      name: event.name,
      attributes: [...event.attributes],
    })),
    status: draft.status,
  }));
}

function checkCompleteness(completeness: Completeness, spanCount: number): void {
  const violations: string[] = [];
  if (completeness.decoded === "empty" && spanCount > 0) {
    violations.push("an empty decode must carry no spans");
  }
  if (completeness.decoded === "full" && completeness.skipped !== undefined) {
    violations.push("a full decode must not report skipped source records");
  }
  if (
    completeness.decoded === "partial" &&
    (completeness.skipped === undefined || completeness.skipped < 1)
  ) {
    violations.push("a partial decode must report at least one skipped source record");
  }
  if (
    completeness.skipped !== undefined &&
    (!Number.isInteger(completeness.skipped) || completeness.skipped < 0)
  ) {
    violations.push("skipped must be a non-negative integer");
  }
  if (violations.length > 0) throw new DecoderContractError(violations);
}

function checkTimebase(timebase: Timebase): void {
  if (!(TIMEBASES as readonly string[]).includes(timebase)) {
    throw new DecoderContractError([
      `timebase ${String(timebase)} is not one of ${TIMEBASES.join(", ")}`,
    ]);
  }
}

/**
 * Decode digest-bound bytes into a Trace document.
 *
 * Fail-closed on identity: bytes whose sha256 disagrees with the declared native-trace
 * digest are refused before any decoder sees them. Fail-closed on the record surface: a
 * decoder that emits spans the record schema would reject fails here, not at seal time,
 * so the violation is attributed to the decoder rather than to the caller.
 */
export function decodeTrace(
  registry: DecoderRegistry,
  formatIri: string,
  input: DecodeTraceInput,
): TraceDocument {
  const decoder = registry.require(formatIri);

  const actual = sha256Hex(input.bytes);
  if (actual !== input.nativeTrace.digest.sha256) {
    throw new SourceDigestMismatchError(
      `sha256:${input.nativeTrace.digest.sha256}`,
      `sha256:${actual}`,
    );
  }

  const decoded = decoder.decode(input.bytes);
  checkTimebase(decoded.timebase);
  const traceId = deriveTraceId({
    sourceDigest: `sha256:${actual}`,
    formatIri,
    decoderId: decoder.decoderId,
    decoderVersion: decoder.decoderVersion,
    vocabularyProfile: TRACE_VOCABULARY_PROFILE,
  });

  const spans = finalizeSpans(traceId, decoded.drafts);
  checkCompleteness(decoded.completeness, spans.length);

  const invalid = spans.flatMap((span, ordinal) => {
    const parsed = SpanSchema.safeParse(span);
    return parsed.success
      ? []
      : parsed.error.issues.map(
          (issue) =>
            `span ${String(ordinal)}: ${issue.path.join(".")} ${issue.message}`,
        );
  });
  if (invalid.length > 0) throw new DecoderContractError(invalid);

  return {
    protocol: TRACE_PROTOCOL,
    source: {
      nativeTrace: input.nativeTrace,
      formatIri,
    },
    derivation: {
      decoderId: decoder.decoderId,
      decoderVersion: decoder.decoderVersion,
      vocabularyProfile: TRACE_VOCABULARY_PROFILE,
    },
    timebase: decoded.timebase,
    traceId,
    spans,
    completeness: decoded.completeness,
  };
}

/**
 * The non-throwing form, for consumers whose decode is best-effort: a missing decoder or an
 * unreadable trace costs excerpt quality, and must never fail the work the caller was
 * actually doing.
 */
export function tryDecodeTrace(
  registry: DecoderRegistry,
  formatIri: string,
  input: DecodeTraceInput,
): DecodeOutcome {
  try {
    return { ok: true, document: decodeTrace(registry, formatIri, input) };
  } catch (error) {
    if (error instanceof UnsupportedFormatError) {
      return { ok: false, reason: "unsupported-format", detail: error.message };
    }
    if (error instanceof SourceDigestMismatchError) {
      return { ok: false, reason: "source-digest-mismatch", detail: error.message };
    }
    return {
      ok: false,
      reason: "decoder-contract",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}
