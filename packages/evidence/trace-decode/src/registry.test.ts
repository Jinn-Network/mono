import { describe, expect, test } from "vitest";

import { DecoderContractError, UnsupportedFormatError } from "./contract.js";
import type { DecodeResult, TraceDecoder } from "./contract.js";
import { createDecoderRegistry } from "./registry.js";

const empty: DecodeResult = {
  drafts: [],
  completeness: { decoded: "empty", reason: "stub" },
  timebase: "synthetic-ordinal",
};

const decoder = (overrides: Partial<TraceDecoder> = {}): TraceDecoder => ({
  formatIri: "https://jinn.network/formats/claude-code-stream-json/v1",
  decoderId: "claude-code-stream-json",
  decoderVersion: "1.0.0",
  decode: () => empty,
  ...overrides,
});

describe("decoder registry", () => {
  test("lists its formats in a stable order regardless of registration order", () => {
    const a = decoder();
    const b = decoder({
      formatIri: "https://jinn.network/formats/codex-exec-json/v1",
      decoderId: "codex-exec-json",
    });
    expect(createDecoderRegistry([a, b]).formats).toEqual(
      createDecoderRegistry([b, a]).formats,
    );
    expect(createDecoderRegistry([b, a]).formats).toEqual([
      "https://jinn.network/formats/claude-code-stream-json/v1",
      "https://jinn.network/formats/codex-exec-json/v1",
    ]);
  });

  test("get returns undefined for an unknown format rather than throwing", () => {
    expect(
      createDecoderRegistry([decoder()]).get("https://jinn.network/formats/hermes-json/v1"),
    ).toBeUndefined();
  });

  test("require is fail-closed on an unknown format", () => {
    expect(() =>
      createDecoderRegistry([decoder()]).require(
        "https://jinn.network/formats/hermes-json/v1",
      ),
    ).toThrow(UnsupportedFormatError);
  });

  test("rejects two decoders claiming one format", () => {
    expect(() => createDecoderRegistry([decoder(), decoder({ decoderId: "other" })])).toThrow(
      DecoderContractError,
    );
  });

  test("rejects a decoder whose format IRI is not canonical", () => {
    expect(() =>
      createDecoderRegistry([decoder({ formatIri: "claude-code-stream-json" })]),
    ).toThrow(DecoderContractError);
  });

  test("rejects a decoder id that is not a lowercase slug", () => {
    expect(() => createDecoderRegistry([decoder({ decoderId: "Claude_Code" })])).toThrow(
      DecoderContractError,
    );
  });

  test("rejects a decoder version that is not semver", () => {
    expect(() => createDecoderRegistry([decoder({ decoderVersion: "1.0" })])).toThrow(
      DecoderContractError,
    );
  });

  test("an empty registry is legal and resolves nothing", () => {
    const registry = createDecoderRegistry([]);
    expect(registry.formats).toEqual([]);
    expect(registry.get("https://jinn.network/formats/hermes-json/v1")).toBeUndefined();
  });
});
