import {
  BENCHMARKING_PROTOCOL,
  parseBenchmark,
  parseRun,
  sealBenchmark,
  sealRun,
  type BenchmarkRecord,
  type RunRecord,
} from "@jinn-network/benchmarking-records";
import type { EvaluationSpec } from "@jinn-network/task-execution-profiles";
import { describe, expect, test } from "vitest";
import { assembleMatrix, deriveOutcome, deriveParticipantExclusion } from "./assemble.js";
import type { AssemblyPorts, InScopeCell } from "./ports.js";

const TASK_DIGEST = "d42df69433efba6b5fc689bd07c7c4923e02c9a9dda45455ae58f14c09d77e91";
const EVAL_SPEC = `sha256:${"e".repeat(64)}` as const;
const VERDICT_DIGEST = `sha256:${"a".repeat(64)}` as const;

const MINIMAL_SPEC = {
  protocol: "https://jinn.network/profiles/evaluation-spec/1.0",
  family: "deterministic-process",
  semanticsVersion: "4",
  measurements: [{ name: "passed", type: "boolean", required: true }],
  verdictRule: { threshold: { measurement: "passed", op: "eq", value: true } },
  unscorable: [],
  evidenceConventions: { requiredRefs: [] },
  familyBlock: {
    image: { uri: "https://example.org/img", digest: { sha256: "a".repeat(64) } },
    platform: "linux/amd64",
    timeout: 60,
    workspace: {},
    transitions: { failToPass: [], passToPass: [] },
    testMaterial: [],
    parser: { id: "jinn.parser.x", version: "1.0.0", digest: `sha256:${"b".repeat(64)}` },
  },
  grader: {
    name: "jinn.parser.x",
    digest: { sha256: "b".repeat(64) },
    accessClass: "public",
  },
} as EvaluationSpec;

function singleItemBench(): BenchmarkRecord {
  return parseBenchmark(sealBenchmark({
    protocol: BENCHMARKING_PROTOCOL,
    name: "independence probe",
    description: "single-cell independence fixture",
    author: "urn:uuid:10000000-0000-5000-8000-000000000001",
    version: "1.0.0",
    items: [{ task: { digest: { sha256: TASK_DIGEST } } }],
    reveal: { policy: "immediate" },
  }).bytes);
}

function singleArmRun(bench: BenchmarkRecord, independence: "gating" | "disclosed"): RunRecord {
  const sealedBench = sealBenchmark(bench);
  return parseRun(sealRun({
    protocol: BENCHMARKING_PROTOCOL,
    benchmark: { digest: { sha256: sealedBench.digest.slice("sha256:".length) } },
    owner: "urn:uuid:20000000-0000-5000-8000-000000000002",
    arms: [{
      armId: "armA",
      pinning: { model: { id: "model-a" }, harness: { id: "kit", version: "1" } },
    }],
    replicates: 1,
    policy: {
      completenessFloor: "1",
      cellWindow: 3_600_000,
      replacement: { allowed: false },
      independence,
      evaluation: { minVerdicts: 1, distinctEvaluator: true },
      submissionBaseline: { isolationPolicy: "fixture" },
    },
    venue: { kind: "self-run", note: "independence probe" },
    closeAt: "2026-08-04T00:00:00Z",
  }).bytes);
}

function consistentVerdict(overrides: {
  digest?: `sha256:${string}`;
  evaluator?: string;
  verdict?: "pass" | "fail";
  measurements?: { passed: boolean };
  evaluationSpecification?: string;
} = {}) {
  const verdict = overrides.verdict ?? "pass";
  const measurements = overrides.measurements ?? { passed: verdict === "pass" };
  return {
    digest: overrides.digest ?? VERDICT_DIGEST,
    record: {
      evaluationSpecification: overrides.evaluationSpecification ?? EVAL_SPEC,
      evaluator: overrides.evaluator ?? "agent://evaluator",
      verdict,
    },
    evaluationSpec: MINIMAL_SPEC,
    measurements,
    delivered: { verdict },
  };
}

function cellBase(overrides: Partial<InScopeCell> = {}): InScopeCell {
  return {
    cellKey: `${TASK_DIGEST}/armA/1`,
    armId: "armA",
    replicate: 1,
    taskDigest: TASK_DIGEST,
    dispatches: 1,
    accounted: 1,
    submissionDigest: `sha256:${"b".repeat(64)}` as const,
    attempt: "urn:uuid:attempt-1",
    deliveryDigest: `sha256:${"c".repeat(64)}` as const,
    verdicts: [],
    evaluationSpecDigest: EVAL_SPEC,
    evaluationSpec: MINIMAL_SPEC,
    integrityTier: "attested-only",
    ...overrides,
  };
}

function portsFor(
  cell: InScopeCell,
  opts: {
    solver?: string | "unresolved";
    evaluator?: string | "unresolved";
    cancelled?: boolean;
    pinning?: { harness: "match" | "mismatch"; model: "match" | "mismatch"; loadout: "match" | "mismatch"; isolation: "match" | "mismatch" };
  } = {},
): AssemblyPorts {
  const solver = opts.solver ?? "agent://solver";
  const evaluator = opts.evaluator ?? "agent://evaluator";
  return {
    inputScope: {
      runCancelled: opts.cancelled,
      async *submissionsForRun() {
        yield cell;
      },
    },
    trust: {
      async resolveAgent(evidence) {
        if (evidence && typeof evidence === "object" && "role" in evidence) {
          const role = String((evidence as { role: string }).role);
          if (role === "evaluator") {
            if (evaluator === "unresolved") return "unresolved";
            return evaluator;
          }
          if (role === "solver") return solver;
        }
        return "unresolved";
      },
    },
    closeBoundary: {
      async resolve(run) {
        return { at: run.closeAt };
      },
    },
    pinning: {
      async observe() {
        return opts.pinning ?? {
          harness: "match",
          model: "match",
          loadout: "match",
          isolation: "match",
        };
      },
    },
    admission: {
      async tierFor() {
        return "attested-only";
      },
    },
    cost: {
      async costFor() {
        return undefined;
      },
      async latencyFor() {
        return undefined;
      },
    },
  };
}

describe("evaluator-independence named check (§8.2 / §12.1)", () => {
  test("gating independence failure suppresses judged (trust-resolved IRIs)", async () => {
    const bench = singleItemBench();
    const run = singleArmRun(bench, "gating");
    const cell = cellBase({ verdicts: [consistentVerdict()] });
    const result = await assembleMatrix(
      bench,
      run,
      portsFor(cell, { solver: "agent://same", evaluator: "agent://same" }),
    );
    expect(result.record.cells[0]!.outcome).toBe("unjudged");
    expect(result.record.cells[0]!.validVerdicts).toEqual([]);
    expect(result.record.cells[0]!.evaluator).toBe("agent://same");
    expect(result.record.cells[0]!.verification.checksFailed).not.toContain("evaluator-independence");
  });

  test("disclosed independence failure keeps judged and records checksFailed", async () => {
    const bench = singleItemBench();
    const run = singleArmRun(bench, "disclosed");
    const cell = cellBase({ verdicts: [consistentVerdict()] });
    const result = await assembleMatrix(
      bench,
      run,
      portsFor(cell, { solver: "agent://same", evaluator: "agent://same" }),
    );
    expect(result.record.cells[0]!.outcome).toBe("judged");
    expect(result.record.cells[0]!.validVerdicts).toEqual([VERDICT_DIGEST]);
    expect(result.record.cells[0]!.verification.checksFailed).toContain("evaluator-independence");
    expect(result.record.cells[0]!.evaluator).toBe("agent://same");
  });

  test("IMPORTANT E: fail-closed unresolved evaluator is persisted on the cell", async () => {
    const bench = singleItemBench();
    const run = singleArmRun(bench, "gating");
    const cell = cellBase({ verdicts: [consistentVerdict()] });
    const result = await assembleMatrix(
      bench,
      run,
      portsFor(cell, { evaluator: "unresolved" }),
    );
    expect(result.record.cells[0]!.evaluator).toBe("unresolved");
    expect(result.record.cells[0]!.outcome).toBe("unjudged");
  });

  test("IMPORTANT E: delivery without verdicts persists evaluator unresolved beside solver", async () => {
    const bench = singleItemBench();
    const run = singleArmRun(bench, "gating");
    const cell = cellBase({ verdicts: [] });
    const result = await assembleMatrix(bench, run, portsFor(cell));
    expect(result.record.cells[0]!.solver).toBe("agent://solver");
    expect(result.record.cells[0]!.evaluator).toBe("unresolved");
  });

  test("IMPORTANT E: cross-cell trust-resolved evaluators stay distinct", async () => {
    const bench = singleItemBench();
    const sealedBench = sealBenchmark(bench);
    const run = parseRun(sealRun({
      protocol: BENCHMARKING_PROTOCOL,
      benchmark: { digest: { sha256: sealedBench.digest.slice("sha256:".length) } },
      owner: "urn:uuid:20000000-0000-5000-8000-000000000002",
      arms: [{
        armId: "armA",
        pinning: { model: { id: "model-a" }, harness: { id: "kit", version: "1" } },
      }],
      replicates: 2,
      policy: {
        completenessFloor: "1",
        cellWindow: 3_600_000,
        replacement: { allowed: false },
        independence: "gating",
        evaluation: { minVerdicts: 1, distinctEvaluator: true },
        submissionBaseline: { isolationPolicy: "fixture" },
      },
      venue: { kind: "self-run", note: "cross-cell evaluator probe" },
      closeAt: "2026-08-04T00:00:00Z",
    }).bytes);
    const cell1 = cellBase({
      cellKey: `${TASK_DIGEST}/armA/1`,
      replicate: 1,
      verdicts: [consistentVerdict({
        digest: `sha256:${"1".repeat(64)}`,
        evaluator: "agent://eval-one",
      })],
    });
    const cell2 = cellBase({
      cellKey: `${TASK_DIGEST}/armA/2`,
      replicate: 2,
      verdicts: [consistentVerdict({
        digest: `sha256:${"2".repeat(64)}`,
        evaluator: "agent://eval-two",
      })],
    });
    const ports: AssemblyPorts = {
      ...portsFor(cell1),
      inputScope: {
        async *submissionsForRun() {
          yield cell1;
          yield cell2;
        },
      },
      trust: {
        async resolveAgent(evidence) {
          if (evidence && typeof evidence === "object" && "role" in evidence) {
            const role = String((evidence as { role: string }).role);
            if (role === "evaluator" && "claim" in evidence
              && typeof (evidence as { claim?: unknown }).claim === "string") {
              return (evidence as { claim: string }).claim;
            }
            if (role === "solver") return "agent://solver";
          }
          return "unresolved";
        },
      },
    };
    const result = await assembleMatrix(bench, run, ports);
    const byKey = new Map(result.record.cells.map((cell) => [cell.cellKey, cell]));
    expect(byKey.get(cell1.cellKey)!.evaluator).toBe("agent://eval-one");
    expect(byKey.get(cell2.cellKey)!.evaluator).toBe("agent://eval-two");
    expect(byKey.get(cell1.cellKey)!.outcome).toBe("judged");
    expect(byKey.get(cell2.cellKey)!.outcome).toBe("judged");
  });
});

describe("six-outcome derivation + precedence", () => {
  test("never-dispatched is expired with dispatches: 0", async () => {
    const bench = singleItemBench();
    const run = singleArmRun(bench, "gating");
    const cell = cellBase({
      dispatches: 0,
      accounted: undefined,
      submissionDigest: undefined,
      attempt: undefined,
      deliveryDigest: undefined,
      verdicts: [],
    });
    delete (cell as { accounted?: number }).accounted;
    const result = await assembleMatrix(bench, run, portsFor(cell));
    expect(result.record.cells[0]!.dispatches).toBe(0);
    expect(result.record.cells[0]!.outcome).toBe("expired");
    expect(result.record.cells[0]!.accounted).toBeUndefined();
    expect(result.record.cells[0]!.evaluator).toBeUndefined();
  });

  test("precedence: exclusion beats pinning mismatch and valid verdicts", () => {
    expect(deriveOutcome({
      cell: cellBase({ evaluationTerminal: "could-not-grade" }),
      pinningFailed: true,
      validVerdicts: [VERDICT_DIGEST],
      exclusionHit: true,
    })).toBe("excluded");
  });

  test("precedence: pinning mismatch beats valid verdicts", () => {
    expect(deriveOutcome({
      cell: cellBase(),
      pinningFailed: true,
      validVerdicts: [VERDICT_DIGEST],
    })).toBe("invalidated");
  });

  test("precedence: judged beats unscorable and unjudged", () => {
    expect(deriveOutcome({
      cell: cellBase({ evaluationTerminal: "could-not-grade" }),
      pinningFailed: false,
      validVerdicts: [VERDICT_DIGEST],
    })).toBe("judged");
  });

  test("assembly records cancelled runOutcome while accounting every expected cell", async () => {
    const bench = singleItemBench();
    const run = singleArmRun(bench, "gating");
    const cell = cellBase({ verdicts: [consistentVerdict()] });
    const result = await assembleMatrix(
      bench,
      run,
      portsFor(cell, { cancelled: true }),
    );
    expect(result.record.completeness.runOutcome).toBe("cancelled");
    expect(result.record.cells).toHaveLength(1);
    expect(result.record.completeness.expected).toBe(1);
  });
});

describe("verdict-spec-match + fail-closed consistency", () => {
  test("spec digest mismatch drops the verdict", async () => {
    const bench = singleItemBench();
    const run = singleArmRun(bench, "gating");
    const cell = cellBase({
      verdicts: [consistentVerdict({
        evaluationSpecification: `sha256:${"f".repeat(64)}`,
      })],
    });
    const result = await assembleMatrix(bench, run, portsFor(cell));
    expect(result.record.cells[0]!.validVerdicts).toEqual([]);
    expect(result.record.cells[0]!.verification.checksFailed).toContain("verdict-spec-match");
    expect(result.record.cells[0]!.outcome).toBe("unjudged");
  });

  test("CRITICAL B: missing EvaluationSpec/measurements fails closed (never judged)", async () => {
    const bench = singleItemBench();
    const run = singleArmRun(bench, "gating");
    const cell = cellBase({
      evaluationSpec: undefined,
      verdicts: [{
        digest: VERDICT_DIGEST,
        record: { evaluationSpecification: EVAL_SPEC, verdict: "pass" },
        // no measurements / evaluationSpec
      }],
    });
    const result = await assembleMatrix(bench, run, portsFor(cell));
    expect(result.record.cells[0]!.validVerdicts).toEqual([]);
    expect(result.record.cells[0]!.verification.checksFailed).toContain("verdict-consistency");
    expect(result.record.cells[0]!.outcome).not.toBe("judged");
  });

  test("CRITICAL B: consistency hostile delivered pass with failing measurements", async () => {
    const bench = singleItemBench();
    const run = singleArmRun(bench, "gating");
    const cell = cellBase({
      verdicts: [consistentVerdict({
        verdict: "pass",
        measurements: { passed: false },
      })],
    });
    const result = await assembleMatrix(bench, run, portsFor(cell));
    expect(result.record.cells[0]!.validVerdicts).toEqual([]);
    expect(result.record.cells[0]!.verification.checksFailed).toContain("verdict-consistency");
  });

  test("consistent pass becomes judged", async () => {
    const bench = singleItemBench();
    const run = singleArmRun(bench, "gating");
    const cell = cellBase({ verdicts: [consistentVerdict()] });
    const result = await assembleMatrix(bench, run, portsFor(cell));
    expect(result.record.cells[0]!.outcome).toBe("judged");
    expect(result.record.cells[0]!.evaluator).toBe("agent://evaluator");
  });
});

describe("participant exclusion policy (program §7.4)", () => {
  test("deriveParticipantExclusion hits policy.participantExclusions", () => {
    const bench = singleItemBench();
    const run = parseRun(sealRun({
      protocol: BENCHMARKING_PROTOCOL,
      benchmark: { digest: { sha256: sealBenchmark(bench).digest.slice("sha256:".length) } },
      owner: "urn:uuid:20000000-0000-5000-8000-000000000002",
      arms: [{
        armId: "armA",
        pinning: { model: { id: "model-a" }, harness: { id: "kit", version: "1" } },
      }],
      replicates: 1,
      policy: {
        completenessFloor: "1",
        cellWindow: 3_600_000,
        replacement: { allowed: false },
        independence: "gating",
        evaluation: { minVerdicts: 1, distinctEvaluator: true },
        submissionBaseline: { isolationPolicy: "fixture" },
        participantExclusions: ["agent://blocked"],
      },
      venue: { kind: "self-run", note: "exclusion probe" },
      closeAt: "2026-08-04T00:00:00Z",
    }).bytes);
    expect(deriveParticipantExclusion({
      run,
      arm: run.arms[0]!,
      solver: "agent://blocked",
    })).toEqual({ hit: true, reason: "policy.participantExclusions" });
  });

  test("host join exclusionHit cannot force excluded outcome", async () => {
    const bench = singleItemBench();
    const run = singleArmRun(bench, "gating");
    const cell = cellBase({
      exclusionHit: true,
      exclusionReason: "host-invented",
      verdicts: [consistentVerdict()],
    });
    const result = await assembleMatrix(bench, run, portsFor(cell));
    expect(result.record.cells[0]!.outcome).toBe("judged");
    expect(result.record.exclusions).toEqual([]);
  });

  test("integrityTier laundering via join is ignored", async () => {
    const bench = singleItemBench();
    const run = singleArmRun(bench, "gating");
    const cell = cellBase({
      integrityTier: "re-derivable",
      verdicts: [consistentVerdict()],
    });
    const ports = portsFor(cell);
    ports.admission = {
      async tierFor() {
        return "attested-only";
      },
    };
    const result = await assembleMatrix(bench, run, ports);
    expect(result.record.cells[0]!.integrityTier).toBe("attested-only");
  });
});
