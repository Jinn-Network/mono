import { describe, expect, it } from "vitest";
import {
  CurationInputError,
  inputRefKey,
  parseCurationObservation,
  type CurationObservation,
} from "./observation.js";

const ref = {
  source: { agent: "https://spec.jinn.network/agents/projector", name: "base-marketplace" },
  entry: `sha256:${"a".repeat(64)}` as const,
  announcementId: "ann-84532-deadbeef-3-evaluation-delivery-available",
  record: `sha256:${"b".repeat(64)}` as const,
  attemptUri: "urn:uuid:0189d1c2-0000-7000-8000-000000000001",
};

const observation: CurationObservation = {
  taskDigest: `sha256:${"c".repeat(64)}`,
  verdict: "pass",
  observedAt: "2026-07-31T09:00:00Z",
  attribution: "urn:jinn:agent:solver-a",
  ref,
};

/** The unit separator the dedupe key joins on, built by code point so no raw byte is typed. */
const SEPARATOR = String.fromCharCode(0x1f);

describe("parseCurationObservation", () => {
  it("accepts a well-formed observation", () => {
    expect(parseCurationObservation(observation)).toEqual(observation);
  });

  it("rejects an unprefixed task digest", () => {
    expect(() => parseCurationObservation({ ...observation, taskDigest: "c".repeat(64) }))
      .toThrow(CurationInputError);
  });

  it("rejects an unknown verdict", () => {
    expect(() => parseCurationObservation({ ...observation, verdict: "maybe" }))
      .toThrow(CurationInputError);
  });

  it("rejects a non-RFC-3339 instant", () => {
    expect(() => parseCurationObservation({ ...observation, observedAt: "31 July 2026" }))
      .toThrow(CurationInputError);
  });

  it("requires attribution (F6: the consumer filter runs on it)", () => {
    const { attribution: _dropped, ...without } = observation;
    expect(() => parseCurationObservation(without)).toThrow(CurationInputError);
  });

  it("accepts an optional benchmark run digest", () => {
    const pinned = { ...observation, benchmarkRun: `sha256:${"d".repeat(64)}` };
    expect(parseCurationObservation(pinned).benchmarkRun).toBe(`sha256:${"d".repeat(64)}`);
  });

  // The dedupe key joins free text on the unit separator. A component carrying that separator
  // re-partitions the key, which is how one source forges a collision with another source's
  // ref -- so the separator, and control characters generally, are refused at the boundary.
  it("rejects a separator or other control character in any key component", () => {
    const cases = [
      { ...ref, source: { agent: `a${SEPARATOR}b`, name: ref.source.name } },
      { ...ref, source: { agent: ref.source.agent, name: `a${SEPARATOR}b` } },
      { ...ref, announcementId: `ann${SEPARATOR}other` },
      { ...ref, announcementId: "ann\nother" },
    ];
    for (const forged of cases) {
      expect(() => parseCurationObservation({ ...observation, ref: forged }))
        .toThrow(CurationInputError);
    }
  });

  it("rejects a control character in the free-text fields outside the key", () => {
    expect(() => parseCurationObservation({ ...observation, attribution: `a${SEPARATOR}b` }))
      .toThrow(CurationInputError);
    expect(() =>
      parseCurationObservation({
        ...observation,
        ref: { ...ref, attemptUri: `urn:uuid${SEPARATOR}forged` },
      }),
    ).toThrow(CurationInputError);
  });
});

describe("inputRefKey", () => {
  it("is the discovery at-least-once dedupe tuple", () => {
    expect(inputRefKey(ref)).toBe(
      ["https://spec.jinn.network/agents/projector", "base-marketplace", ref.entry, ref.announcementId]
        .join(SEPARATOR),
    );
  });

  it("separates refs that differ only in announcement id", () => {
    expect(inputRefKey(ref)).not.toBe(inputRefKey({ ...ref, announcementId: "ann-other" }));
  });

  it("ignores fields outside the dedupe tuple", () => {
    expect(inputRefKey({ ...ref, attemptUri: "urn:uuid:0189d1c2-0000-7000-8000-000000000002" }))
      .toBe(inputRefKey(ref));
  });

  // Without this, {agent: "ab", name: "c"} and {agent: "a", name: "bc"} key alike.
  it("refuses to key a ref whose components carry the separator", () => {
    const left = { ...ref, source: { agent: `a${SEPARATOR}b`, name: "c" } };
    const right = { ...ref, source: { agent: "a", name: `b${SEPARATOR}c` } };
    expect(() => inputRefKey(left)).toThrow(CurationInputError);
    expect(() => inputRefKey(right)).toThrow(CurationInputError);
  });
});
