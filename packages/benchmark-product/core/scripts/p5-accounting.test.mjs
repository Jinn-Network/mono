import assert from "node:assert/strict";
import test from "node:test";
import { auditP5Accounting } from "./p5-accounting.mjs";

function fixture() {
  const cells = Array.from({ length: 12 }, (_, index) => ({
    cellKey: `cell-${index}`,
    dispatches: 1,
    verification: {
      harness: "match",
      model: "match",
      loadout: "match",
      isolation: "match",
      checksFailed: [],
    },
  }));
  return {
    matrix: {
      cells,
      completeness: { expected: 12, judged: 12, runOutcome: "complete" },
    },
    status: { counts: { expected: 12, judged: 12, failed: 0 } },
    comparison: {
      pairs: 3,
      interval: null,
      reasons: ["paired sample below minN=5"],
      clustering: { clusters: 3 },
      bootstrap: {
        count: 3,
        unit: "source-cluster",
        clusters: [{}, {}, {}],
        draws: 3_000,
      },
    },
  };
}

test("accepts the exact 12-cell, three-cluster, no-interval contract", () => {
  assert.deepEqual(auditP5Accounting(fixture()), { clusterCount: 3, draws: 3_000 });
});

test("rejects a missing cell", () => {
  const input = fixture();
  input.matrix.cells.pop();
  assert.throws(() => auditP5Accounting(input), /did not account all 12 cells/u);
});

test("rejects unverifiable evidence and a second dispatch", () => {
  const input = fixture();
  input.matrix.cells[0].verification.harness = "unverifiable";
  assert.throws(() => auditP5Accounting(input), /harness is unverifiable/u);
  input.matrix.cells[0].verification.harness = "match";
  input.matrix.cells[0].dispatches = 2;
  assert.throws(() => auditP5Accounting(input), /non-exact dispatch/u);
});

test("rejects a published interval and raw draw-count drift", () => {
  const input = fixture();
  input.comparison.interval = [0, 1];
  assert.throws(() => auditP5Accounting(input), /did not withhold its interval/u);
  input.comparison.interval = null;
  input.comparison.bootstrap.draws = 6_000;
  assert.throws(() => auditP5Accounting(input), /6000 != 1000 x 3/u);
});
