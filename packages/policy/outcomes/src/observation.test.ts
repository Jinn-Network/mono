import { describe, expect, it } from "vitest";
import {
  PolicyOutcomesInputError,
  inputRefKey,
  parsePolicyOutcomeObservation,
  type PolicyOutcomeObservation,
} from "./observation.js";

const TUPLE = {
  formatToken: "network.jinn.policy.execution-tuple/1.0",
  harness: { id: "claude-code", version: "2.1.34" },
  model: { id: "anthropic/claude-haiku-4-5" },
  loadout: null,
  isolationPolicy: "unrestricted",
} as const;

const ref = {
  source: { agent: "https://spec.jinn.network/agents/projector", name: "base-marketplace" },
  entry: `sha256:${"a".repeat(64)}` as const,
  announcementId: "ann-84532-deadbeef-3-evaluation-delivery-available",
  record: `sha256:${"b".repeat(64)}` as const,
  attemptUri: "urn:uuid:0189d1c2-0000-7000-8000-000000000001",
};

const observation: PolicyOutcomeObservation = {
  tuple: TUPLE,
  perAxisStatus: { harness: "match", model: "match", loadout: "match", isolationPolicy: "match" },
  taskDigest: `sha256:${"c".repeat(64)}`,
  verdict: "pass",
  observedAt: "2026-08-05T09:00:00Z",
  attribution: "urn:jinn:agent:solver-a",
  ref,
};

/** The unit separator the dedupe key joins on, built by code point so no raw byte is typed. */
const SEPARATOR = String.fromCharCode(0x1f);

describe("parsePolicyOutcomeObservation", () => {
  it("accepts a well-formed observation", () => {
    expect(parsePolicyOutcomeObservation(observation)).toEqual(observation);
  });

  it("rejects an unprefixed task digest", () => {
    expect(() => parsePolicyOutcomeObservation({ ...observation, taskDigest: "c".repeat(64) }))
      .toThrow(PolicyOutcomesInputError);
  });

  it("rejects an unknown verdict", () => {
    expect(() => parsePolicyOutcomeObservation({ ...observation, verdict: "maybe" }))
      .toThrow(PolicyOutcomesInputError);
  });

  it("rejects a non-RFC-3339 instant", () => {
    expect(() => parsePolicyOutcomeObservation({ ...observation, observedAt: "5 August 2026" }))
      .toThrow(PolicyOutcomesInputError);
  });

  it("requires attribution", () => {
    const { attribution: _dropped, ...without } = observation;
    expect(() => parsePolicyOutcomeObservation(without)).toThrow(PolicyOutcomesInputError);
  });

  it("accepts an optional benchmark run digest", () => {
    const pinned = { ...observation, benchmarkRun: `sha256:${"d".repeat(64)}` };
    expect(parsePolicyOutcomeObservation(pinned).benchmarkRun).toBe(`sha256:${"d".repeat(64)}`);
  });

  it("rejects an unknown per-axis status value", () => {
    expect(() =>
      parsePolicyOutcomeObservation({
        ...observation,
        perAxisStatus: { ...observation.perAxisStatus, harness: "definitely" },
      }),
    ).toThrow(PolicyOutcomesInputError);
  });

  it("requires all four core per-axis statuses", () => {
    const { isolationPolicy: _dropped, ...withoutIsolation } = observation.perAxisStatus;
    expect(() =>
      parsePolicyOutcomeObservation({ ...observation, perAxisStatus: withoutIsolation }),
    ).toThrow(PolicyOutcomesInputError);
  });

  it("fails closed on a tuple missing a core axis (substrate §4.1 step 5)", () => {
    const { harness: _dropped, ...withoutHarness } = TUPLE;
    expect(() => parsePolicyOutcomeObservation({ ...observation, tuple: withoutHarness }))
      .toThrow(PolicyOutcomesInputError);
  });

  it("fails closed on the wrong tuple format token", () => {
    expect(() =>
      parsePolicyOutcomeObservation({ ...observation, tuple: { ...TUPLE, formatToken: "wrong/1.0" } }),
    ).toThrow(PolicyOutcomesInputError);
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
      expect(() => parsePolicyOutcomeObservation({ ...observation, ref: forged }))
        .toThrow(PolicyOutcomesInputError);
    }
  });

  it("rejects a control character in the free-text fields outside the key", () => {
    expect(() => parsePolicyOutcomeObservation({ ...observation, attribution: `a${SEPARATOR}b` }))
      .toThrow(PolicyOutcomesInputError);
  });
});

describe("inputRefKey", () => {
  it("is the discovery at-least-once dedupe tuple", () => {
    expect(inputRefKey(ref)).toBe(
      ["https://spec.jinn.network/agents/projector", "base-marketplace", ref.entry, ref.announcementId]
        .join(SEPARATOR),
    );
  });

  it("ignores fields outside the dedupe tuple, including record", () => {
    expect(inputRefKey({ ...ref, record: `sha256:${"e".repeat(64)}` })).toBe(inputRefKey(ref));
  });
});
