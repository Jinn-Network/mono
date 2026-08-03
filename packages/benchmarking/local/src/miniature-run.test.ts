// SPDX-License-Identifier: MIT

import {
  BENCHMARKING_PROTOCOL,
  parseBenchmark,
  parseRun,
  sealBenchmark,
  sealRun,
  type BenchmarkRecord,
  type MatrixCell,
  type RunRecord,
} from "@jinn-network/benchmarking-records";
import { assembleMatrix, type InScopeCell } from "@jinn-network/benchmarking-run";
import type { EvaluationSpec } from "@jinn-network/task-execution-profiles";
import { describe, expect, test } from "vitest";
import { localAssemblyPorts } from "./assembly-ports.js";
import type { LocalCellPinningEvidence } from "./pinning-bridge.js";
import {
  axisObservationsFromRuntimeObservations,
  runPinningPropertyId,
} from "./runtime-observations.js";

/**
 * A miniature local Run: two tasks x two arms x one replicate, executed on a local venue
 * whose launcher inventory admits one isolation policy. Three cells are honest; the fourth
 * is the deliberately-swapped cell — its recorded execution used the *other* arm's loadout,
 * harness, and model.
 */

const TASK_A = "a".repeat(64);
const TASK_B = "b".repeat(64);

const HARNESS_PINNED = { id: "claude-code", version: "2.1.34" };
const HARNESS_SWAPPED = { id: "claude-code", version: "1.9.0" };
const MODEL_A = { id: "anthropic/claude-haiku-4-5" };
const MODEL_B = { id: "anthropic/claude-sonnet-4-5" };
const LOADOUT_A = {
  kind: "jinn.skill.v1",
  name: "repo-work-parent",
  digest: `sha256:${"1".repeat(64)}`,
};
const LOADOUT_B = {
  kind: "jinn.harness-state.v1",
  name: "repo-work-candidate",
  digest: `sha256:${"2".repeat(64)}`,
};

const EVAL_SPEC = {
  protocol: "https://jinn.network/profiles/evaluation-spec/1.0",
  family: "deterministic-process",
  semanticsVersion: "4",
  measurements: [{ name: "passed", type: "boolean", required: true }],
  verdictRule: { threshold: { measurement: "passed", op: "eq", value: true } },
  unscorable: [],
  evidenceConventions: { requiredRefs: [] },
  familyBlock: {
    image: { uri: "https://example.org/img", digest: { sha256: "c".repeat(64) } },
    platform: "linux/amd64",
    timeout: 60,
    workspace: {},
    transitions: { failToPass: [], passToPass: [] },
    testMaterial: [],
    parser: { id: "jinn.parser.x", version: "1.0.0", digest: `sha256:${"d".repeat(64)}` },
  },
  grader: { name: "jinn.parser.x", digest: { sha256: "d".repeat(64) }, accessClass: "public" },
} as EvaluationSpec;

const EVAL_SPEC_DIGEST = `sha256:${"e".repeat(64)}`;
const SOLVER = "urn:uuid:30000000-0000-5000-8000-000000000001";
const EVALUATOR = "urn:uuid:30000000-0000-5000-8000-000000000002";

function miniatureBenchmark(): BenchmarkRecord {
  return parseBenchmark(sealBenchmark({
    protocol: BENCHMARKING_PROTOCOL,
    name: "local venue miniature",
    description: "Two tasks graded on a local venue across a parent and a candidate loadout.",
    author: "urn:uuid:10000000-0000-5000-8000-000000000001",
    version: "1.0.0",
    items: [
      { task: { digest: { sha256: TASK_A } } },
      { task: { digest: { sha256: TASK_B } } },
    ],
    reveal: { policy: "immediate" },
  }).bytes);
}

function miniatureRun(bench: BenchmarkRecord): RunRecord {
  const sealedBench = sealBenchmark(bench);
  return parseRun(sealRun({
    protocol: BENCHMARKING_PROTOCOL,
    benchmark: { digest: { sha256: sealedBench.digest.slice("sha256:".length) } },
    owner: "urn:uuid:20000000-0000-5000-8000-000000000002",
    arms: [
      { armId: "parent", pinning: { model: MODEL_A, loadout: LOADOUT_A } },
      { armId: "candidate", pinning: { model: MODEL_B, loadout: LOADOUT_B } },
    ],
    replicates: 1,
    policy: {
      completenessFloor: "0.5",
      cellWindow: 3_600_000,
      replacement: { allowed: false },
      independence: "disclosed",
      evaluation: { minVerdicts: 1, distinctEvaluator: false },
      // Harness and isolation are pinned once for the whole Run, not per arm — the axes the
      // port call site never sees.
      submissionBaseline: { harness: HARNESS_PINNED, isolationPolicy: "unrestricted" },
    },
    venue: { kind: "self-run", note: "local backend" },
    closeAt: "2026-08-04T00:00:00Z",
  }).bytes);
}

const SWAPPED_CELL = `${TASK_B}/candidate/1`;

function cellKeys(): readonly string[] {
  return [
    `${TASK_A}/parent/1`,
    `${TASK_A}/candidate/1`,
    `${TASK_B}/parent/1`,
    SWAPPED_CELL,
  ];
}

function inScopeCells(): readonly InScopeCell[] {
  return cellKeys().map((cellKey, index) => {
    const [taskDigest, armId] = cellKey.split("/");
    return {
      cellKey,
      armId: armId!,
      replicate: 1,
      taskDigest: taskDigest!,
      dispatches: 1,
      accounted: 1,
      submissionDigest: `sha256:${String(index).repeat(64)}` as `sha256:${string}`,
      attempt: `urn:jinn:attempt:local:${index}`,
      deliveryDigest: `sha256:${String(index + 4).repeat(64)}` as `sha256:${string}`,
      evaluationSpecDigest: EVAL_SPEC_DIGEST,
      evaluationSpec: EVAL_SPEC,
      verdicts: [{
        digest: `sha256:${String(index + 5).repeat(64)}` as `sha256:${string}`,
        record: {
          evaluationSpecification: EVAL_SPEC_DIGEST,
          evaluator: EVALUATOR,
          verdict: "pass",
        },
        measurements: { passed: true },
        evaluationSpec: EVAL_SPEC,
      }],
    };
  });
}

/**
 * Honest cells: the admission gate accepted the pin and the recorded Runtime Observations
 * name exactly what the arm pinned. The swapped cell also passed its own admission gate —
 * a real swap is only discoverable from the observations, which is the point of the bridge.
 */
function pinningEvidence(): Record<string, LocalCellPinningEvidence> {
  const honest = (model: typeof MODEL_A, loadout: typeof LOADOUT_A) => ({
    dispatches: 1,
    admission: { ready: true },
    observations: axisObservationsFromRuntimeObservations([
      { kind: "resource", propertyId: runPinningPropertyId("harness"), value: JSON.stringify(HARNESS_PINNED) },
      { kind: "resource", propertyId: runPinningPropertyId("model"), value: JSON.stringify(model) },
      { kind: "resource", propertyId: runPinningPropertyId("loadout"), value: JSON.stringify(loadout) },
    ]),
  });
  return {
    [`${TASK_A}/parent/1`]: honest(MODEL_A, LOADOUT_A),
    [`${TASK_A}/candidate/1`]: honest(MODEL_B, LOADOUT_B),
    [`${TASK_B}/parent/1`]: honest(MODEL_A, LOADOUT_A),
    // The candidate arm on task B actually ran the parent's loadout and model, under an
    // older harness build.
    [SWAPPED_CELL]: {
      dispatches: 1,
      admission: { ready: true },
      observations: axisObservationsFromRuntimeObservations([
        { kind: "resource", propertyId: runPinningPropertyId("harness"), value: JSON.stringify(HARNESS_SWAPPED) },
        { kind: "resource", propertyId: runPinningPropertyId("model"), value: JSON.stringify(MODEL_A) },
        { kind: "resource", propertyId: runPinningPropertyId("loadout"), value: JSON.stringify(LOADOUT_A) },
      ]),
    },
  };
}

async function assembleMiniature(
  overrides: { isolationInventory?: readonly string[]; undispatched?: string } = {},
) {
  const bench = miniatureBenchmark();
  const run = miniatureRun(bench);
  const cells = inScopeCells().filter((cell) => cell.cellKey !== overrides.undispatched);
  const evidence = pinningEvidence();
  if (overrides.undispatched !== undefined) {
    // The Run expected the cell; nothing was ever dispatched for it.
    evidence[overrides.undispatched] = { dispatches: 0 };
  }
  const ports = localAssemblyPorts({
    inputScope: { cellsForRun: () => cells },
    pinning: {
      submissionBaseline: run.policy.submissionBaseline as Record<string, unknown>,
      evidenceFor: (cellKey) => evidence[cellKey],
      isolationInventory: overrides.isolationInventory ?? ["unrestricted"],
    },
    admission: {
      receiptFor: () => ({ zeroReplayVariance: true, externalCapabilities: false }),
    },
    cost: {
      costFor: () => ({ value: "0.25", unit: "USD" }),
      latencyFor: () => 4200,
    },
    trust: {
      async resolveAgent(evidenceRef) {
        const role = (evidenceRef as { role?: string }).role;
        return role === "evaluator" ? EVALUATOR : SOLVER;
      },
    },
  });
  const assembled = await assembleMatrix(bench, run, ports);
  const byCell = new Map<string, MatrixCell>(
    assembled.record.cells.map((cell) => [cell.cellKey, cell]),
  );
  return { assembled, byCell };
}

describe("miniature local Run (charter acceptance)", () => {
  test("honest cells report match on harness, model, and loadout", async () => {
    const { byCell } = await assembleMiniature();
    for (const cellKey of [`${TASK_A}/parent/1`, `${TASK_A}/candidate/1`, `${TASK_B}/parent/1`]) {
      const cell = byCell.get(cellKey);
      expect(cell, cellKey).toBeDefined();
      expect(cell!.verification.harness, cellKey).toBe("match");
      expect(cell!.verification.model, cellKey).toBe("match");
      expect(cell!.verification.loadout, cellKey).toBe("match");
      expect(cell!.verification.checksFailed, cellKey).toEqual([]);
    }
  });

  test("the deliberately-swapped cell reports mismatch on all three enforced axes", async () => {
    const { byCell } = await assembleMiniature();
    const swapped = byCell.get(SWAPPED_CELL)!;
    expect(swapped.verification.harness).toBe("mismatch");
    expect(swapped.verification.model).toBe("mismatch");
    expect(swapped.verification.loadout).toBe("mismatch");
  });

  test("a swapped cell is invalidated and named by the pinning-observation check", async () => {
    const { byCell } = await assembleMiniature();
    const swapped = byCell.get(SWAPPED_CELL)!;
    expect(swapped.verification.checksFailed).toContain("pinning-observation");
    // Outcome precedence: a pinning mismatch invalidates the cell even with a valid verdict.
    expect(swapped.outcome).toBe("invalidated");
    expect(byCell.get(`${TASK_A}/parent/1`)!.outcome).toBe("judged");
  });

  test("isolation reports its vacuous match on every cell, swapped included", async () => {
    const { byCell } = await assembleMiniature();
    for (const cellKey of cellKeys()) {
      expect(byCell.get(cellKey)!.verification.isolation, cellKey).toBe("match");
    }
  });

  test("an expected-but-never-dispatched cell reports isolation unverifiable", async () => {
    const undispatched = `${TASK_B}/parent/1`;
    const { byCell } = await assembleMiniature({ undispatched });
    const cell = byCell.get(undispatched)!;
    expect(cell.dispatches).toBe(0);
    // Nothing executed, so no axis — vacuous ones included — can be said to have been honored.
    expect(cell.verification).toEqual({
      harness: "unverifiable",
      model: "unverifiable",
      loadout: "unverifiable",
      isolation: "unverifiable",
      checksFailed: [],
    });
    // Its siblings are unaffected.
    expect(byCell.get(`${TASK_A}/parent/1`)!.verification.isolation).toBe("match");
  });

  test("isolation degrades to unverifiable when the venue admits more than one policy", async () => {
    // Honesty test: with a wider inventory, membership no longer proves which policy ran.
    const { byCell } = await assembleMiniature({
      isolationInventory: ["unrestricted", "sandboxed"],
    });
    for (const cellKey of cellKeys()) {
      expect(byCell.get(cellKey)!.verification.isolation, cellKey).toBe("unverifiable");
    }
    // The enforced axes are untouched by the isolation inventory.
    expect(byCell.get(`${TASK_A}/parent/1`)!.verification.loadout).toBe("match");
  });

  test("assembles a parseable, byte-stable Matrix over the full cartesian product", async () => {
    const first = await assembleMiniature();
    const second = await assembleMiniature();
    expect(first.assembled.record.cells).toHaveLength(4);
    expect(first.assembled.bytes).toEqual(second.assembled.bytes);
    expect(first.assembled.digest).toBe(second.assembled.digest);
  });

  test("carries the local venue's integrity tier, reported cost, and resolved identities", async () => {
    const { byCell } = await assembleMiniature();
    const cell = byCell.get(`${TASK_A}/parent/1`)!;
    expect(cell.integrityTier).toBe("re-derivable");
    expect(cell.cost).toEqual({ value: "0.25", unit: "USD", source: "reported" });
    expect(cell.latencyMs).toBe(4200);
    expect(cell.solver).toBe(SOLVER);
    expect(cell.evaluator).toBe(EVALUATOR);
  });

  test("closes on the Run's pre-registered closeAt with no anchor", async () => {
    const { assembled } = await assembleMiniature();
    expect(assembled.record.closeBoundary).toEqual({ at: "2026-08-04T00:00:00Z" });
  });
});
