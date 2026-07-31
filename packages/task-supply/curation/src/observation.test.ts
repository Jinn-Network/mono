import { describe, expect, it } from "vitest";
import {
  CurationInputError,
  inputRefKey,
  parseCurationObservation,
  type CurationObservation,
} from "./observation.js";

const ref = {
  source: { agent: "https://jinn.network/agents/projector", name: "base-marketplace" },
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
});

describe("inputRefKey", () => {
  it("is the discovery at-least-once dedupe tuple", () => {
    expect(inputRefKey(ref)).toBe(
      ["https://jinn.network/agents/projector", "base-marketplace", ref.entry, ref.announcementId]
        .join("\u001f"),
    );
  });

  it("separates refs that differ only in announcement id", () => {
    expect(inputRefKey(ref)).not.toBe(inputRefKey({ ...ref, announcementId: "ann-other" }));
  });

  it("ignores fields outside the dedupe tuple", () => {
    expect(inputRefKey({ ...ref, attemptUri: "urn:uuid:0189d1c2-0000-7000-8000-000000000002" }))
      .toBe(inputRefKey(ref));
  });
});
