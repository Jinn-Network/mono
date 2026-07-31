// SPDX-License-Identifier: Apache-2.0

import {
  SPAN_KIND,
  STATUS_CODE,
  SpanSchema,
  TRAJECTORY_VOCABULARY_PROFILE,
  deriveSpanId,
  deriveTraceId,
  parseTrajectory,
  sealTrajectory,
  serializeCanonicalJson,
  sha256Hex,
} from "@jinn-network/evidence-trajectory";
import { beforeEach, describe, expect, test } from "vitest";

import {
  ADMITTED_ATTRIBUTE_KEYS,
  sortAttributes,
} from "./contract.js";
import type {
  Completeness,
  DecodeResult,
  SpanDraft,
  TraceDecoder,
  TraceDecoderFixture,
} from "./contract.js";
import { decodeTrajectory, finalizeSpans, tryDecodeTrajectory } from "./decode.js";
import { FORMAT_IRI_PATTERN } from "./formats.js";
import { createDecoderRegistry } from "./registry.js";

export type { TraceDecoderFixture } from "./contract.js";
export {
  loadClaudeCodeFixtures,
  loadDecoderFixtureManifest,
  traceDecodeFixtureUrl,
} from "./fixtures.js";
export type {
  DecoderFixtureManifest,
  DecoderFixtureManifestEntry,
} from "./fixtures.js";

export interface TraceDecoderContractContext {
  readonly decoder: TraceDecoder;
  readonly fixtures: readonly TraceDecoderFixture[];
}

export type TraceDecoderContractFactory = (
  testName: string,
) => TraceDecoderContractContext | Promise<TraceDecoderContractContext>;

const DECODER_ID_PATTERN = /^[a-z][a-z0-9-]*$/;
const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const HEX_16 = /^[0-9a-f]{16}$/;
const UNSIGNED_DECIMAL = /^(0|[1-9]\d*)$/;

const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

function nativeTrace(bytes: Uint8Array) {
  return {
    name: "native-trace",
    mediaType: "application/octet-stream",
    digest: { sha256: sha256Hex(bytes) },
  };
}

function nativeTraceForSeal(decoder: TraceDecoder, bytes: Uint8Array) {
  if (decoder.decoderId === "claude-code-stream-json") {
    return {
      name: "stdout.jsonl",
      mediaType: "application/x-ndjson",
      digest: { sha256: sha256Hex(bytes) },
    };
  }
  return nativeTrace(bytes);
}

function traceIdFor(decoder: TraceDecoder, bytes: Uint8Array): string {
  return deriveTraceId({
    sourceDigest: `sha256:${sha256Hex(bytes)}`,
    formatIri: decoder.formatIri,
    decoderId: decoder.decoderId,
    decoderVersion: decoder.decoderVersion,
    vocabularyProfile: TRAJECTORY_VOCABULARY_PROFILE,
  });
}

/**
 * Conformance for one native-trace decoder.
 *
 * Any implementation claiming a format IRI runs this driver to prove it reproduces the
 * decoder surface: pinned byte-to-span output, determinism across repeat runs, the fixed
 * attribute ordering and vocabulary, the record surface, digest binding as a fail-closed
 * gate, and fail-open behavior on unreadable content.
 *
 * Sealing here proves digest-bound document assembly and determinism (record identity).
 * C2 does not claim L4 by sealing alone — four-layer honesty stops short of attestation
 * authority that a caller with signer/repository supplies.
 */
export function describeTraceDecoderContract(
  name: string,
  createContext: TraceDecoderContractFactory,
): void {
  describe(`TraceDecoder contract: ${name}`, () => {
    let context: TraceDecoderContractContext;

    beforeEach(async (testContext) => {
      context = await createContext(testContext.task.name);
    });

    test("declares a canonical format IRI, a slug decoder id, and a semver version", () => {
      expect(context.decoder.formatIri).toMatch(FORMAT_IRI_PATTERN);
      expect(context.decoder.decoderId).toMatch(DECODER_ID_PATTERN);
      expect(context.decoder.decoderVersion).toMatch(SEMVER_PATTERN);
    });

    test("the fixture corpus is non-empty and exercises at least one span", () => {
      expect(context.fixtures.length).toBeGreaterThan(0);
      expect(
        context.fixtures.some((fixture) => fixture.expected.spans.length > 0),
      ).toBe(true);
      expect(new Set(context.fixtures.map((fixture) => fixture.id)).size).toBe(
        context.fixtures.length,
      );
    });

    test("decodes every fixture to its pinned spans", () => {
      for (const fixture of context.fixtures) {
        const traceId = traceIdFor(context.decoder, fixture.bytes);
        const decoded = context.decoder.decode(fixture.bytes);
        expect(finalizeSpans(traceId, decoded.drafts), fixture.id).toEqual(
          fixture.expected.spans,
        );
        expect(decoded.completeness, fixture.id).toEqual(fixture.expected.completeness);
        expect(decoded.timebase, fixture.id).toBe(fixture.expected.timebase);
      }
    });

    test("decodes identically on a repeat run — no clock, no randomness", () => {
      for (const fixture of context.fixtures) {
        const once = context.decoder.decode(fixture.bytes);
        const twice = context.decoder.decode(fixture.bytes);
        expect(
          text(serializeCanonicalJson(JSON.parse(JSON.stringify(twice)))),
          fixture.id,
        ).toBe(text(serializeCanonicalJson(JSON.parse(JSON.stringify(once)))));
      }
    });

    test("emits only vocabulary attributes, sorted by key and unique", () => {
      for (const fixture of context.fixtures) {
        for (const span of fixture.expected.spans) {
          for (const attributes of [
            span.attributes,
            ...span.events.map((event) => event.attributes),
          ]) {
            for (const attribute of attributes) {
              expect(
                ADMITTED_ATTRIBUTE_KEYS.has(attribute.key),
                `${fixture.id}: ${attribute.key}`,
              ).toBe(true);
            }
            expect(sortAttributes(attributes), fixture.id).toEqual([...attributes]);
          }
        }
      }
    });

    test("rejects attributes outside the closed vocabulary", () => {
      const draft = {
        parentOrdinal: null as number | null,
        name: "invoke_agent fixture",
        kind: SPAN_KIND.INTERNAL,
        startTimeUnixNano: "0",
        endTimeUnixNano: "1",
        attributes: [
          { key: "message.content", value: { stringValue: "secret" } },
        ],
        events: [],
        status: { code: STATUS_CODE.OK },
      };
      const fixture = context.fixtures[0]!;
      const traceId = traceIdFor(context.decoder, fixture.bytes);
      expect(() => finalizeSpans(traceId, [draft])).toThrow();
      expect(() =>
        sortAttributes([{ key: "message.content", value: { stringValue: "secret" } }]),
      ).toThrow();
    });

    test("emits lowercase hex identifiers and unsigned decimal-string times", () => {
      for (const fixture of context.fixtures) {
        for (const span of fixture.expected.spans) {
          expect(span.spanId, fixture.id).toMatch(HEX_16);
          if (span.parentSpanId !== null) {
            expect(span.parentSpanId, fixture.id).toMatch(HEX_16);
          }
          expect(span.startTimeUnixNano, fixture.id).toMatch(UNSIGNED_DECIMAL);
          expect(span.endTimeUnixNano, fixture.id).toMatch(UNSIGNED_DECIMAL);
          expect(
            BigInt(span.endTimeUnixNano) >= BigInt(span.startTimeUnixNano),
            fixture.id,
          ).toBe(true);
          expect(SpanSchema.safeParse(span).success, fixture.id).toBe(true);
        }
      }
    });

    test("every identifier is derived, so a consumer can recompute it", () => {
      for (const fixture of context.fixtures) {
        const traceId = traceIdFor(context.decoder, fixture.bytes);
        fixture.expected.spans.forEach((span, ordinal) => {
          expect(span.spanId, `${fixture.id}[${String(ordinal)}]`).toBe(
            deriveSpanId(traceId, ordinal),
          );
        });
      }
    });

    test("seals to a Trajectory record that re-parses, and holds its pinned digest", () => {
      const registry = createDecoderRegistry([context.decoder]);
      for (const fixture of context.fixtures) {
        const document = decodeTrajectory(registry, context.decoder.formatIri, {
          bytes: fixture.bytes,
          nativeTrace: nativeTraceForSeal(context.decoder, fixture.bytes),
        });
        const sealed = sealTrajectory(document);
        expect(parseTrajectory(sealed.bytes).traceId, fixture.id).toBe(document.traceId);
        expect(sealTrajectory(document).digest, fixture.id).toBe(sealed.digest);
        if (fixture.expected.recordDigest !== undefined) {
          expect(sealed.digest, fixture.id).toBe(fixture.expected.recordDigest);
        }
      }
    });

    test("refuses bytes that do not match the declared native-trace digest", () => {
      const registry = createDecoderRegistry([context.decoder]);
      for (const fixture of context.fixtures) {
        const outcome = tryDecodeTrajectory(registry, context.decoder.formatIri, {
          bytes: fixture.bytes,
          nativeTrace: { digest: { sha256: "b".repeat(64) } },
        });
        expect(outcome, fixture.id).toMatchObject({
          ok: false,
          reason: "source-digest-mismatch",
        });
      }
    });

    test("never throws on truncated input — unreadable content is reported, not raised", () => {
      for (const fixture of context.fixtures) {
        for (const fraction of [0, 0.25, 0.5, 0.75]) {
          const cut = Math.floor(fixture.bytes.length * fraction);
          const truncated = fixture.bytes.slice(0, cut);
          const decoded = context.decoder.decode(truncated);
          expect(Array.isArray(decoded.drafts), `${fixture.id}@${String(cut)}`).toBe(true);
          expect(
            ["full", "partial", "empty"].includes(decoded.completeness.decoded),
            `${fixture.id}@${String(cut)}`,
          ).toBe(true);
        }
      }
    });

    test("never throws on bytes that are not this format at all", () => {
      for (const bytes of [
        new Uint8Array(),
        new Uint8Array([0x00, 0xff, 0xfe, 0x7f]),
        new TextEncoder().encode("not this format\n{ still not }\n"),
      ]) {
        const decoded = context.decoder.decode(bytes);
        expect(["full", "partial", "empty"]).toContain(decoded.completeness.decoded);
        if (decoded.completeness.decoded === "empty") {
          expect(decoded.drafts).toEqual([]);
        }
        if (decoded.completeness.decoded === "partial") {
          expect(typeof decoded.completeness.skipped).toBe("number");
        }
      }
    });
  });
}

export const LINE_EVENTS_FORMAT_IRI =
  "https://jinn.network/formats/fixture-line-events/v1" as const;

const LINE_EVENTS_DECODER_ID = "fixture-line-events";
const LINE_EVENTS_DECODER_VERSION = "1.0.0";

function lineEventsDrafts(bytes: Uint8Array): DecodeResult {
  const lines = new TextDecoder().decode(bytes).split("\n");
  const drafts: SpanDraft[] = [];
  let skipped = 0;
  let last = 0;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!.trim();
    if (line === "") continue;
    if (line.startsWith("!")) {
      skipped += 1;
      continue;
    }
    if (drafts.length === 0) {
      drafts.push({
        parentOrdinal: null,
        name: "invoke_agent fixture",
        kind: SPAN_KIND.INTERNAL,
        startTimeUnixNano: String(index),
        endTimeUnixNano: String(index),
        attributes: sortAttributes([
          { key: "gen_ai.agent.name", value: { stringValue: "fixture" } },
          { key: "gen_ai.operation.name", value: { stringValue: "invoke_agent" } },
        ]),
        events: [],
        status: { code: STATUS_CODE.OK },
      });
    }
    drafts.push({
      parentOrdinal: 0,
      name: "chat fixture",
      kind: SPAN_KIND.CLIENT,
      startTimeUnixNano: String(index),
      endTimeUnixNano: String(index + 1),
      attributes: sortAttributes([
        { key: "gen_ai.operation.name", value: { stringValue: "chat" } },
        { key: "jinn.trajectory.source.ordinal", value: { intValue: String(index) } },
      ]),
      events: [],
      status: { code: STATUS_CODE.OK },
    });
    last = index + 1;
  }

  if (drafts.length > 0) {
    drafts[0] = { ...drafts[0]!, endTimeUnixNano: String(last) };
  }

  const completeness: Completeness =
    drafts.length === 0
      ? {
          decoded: "empty",
          ...(skipped > 0 ? { skipped } : {}),
          reason: "no readable lines",
        }
      : skipped > 0
        ? { decoded: "partial", skipped, reason: "unreadable lines were skipped" }
        : { decoded: "full" };

  return { drafts, completeness, timebase: "synthetic-ordinal" };
}

/** A decoder for a format that exists only to prove the conformance kit passable. */
export function createLineEventsDecoder(): TraceDecoder {
  return {
    formatIri: LINE_EVENTS_FORMAT_IRI,
    decoderId: LINE_EVENTS_DECODER_ID,
    decoderVersion: LINE_EVENTS_DECODER_VERSION,
    decode: lineEventsDrafts,
  };
}

function lineEventsFixture(
  id: string,
  description: string,
  source: string,
): TraceDecoderFixture {
  const bytes = new TextEncoder().encode(source);
  const decoder = createLineEventsDecoder();
  const expectedDrafts = lineEventsDrafts(bytes);
  return {
    id,
    description,
    bytes,
    expected: {
      timebase: expectedDrafts.timebase,
      completeness: expectedDrafts.completeness,
      spans: finalizeSpans(traceIdFor(decoder, bytes), expectedDrafts.drafts),
    },
  };
}

export function lineEventsFixtures(): readonly TraceDecoderFixture[] {
  return [
    lineEventsFixture("two-readable", "Two readable lines and nothing else.", "alpha\nbeta\n"),
    lineEventsFixture(
      "one-unreadable",
      "One readable line beside one the decoder cannot interpret.",
      "alpha\n!garbage\n",
    ),
    lineEventsFixture("all-blank", "Whitespace only; nothing to decode.", "\n  \n\n"),
  ];
}
