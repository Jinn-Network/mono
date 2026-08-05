import { describe, expect, test } from "vitest";

import * as api from "./index.js";

describe("public surface", () => {
  test("exports the format registry, the decoder contract, and the decode entrypoints", () => {
    for (const name of [
      "FORMAT_IDENTITIES",
      "FORMAT_IRI_PATTERN",
      "formatIdentity",
      "formatIriForEnvelopeFormat",
      "formatIriForLegacySourceFormat",
      "TIMEBASES",
      "DECODE_FAILURE_REASONS",
      "ADMITTED_ATTRIBUTE_KEYS",
      "sortAttributes",
      "UnsupportedFormatError",
      "SourceDigestMismatchError",
      "DecoderContractError",
      "createDecoderRegistry",
      "createDefaultDecoderRegistry",
      "SHIPPED_DECODERS",
      "finalizeSpans",
      "decodeTrace",
      "tryDecodeTrace",
      "CLAUDE_CODE_STREAM_JSON_FORMAT_IRI",
      "createClaudeCodeStreamJsonDecoder",
    ]) {
      expect(api).toHaveProperty(name);
    }
  });

  test("does not leak the kit, the fake, or the fixture loaders through the root", () => {
    for (const name of [
      "describeTraceDecoderContract",
      "createLineEventsDecoder",
      "lineEventsFixtures",
      "loadClaudeCodeFixtures",
      "traceDecodeFixtureUrl",
    ]) {
      expect(api).not.toHaveProperty(name);
    }
  });

  test("the default registry decodes exactly the formats this package ships", () => {
    expect(api.createDefaultDecoderRegistry().formats).toEqual([
      "https://spec.jinn.network/formats/claude-code-stream-json/v1",
    ]);
  });

  test("every shipped decoder claims a registered harness-trace format", () => {
    for (const decoder of api.SHIPPED_DECODERS) {
      const identity = api.formatIdentity(decoder.formatIri);
      expect(identity, decoder.decoderId).toBeDefined();
      expect(identity!.harnessTrace, decoder.decoderId).toBe(true);
    }
  });

  test("a format the registry knows but no decoder claims resolves to nothing", () => {
    expect(
      api.createDefaultDecoderRegistry().get("https://spec.jinn.network/formats/hermes-json/v1"),
    ).toBeUndefined();
  });
});
