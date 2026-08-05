import { describe, expect, it } from "vitest";
import {
  POLICY_OUTCOMES_PROJECTION_FORMAT,
  parsePolicyOutcomesProjection,
  serializePolicyOutcomesProjection,
} from "./serialize.js";
import { projectPolicyOutcomes } from "./projection.js";
import { PolicyOutcomesInputError } from "./observation.js";
import type { PolicyOutcomeObservation } from "./observation.js";

const TUPLE = {
  formatToken: "network.jinn.policy.execution-tuple/1.0",
  harness: { id: "claude-code", version: "2.1.34" },
  model: { id: "anthropic/claude-haiku-4-5" },
  loadout: null,
  isolationPolicy: "unrestricted",
} as const;

const observation = (verdict: "pass" | "fail", n: string): PolicyOutcomeObservation => ({
  tuple: TUPLE,
  perAxisStatus: { harness: "match", model: "match", loadout: "match", isolationPolicy: "match" },
  taskDigest: `sha256:${"c".repeat(64)}`,
  verdict,
  observedAt: `2026-08-05T0${n}:00:00Z`,
  attribution: "urn:jinn:agent:solver-a",
  ref: {
    source: { agent: "https://spec.jinn.network/agents/projector", name: "base-marketplace" },
    entry: `sha256:${"a".repeat(63)}${n}`,
    announcementId: `ann-${n}`,
    record: `sha256:${"b".repeat(63)}${n}`,
    attemptUri: `urn:uuid:0189d1c2-0000-7000-8000-00000000000${n}`,
  },
});

const projection = projectPolicyOutcomes([observation("pass", "1"), observation("fail", "2")]);

describe("serializePolicyOutcomesProjection", () => {
  it("round-trips exactly", () => {
    expect(parsePolicyOutcomesProjection(serializePolicyOutcomesProjection(projection)))
      .toEqual(projection);
  });

  it("is stable: serializing twice yields identical text", () => {
    expect(serializePolicyOutcomesProjection(projection)).toBe(serializePolicyOutcomesProjection(projection));
  });

  it("is independent of input order", () => {
    const reversed = projectPolicyOutcomes([observation("fail", "2"), observation("pass", "1")]);
    expect(serializePolicyOutcomesProjection(reversed)).toBe(serializePolicyOutcomesProjection(projection));
  });

  it("carries no record envelope of any kind", () => {
    const parsed = JSON.parse(serializePolicyOutcomesProjection(projection)) as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual(["format", "rows"]);
    expect(parsed.format).toBe(POLICY_OUTCOMES_PROJECTION_FORMAT);
    expect(String(parsed.format).startsWith("https://spec.jinn.network/records/")).toBe(false);
    for (const key of ["kind", "protocol", "digest", "signatures", "payloadType", "mediaType"]) {
      expect(key in parsed).toBe(false);
    }
  });

  it("rejects a foreign or missing format token", () => {
    expect(() => parsePolicyOutcomesProjection(JSON.stringify({ format: "other/1.0", rows: [] })))
      .toThrow(/format/i);
    expect(() => parsePolicyOutcomesProjection("{}")).toThrow(/format/i);
  });

  it("rejects a stored projection whose counters contradict its inputRefs", () => {
    const tampered = JSON.parse(serializePolicyOutcomesProjection(projection));
    tampered.rows[0].verdicts = 99;
    expect(() => parsePolicyOutcomesProjection(JSON.stringify(tampered))).toThrow(/inputRefs/i);
  });
});

describe("parsePolicyOutcomesProjection: the projection-in boundary", () => {
  const tamper = (mutate: (document: any) => void): string => {
    const document = JSON.parse(serializePolicyOutcomesProjection(projection));
    mutate(document);
    return JSON.stringify(document);
  };

  it("rejects a bare-hex or junk tuple digest", () => {
    expect(() => parsePolicyOutcomesProjection(tamper((d) => { d.rows[0].tupleDigest = "c".repeat(64); })))
      .toThrow(PolicyOutcomesInputError);
    expect(() => parsePolicyOutcomesProjection(tamper((d) => { d.rows[0].tupleDigest = "not-a-digest"; })))
      .toThrow(PolicyOutcomesInputError);
  });

  it("rejects an unknown bucket", () => {
    expect(() => parsePolicyOutcomesProjection(tamper((d) => { d.rows[0].bucket = "wharrgarbl"; })))
      .toThrow(PolicyOutcomesInputError);
  });

  it("rejects a non-instant window", () => {
    expect(() => parsePolicyOutcomesProjection(tamper((d) => { d.rows[0].window.first = "yesterday"; })))
      .toThrow(PolicyOutcomesInputError);
    expect(() => parsePolicyOutcomesProjection(tamper((d) => {
      const { first, last } = d.rows[0].window;
      d.rows[0].window = { first: last, last: first };
    }))).toThrow(PolicyOutcomesInputError);
  });

  it("rejects a malformed input ref", () => {
    expect(() => parsePolicyOutcomesProjection(tamper((d) => { d.rows[0].inputRefs[0].record = "nope"; })))
      .toThrow(PolicyOutcomesInputError);
    expect(() => parsePolicyOutcomesProjection(tamper((d) => { delete d.rows[0].inputRefs[0].attemptUri; })))
      .toThrow(PolicyOutcomesInputError);
  });

  it("rejects a row whose inputRefs repeat one dedupe key", () => {
    expect(() => parsePolicyOutcomesProjection(tamper((d) => {
      d.rows[0].inputRefs = [d.rows[0].inputRefs[0], { ...d.rows[0].inputRefs[0] }];
      d.rows[0].verdicts = 2;
      d.rows[0].attempts = 1;
      d.rows[0].passRate = { num: 1, den: 2 };
      for (const axis of ["harness", "model", "loadout", "isolationPolicy"]) {
        d.rows[0].pinning[axis] = { match: 2, mismatch: 0, unverifiable: 0 };
      }
    }))).toThrow(PolicyOutcomesInputError);
  });

  it("rejects two rows for the same tuple and bucket", () => {
    expect(() => parsePolicyOutcomesProjection(tamper((d) => {
      d.rows = [d.rows[0], JSON.parse(JSON.stringify(d.rows[0]))];
    }))).toThrow(PolicyOutcomesInputError);
  });

  it("rejects one announcement feeding two rows", () => {
    expect(() => parsePolicyOutcomesProjection(tamper((d) => {
      const clone = JSON.parse(JSON.stringify(d.rows[0]));
      clone.bucket = "benchmark";
      d.rows = [clone, d.rows[0]];
    }))).toThrow(PolicyOutcomesInputError);
  });

  it("throws PolicyOutcomesInputError -- never a raw TypeError -- for a null or truncated row", () => {
    for (const rows of [[null], [{}], [{ tupleDigest: `sha256:${"c".repeat(64)}` }]]) {
      let thrown: unknown;
      try {
        parsePolicyOutcomesProjection(JSON.stringify({ format: POLICY_OUTCOMES_PROJECTION_FORMAT, rows }));
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(PolicyOutcomesInputError);
    }
  });

  it("rejects an unknown key rather than carrying it through", () => {
    expect(() => parsePolicyOutcomesProjection(tamper((d) => { d.rows[0].saturation = true; })))
      .toThrow(PolicyOutcomesInputError);
  });

  it("rejects pinning counters that do not sum to verdicts", () => {
    expect(() => parsePolicyOutcomesProjection(tamper((d) => {
      d.rows[0].pinning.harness = { match: 999, mismatch: 0, unverifiable: 0 };
    }))).toThrow(PolicyOutcomesInputError);
  });

  it("rejects axes carrying formatToken (document metadata, not an axis)", () => {
    expect(() => parsePolicyOutcomesProjection(tamper((d) => {
      d.rows[0].axes.formatToken = "network.jinn.policy.execution-tuple/1.0";
    }))).toThrow(PolicyOutcomesInputError);
  });

  it("normalizes row and input-ref order", () => {
    const canonical = serializePolicyOutcomesProjection(projection);
    const shuffled = tamper((d) => { d.rows[0].inputRefs.reverse(); });
    expect(serializePolicyOutcomesProjection(parsePolicyOutcomesProjection(shuffled))).toBe(canonical);
  });
});
