import { describe, expect, test } from "vitest";

import {
  SPAN_KIND,
  STATUS_CODE,
  TRACE_PROTOCOL,
  TRACE_VOCABULARY_PROFILE,
  deriveSpanId,
  deriveTraceId,
  parseTrace,
  sealTrace,
  sha256Hex,
} from "@jinn-network/evidence-trace";

import {
  DecoderContractError,
  SourceDigestMismatchError,
  UnsupportedFormatError,
} from "./contract.js";
import type { DecodeResult, SpanDraft, TraceDecoder } from "./contract.js";
import { decodeTrace, finalizeSpans, tryDecodeTrace } from "./decode.js";
import { createDecoderRegistry } from "./registry.js";

const FORMAT = "https://spec.jinn.network/formats/claude-code-stream-json/v1";
const BYTES = new TextEncoder().encode("one\ntwo\n");
const DIGEST = sha256Hex(BYTES);

const draft = (overrides: Partial<SpanDraft> = {}): SpanDraft => ({
  parentOrdinal: null,
  name: "invoke_agent claude-code",
  kind: SPAN_KIND.INTERNAL,
  startTimeUnixNano: "0",
  endTimeUnixNano: "2",
  attributes: [{ key: "gen_ai.agent.name", value: { stringValue: "claude-code" } }],
  events: [],
  status: { code: STATUS_CODE.OK },
  ...overrides,
});

const result = (overrides: Partial<DecodeResult> = {}): DecodeResult => ({
  drafts: [draft()],
  completeness: { decoded: "full" },
  timebase: "synthetic-ordinal",
  ...overrides,
});

const decoderFor = (produce: () => DecodeResult): TraceDecoder => ({
  formatIri: FORMAT,
  decoderId: "claude-code-stream-json",
  decoderVersion: "1.0.0",
  decode: produce,
});

const registryFor = (produce: () => DecodeResult) =>
  createDecoderRegistry([decoderFor(produce)]);

const input = (digest = DIGEST) => ({
  bytes: BYTES,
  nativeTrace: {
    name: "stdout.jsonl",
    mediaType: "application/x-ndjson",
    digest: { sha256: digest },
  },
});

const traceId = deriveTraceId({
  sourceDigest: `sha256:${DIGEST}`,
  formatIri: FORMAT,
  decoderId: "claude-code-stream-json",
  decoderVersion: "1.0.0",
  vocabularyProfile: TRACE_VOCABULARY_PROFILE,
});

describe("finalizeSpans", () => {
  test("assigns every identifier from the trace id and the ordinal", () => {
    const spans = finalizeSpans(traceId, [draft(), draft({ parentOrdinal: 0 })]);
    expect(spans[0]?.spanId).toBe(deriveSpanId(traceId, 0));
    expect(spans[0]?.parentSpanId).toBeNull();
    expect(spans[1]?.spanId).toBe(deriveSpanId(traceId, 1));
    expect(spans[1]?.parentSpanId).toBe(deriveSpanId(traceId, 0));
  });

  test("rejects a parent that is not an earlier span", () => {
    expect(() => finalizeSpans(traceId, [draft({ parentOrdinal: 0 })])).toThrow(
      DecoderContractError,
    );
    expect(() => finalizeSpans(traceId, [draft(), draft({ parentOrdinal: 5 })])).toThrow(
      DecoderContractError,
    );
  });

  test("rejects attributes a decoder left unsorted or outside the vocabulary", () => {
    expect(() =>
      finalizeSpans(traceId, [
        draft({
          attributes: [
            { key: "gen_ai.provider.name", value: { stringValue: "anthropic" } },
            { key: "gen_ai.agent.name", value: { stringValue: "claude-code" } },
          ],
        }),
      ]),
    ).toThrow(DecoderContractError);
    expect(() =>
      finalizeSpans(traceId, [
        draft({ attributes: [{ key: "message.content", value: { stringValue: "hi" } }] }),
      ]),
    ).toThrow(DecoderContractError);
  });

  test("rejects an event whose attributes are unsorted", () => {
    expect(() =>
      finalizeSpans(traceId, [
        draft({
          events: [
            {
              timeUnixNano: "1",
              name: "note",
              attributes: [
                { key: "gen_ai.tool.name", value: { stringValue: "read" } },
                { key: "gen_ai.tool.call.id", value: { stringValue: "c1" } },
              ],
            },
          ],
        }),
      ]),
    ).toThrow(DecoderContractError);
  });

  test("is a pure function of its inputs", () => {
    expect(JSON.stringify(finalizeSpans(traceId, [draft()]))).toBe(
      JSON.stringify(finalizeSpans(traceId, [draft()])),
    );
  });
});

describe("decodeTrace", () => {
  test("assembles a document that seals and re-parses under the record schema", () => {
    const document = decodeTrace(registryFor(result), FORMAT, input());
    expect(document.protocol).toBe(TRACE_PROTOCOL);
    expect(document.traceId).toBe(traceId);
    expect(document.source.formatIri).toBe(FORMAT);
    expect(document.derivation.vocabularyProfile).toBe(TRACE_VOCABULARY_PROFILE);
    expect(document.timebase).toBe("synthetic-ordinal");

    const sealed = sealTrace(document);
    expect(parseTrace(sealed.bytes).traceId).toBe(traceId);
  });

  test("is byte-identical across repeated decodes of the same bytes", () => {
    const registry = registryFor(result);
    expect(sealTrace(decodeTrace(registry, FORMAT, input())).digest).toBe(
      sealTrace(decodeTrace(registry, FORMAT, input())).digest,
    );
  });

  test("refuses bytes that do not match the declared native-trace digest", () => {
    expect(() => decodeTrace(registryFor(result), FORMAT, input("b".repeat(64)))).toThrow(
      SourceDigestMismatchError,
    );
  });

  test("refuses an unregistered format", () => {
    expect(() =>
      decodeTrace(
        registryFor(result),
        "https://spec.jinn.network/formats/hermes-json/v1",
        input(),
      ),
    ).toThrow(UnsupportedFormatError);
  });

  test("refuses a decoder whose spans do not validate under the record's span schema", () => {
    const backwards = () =>
      result({ drafts: [draft({ startTimeUnixNano: "9", endTimeUnixNano: "1" })] });
    expect(() => decodeTrace(registryFor(backwards), FORMAT, input())).toThrow(
      DecoderContractError,
    );
  });

  test("refuses a completeness verdict the record schema would reject", () => {
    const bad = () => result({ completeness: { decoded: "partial" } });
    expect(() => decodeTrace(registryFor(bad), FORMAT, input())).toThrow(
      DecoderContractError,
    );
  });

  test("refuses partial decode with skipped: 0", () => {
    const bad = () => result({ completeness: { decoded: "partial", skipped: 0 } });
    expect(() => decodeTrace(registryFor(bad), FORMAT, input())).toThrow(
      DecoderContractError,
    );
  });

  test("refuses full decode with skipped set", () => {
    const bad = () => result({ completeness: { decoded: "full", skipped: 1 } });
    expect(() => decodeTrace(registryFor(bad), FORMAT, input())).toThrow(
      DecoderContractError,
    );
  });

  test('refuses timebase "source" (invalid; C1 uses source-epoch-ns)', () => {
    const bad = () =>
      result({ timebase: "source" as "synthetic-ordinal" });
    expect(() => decodeTrace(registryFor(bad), FORMAT, input())).toThrow(
      DecoderContractError,
    );
  });
});

describe("tryDecodeTrace", () => {
  test("returns the document on the success arm", () => {
    const outcome = tryDecodeTrace(registryFor(result), FORMAT, input());
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.document.traceId).toBe(traceId);
  });

  test("never throws, and names why it failed", () => {
    const unsupported = tryDecodeTrace(
      registryFor(result),
      "https://spec.jinn.network/formats/hermes-json/v1",
      input(),
    );
    expect(unsupported).toMatchObject({ ok: false, reason: "unsupported-format" });

    const mismatch = tryDecodeTrace(registryFor(result), FORMAT, input("b".repeat(64)));
    expect(mismatch).toMatchObject({ ok: false, reason: "source-digest-mismatch" });

    const violating = tryDecodeTrace(
      registryFor(() => result({ drafts: [draft({ parentOrdinal: 3 })] })),
      FORMAT,
      input(),
    );
    expect(violating).toMatchObject({ ok: false, reason: "decoder-contract" });
  });

  test("converts an unexpected decoder throw into the contract arm", () => {
    const exploding = createDecoderRegistry([
      {
        formatIri: FORMAT,
        decoderId: "claude-code-stream-json",
        decoderVersion: "1.0.0",
        decode: () => {
          throw new TypeError("decoder blew up");
        },
      },
    ]);
    const outcome = tryDecodeTrace(exploding, FORMAT, input());
    expect(outcome).toMatchObject({ ok: false, reason: "decoder-contract" });
    if (!outcome.ok) expect(outcome.detail).toContain("decoder blew up");
  });
});
