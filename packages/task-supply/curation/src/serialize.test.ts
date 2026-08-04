import { describe, expect, it } from "vitest";
import {
  CURATION_PROJECTION_FORMAT,
  parseCurationProjection,
  serializeCurationProjection,
} from "./serialize.js";
import { projectCuration } from "./projection.js";
import { CurationInputError } from "./observation.js";
import type { CurationObservation } from "./observation.js";

const observation = (verdict: "pass" | "fail", n: string): CurationObservation => ({
  taskDigest: `sha256:${"c".repeat(64)}`,
  verdict,
  observedAt: `2026-07-31T0${n}:00:00Z`,
  attribution: "urn:jinn:agent:solver-a",
  ref: {
    source: { agent: "https://spec.jinn.network/agents/projector", name: "base-marketplace" },
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
    expect(String(parsed.format).startsWith("https://spec.jinn.network/records/")).toBe(false);
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

// The stored projection is an input like any other: it is validated with the same rigor as an
// observation, so a stored row cannot launder a shape the observation boundary would refuse.
describe("parseCurationProjection: the projection-in boundary", () => {
  const tamper = (mutate: (document: any) => void): string => {
    const document = JSON.parse(serializeCurationProjection(projection));
    mutate(document);
    return JSON.stringify(document);
  };

  it("rejects a bare-hex or junk task digest", () => {
    expect(() => parseCurationProjection(tamper((d) => { d.rows[0].taskDigest = "c".repeat(64); })))
      .toThrow(CurationInputError);
    expect(() => parseCurationProjection(tamper((d) => { d.rows[0].taskDigest = "not-a-digest"; })))
      .toThrow(CurationInputError);
  });

  it("rejects an unknown bucket", () => {
    expect(() => parseCurationProjection(tamper((d) => { d.rows[0].bucket = "wharrgarbl"; })))
      .toThrow(CurationInputError);
  });

  it("rejects a non-instant window", () => {
    expect(() => parseCurationProjection(tamper((d) => { d.rows[0].window.first = "yesterday"; })))
      .toThrow(CurationInputError);
    expect(() => parseCurationProjection(tamper((d) => {
      const { first, last } = d.rows[0].window;
      d.rows[0].window = { first: last, last: first };
    }))).toThrow(CurationInputError);
  });

  it("rejects a malformed input ref", () => {
    expect(() => parseCurationProjection(tamper((d) => { d.rows[0].inputRefs[0].record = "nope"; })))
      .toThrow(CurationInputError);
    expect(() => parseCurationProjection(tamper((d) => { delete d.rows[0].inputRefs[0].attemptUri; })))
      .toThrow(CurationInputError);
  });

  it("rejects a row whose inputRefs repeat one dedupe key", () => {
    expect(() => parseCurationProjection(tamper((d) => {
      d.rows[0].inputRefs = [d.rows[0].inputRefs[0], { ...d.rows[0].inputRefs[0] }];
      d.rows[0].verdicts = 2;
      d.rows[0].attempts = 1;
      d.rows[0].passRate = { num: 1, den: 2 };
    }))).toThrow(CurationInputError);
  });

  it("rejects two rows for the same task and bucket", () => {
    expect(() => parseCurationProjection(tamper((d) => {
      d.rows = [d.rows[0], JSON.parse(JSON.stringify(d.rows[0]))];
    }))).toThrow(CurationInputError);
  });

  it("rejects one announcement feeding two rows", () => {
    expect(() => parseCurationProjection(tamper((d) => {
      const clone = JSON.parse(JSON.stringify(d.rows[0]));
      clone.bucket = "benchmark";
      d.rows = [clone, d.rows[0]];
    }))).toThrow(CurationInputError);
  });

  it("throws CurationInputError -- never a raw TypeError -- for a null or truncated row", () => {
    for (const rows of [[null], [{}], [{ taskDigest: `sha256:${"c".repeat(64)}` }]]) {
      let thrown: unknown;
      try {
        parseCurationProjection(JSON.stringify({ format: CURATION_PROJECTION_FORMAT, rows }));
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(CurationInputError);
    }
  });

  it("rejects an unknown key rather than carrying it through", () => {
    expect(() => parseCurationProjection(tamper((d) => { d.rows[0].saturation = true; })))
      .toThrow(CurationInputError);
  });

  it("normalizes row and input-ref order", () => {
    const canonical = serializeCurationProjection(projection);
    const shuffled = tamper((d) => { d.rows[0].inputRefs.reverse(); });
    expect(serializeCurationProjection(parseCurationProjection(shuffled))).toBe(canonical);
  });
});
