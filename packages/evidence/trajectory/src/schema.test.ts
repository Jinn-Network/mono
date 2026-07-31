import { describe, expect, test } from "vitest";

import { deriveSpanId, deriveTraceId } from "./identity.js";
import { TRAJECTORY_PROTOCOL, TRAJECTORY_VOCABULARY_PROFILE } from "./identifiers.js";
import { InvalidDocumentError } from "./sealing.js";
import { SPAN_KIND, STATUS_CODE } from "./span.js";
import { TrajectoryRecordSchema, parseTrajectory, sealTrajectory } from "./schema.js";

const SOURCE_DIGEST = `sha256:${"a".repeat(64)}`;
const DECODER = { decoderId: "claude-code-stream-json", decoderVersion: "1.0.0" };

const traceId = deriveTraceId({
  sourceDigest: SOURCE_DIGEST,
  vocabularyProfile: TRAJECTORY_VOCABULARY_PROFILE,
  ...DECODER,
});

const record = () => ({
  protocol: TRAJECTORY_PROTOCOL,
  source: {
    nativeTrace: {
      name: "stdout.jsonl",
      mediaType: "application/x-ndjson",
      digest: { sha256: "a".repeat(64) },
    },
    formatIri: "https://jinn.network/formats/claude-code-stream-json/v1",
  },
  derivation: {
    ...DECODER,
    vocabularyProfile: TRAJECTORY_VOCABULARY_PROFILE,
  },
  traceId,
  spans: [
    {
      spanId: deriveSpanId(traceId, 0),
      parentSpanId: null,
      name: "chat anthropic/claude-opus-4.6",
      kind: SPAN_KIND.CLIENT,
      startTimeUnixNano: "1000",
      endTimeUnixNano: "2000",
      attributes: [{ key: "gen_ai.provider.name", value: { stringValue: "anthropic" } }],
      events: [],
      status: { code: STATUS_CODE.OK },
    },
  ],
  completeness: { decoded: "full" },
});

describe("trajectory record schema", () => {
  test("accepts a well-formed record", () => {
    expect(TrajectoryRecordSchema.safeParse(record()).success).toBe(true);
  });

  test("rejects a forged trace id", () => {
    const result = TrajectoryRecordSchema.safeParse({ ...record(), traceId: "f".repeat(32) });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result)).toContain("traceId");
  });

  test("rejects a forged span id", () => {
    const forged = record();
    forged.spans[0]!.spanId = "f".repeat(16);
    const result = TrajectoryRecordSchema.safeParse(forged);
    expect(result.success).toBe(false);
    expect(JSON.stringify(result)).toContain("spanId");
  });

  test("rejects a span whose parent is not an earlier span in this record", () => {
    const orphan = record();
    (orphan.spans[0] as unknown as { parentSpanId: string | null }).parentSpanId =
      "0".repeat(16);
    expect(TrajectoryRecordSchema.safeParse(orphan).success).toBe(false);
  });

  test("rejects a source digest that disagrees with the derivation inputs", () => {
    const mismatched = record();
    mismatched.source.nativeTrace.digest.sha256 = "b".repeat(64);
    expect(TrajectoryRecordSchema.safeParse(mismatched).success).toBe(false);
  });

  test("rejects a non-namespaced extension key", () => {
    expect(TrajectoryRecordSchema.safeParse({ ...record(), extra: 1 }).success).toBe(false);
  });

  test("accepts a namespaced extension key", () => {
    expect(
      TrajectoryRecordSchema.safeParse({ ...record(), "network.jinn.note": "kept" }).success,
    ).toBe(true);
  });

  test("rejects an unknown protocol literal", () => {
    expect(
      TrajectoryRecordSchema.safeParse({ ...record(), protocol: "https://example.test/x" })
        .success,
    ).toBe(false);
  });

  test("seals and re-parses to the same digest", () => {
    const sealed = sealTrajectory(record());
    expect(parseTrajectory(sealed.bytes).traceId).toBe(traceId);
    expect(sealTrajectory(record()).digest).toBe(sealed.digest);
  });

  test("sealing an invalid record throws InvalidDocumentError", () => {
    expect(() => sealTrajectory({ ...record(), traceId: "f".repeat(32) })).toThrow(
      InvalidDocumentError,
    );
  });

  test("an empty span list is permitted and marked", () => {
    const empty = { ...record(), spans: [], completeness: { decoded: "empty" } };
    expect(TrajectoryRecordSchema.safeParse(empty).success).toBe(true);
  });
});
