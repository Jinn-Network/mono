import { describe, expect, it } from "vitest";
import { projectPolicyOutcomes } from "./projection.js";
import type { AxisFidelityStatus } from "@jinn-network/policy-identity";
import type { PolicyOutcomeObservation } from "./observation.js";

const TUPLE = {
  formatToken: "network.jinn.policy.execution-tuple/1.0",
  harness: { id: "claude-code", version: "2.1.34" },
  model: { id: "anthropic/claude-haiku-4-5" },
  loadout: null,
  isolationPolicy: "unrestricted",
} as const;

const ALL: AxisFidelityStatus = "match";

function observation(n: number, status: Partial<Record<string, AxisFidelityStatus>>): PolicyOutcomeObservation {
  return {
    tuple: TUPLE,
    perAxisStatus: {
      harness: status.harness ?? ALL,
      model: status.model ?? ALL,
      loadout: status.loadout ?? ALL,
      isolationPolicy: status.isolationPolicy ?? ALL,
    },
    taskDigest: `sha256:${"c".repeat(64)}`,
    verdict: "pass",
    observedAt: `2026-08-01T${String(n).padStart(2, "0")}:00:00Z`,
    attribution: "urn:jinn:agent:solver-a",
    ref: {
      source: { agent: "https://jinn.network/agents/projector", name: "base-marketplace" },
      entry: `sha256:${"a".repeat(63)}${n}`,
      announcementId: `ann-axis-${n}`,
      record: `sha256:${"b".repeat(63)}${n}`,
      attemptUri: `urn:uuid:0189d1c2-0000-7000-8000-00000000000${n}`,
    },
  };
}

describe("per-axis pinning counter arithmetic (substrate §7)", () => {
  it("counts match/mismatch/unverifiable independently per axis, summing to verdicts", () => {
    const observations = [
      observation(1, { harness: "match", model: "match", loadout: "match", isolationPolicy: "match" }),
      observation(2, { harness: "mismatch", model: "match", loadout: "unverifiable", isolationPolicy: "match" }),
      observation(3, { harness: "unverifiable", model: "mismatch", loadout: "unverifiable", isolationPolicy: "mismatch" }),
    ];
    const [row] = projectPolicyOutcomes(observations).rows;
    expect(row.verdicts).toBe(3);
    expect(row.pinning).toEqual({
      harness: { match: 1, mismatch: 1, unverifiable: 1 },
      model: { match: 2, mismatch: 1, unverifiable: 0 },
      loadout: { match: 1, mismatch: 0, unverifiable: 2 },
      isolationPolicy: { match: 2, mismatch: 1, unverifiable: 0 },
    });
    for (const axis of ["harness", "model", "loadout", "isolationPolicy"] as const) {
      const counts = row.pinning[axis];
      expect(counts.match + counts.mismatch + counts.unverifiable).toBe(row.verdicts);
    }
  });

  it("the weakest-axis disclosure is per-axis: one axis's mismatch does not affect another's counters", () => {
    const observations = [observation(1, { harness: "mismatch" })];
    const [row] = projectPolicyOutcomes(observations).rows;
    expect(row.pinning.harness).toEqual({ match: 0, mismatch: 1, unverifiable: 0 });
    expect(row.pinning.model).toEqual({ match: 1, mismatch: 0, unverifiable: 0 });
    expect(row.pinning.loadout).toEqual({ match: 1, mismatch: 0, unverifiable: 0 });
    expect(row.pinning.isolationPolicy).toEqual({ match: 1, mismatch: 0, unverifiable: 0 });
  });
});
