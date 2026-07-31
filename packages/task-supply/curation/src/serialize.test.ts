import { describe, expect, it } from "vitest";
import {
  CURATION_PROJECTION_FORMAT,
  parseCurationProjection,
  serializeCurationProjection,
} from "./serialize.js";
import { projectCuration } from "./projection.js";
import type { CurationObservation } from "./observation.js";

const observation = (verdict: "pass" | "fail", n: string): CurationObservation => ({
  taskDigest: `sha256:${"c".repeat(64)}`,
  verdict,
  observedAt: `2026-07-31T0${n}:00:00Z`,
  attribution: "urn:jinn:agent:solver-a",
  ref: {
    source: { agent: "https://jinn.network/agents/projector", name: "base-marketplace" },
    entry: `sha256:${"a".repeat(63)}${n}`,
    announcementId: `ann-${n}`,
    record: `sha256:${"b".repeat(63)}${n}`,
    attemptUri: `urn:uuid:0189d1c2-0000-7000-8000-00000000000${n}`,
  },
});

const projection = projectCuration([observation("pass", "1"), observation("fail", "2")]);

describe("serializeCurationProjection", () => {
  it("round-trips exactly", () => {
    expect(parseCurationProjection(serializeCurationProjection(projection))).toEqual(projection);
  });

  it("is stable: serializing twice yields identical text", () => {
    expect(serializeCurationProjection(projection)).toBe(serializeCurationProjection(projection));
  });

  it("is independent of input order", () => {
    const reversed = projectCuration([observation("fail", "2"), observation("pass", "1")]);
    expect(serializeCurationProjection(reversed)).toBe(serializeCurationProjection(projection));
  });

  // Constraint 14: projection, never record.
  it("carries no record envelope of any kind", () => {
    const parsed = JSON.parse(serializeCurationProjection(projection)) as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual(["format", "rows"]);
    expect(parsed.format).toBe(CURATION_PROJECTION_FORMAT);
    expect(String(parsed.format).startsWith("https://jinn.network/records/")).toBe(false);
    for (const key of ["kind", "protocol", "digest", "signatures", "payloadType", "mediaType"]) {
      expect(key in parsed).toBe(false);
    }
  });

  it("rejects a foreign or missing format token", () => {
    expect(() => parseCurationProjection(JSON.stringify({ format: "other/1.0", rows: [] })))
      .toThrow(/format/i);
    expect(() => parseCurationProjection("{}")).toThrow(/format/i);
  });

  it("rejects a stored projection whose counters contradict its inputRefs", () => {
    const tampered = JSON.parse(serializeCurationProjection(projection));
    tampered.rows[0].verdicts = 99;
    expect(() => parseCurationProjection(JSON.stringify(tampered))).toThrow(/inputRefs/i);
  });
});
