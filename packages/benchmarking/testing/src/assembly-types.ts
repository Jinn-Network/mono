import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  ASSEMBLY_PROCEDURE,
  ASSEMBLY_PROCEDURE_VERSION,
  documentDigest,
  parseBenchmark,
  parseMatrix,
  parseRun,
  type BenchmarkRecord,
  type MatrixRecord,
  type RunRecord,
} from "@jinn-network/benchmarking-records";
import type { EvaluationSpec, MeasurementMap } from "@jinn-network/task-execution-profiles";
import { describe, expect, test } from "vitest";

/** Pinning-axis observation status (design §8.1) — mirrored in `benchmarking/run` ports. */
export type PinningAxisStatus = "match" | "mismatch" | "unverifiable";

export type IntegrityTier = "re-derivable" | "attested-only";

export interface InScopeVerdict {
  digest: `sha256:${string}`;
  record: {
    evaluationSpecification?: string;
    evaluator?: string;
    verdict?: string;
    [key: string]: unknown;
  };
  /** Required for fail-closed profiles checkVerdictConsistency. */
  measurements?: MeasurementMap;
  evaluationSpec?: EvaluationSpec;
}

export interface InScopeCell {
  cellKey: string;
  armId: string;
  replicate: number;
  taskDigest: string;
  dispatches: number;
  accounted?: number;
  submissionDigest?: `sha256:${string}`;
  attempt?: string;
  deliveryDigest?: `sha256:${string}`;
  verdicts: readonly InScopeVerdict[];
  exclusionHit?: boolean;
  exclusionReason?: string;
  evaluationTerminal?: "could-not-grade";
  evaluationSpecDigest?: string;
  /** Shared EvaluationSpec body for fail-closed verdict consistency. */
  evaluationSpec?: EvaluationSpec;
  integrityTier?: IntegrityTier;
}

export interface InputScope {
  submissionsForRun(runDigest: string): AsyncIterable<InScopeCell>;
  runCancelled?: boolean;
}

export interface TrustResolver {
  resolveAgent(evidence: unknown, at: Date): Promise<string | "unresolved">;
}

export interface CloseBoundaryResolver {
  resolve(run: RunRecord): Promise<{ at: string; anchor?: { chain: string; blockNumber: number; blockHash: string } }>;
}

export interface PinningObservationPort {
  observe(delivery: unknown, arm: unknown): Promise<{
    harness: PinningAxisStatus;
    model: PinningAxisStatus;
    loadout: PinningAxisStatus;
    isolation: PinningAxisStatus;
  }>;
}

export interface AdmissionEvidencePort {
  tierFor(taskDigest: string, evaluationSpecDigest: string): Promise<IntegrityTier>;
}

export interface CostSource {
  costFor(cell: InScopeCell): Promise<{ value: string; unit: string; source: "reported" | "settled" } | undefined>;
  latencyFor(cell: InScopeCell): Promise<number | undefined>;
}

/** Kit-owned assembly ports (design §8.3) — `benchmarking/run` implements a structurally identical bag. */
export interface AssemblyPorts {
  inputScope: InputScope;
  trust: TrustResolver;
  closeBoundary: CloseBoundaryResolver;
  pinning: PinningObservationPort;
  admission: AdmissionEvidencePort;
  cost: CostSource;
}

export type AssemblyProcedure = {
  procedure: string;
  version: string;
};

/**
 * The injected shape `benchmarking/run`'s `assembleMatrix` implements (design §8.3, program
 * §7.22: reads cell `attempt` fields from in-scope Submission/observation records, never
 * regenerates them).
 */
export type AssembleMatrixFn = (
  bench: BenchmarkRecord,
  run: RunRecord,
  ports: AssemblyPorts,
  procedure: AssemblyProcedure,
) => Promise<{ record: MatrixRecord; bytes: Uint8Array; digest: `sha256:${string}` }>;

type PortOutput = {
  integrityTier: IntegrityTier;
  verification: { harness: PinningAxisStatus; model: PinningAxisStatus; loadout: PinningAxisStatus; isolation: PinningAxisStatus };
  solver?: string;
  evaluator?: string;
  cost?: { value: string; unit: string; source: "reported" | "settled" };
  latencyMs?: number;
  evaluationTerminal?: "could-not-grade";
};

type MiniatureScope = {
  submissions: { cellKey: string; digest: string; dispatch: number; record: Record<string, unknown> }[];
  deliveries: { cellKey: string; digest: string; record: { attempt?: string } }[];
  verdicts: {
    cellKey: string;
    digest: string;
    evaluationSpecification?: string;
    evaluator?: string;
    verdict?: string;
    measurements?: MeasurementMap;
  }[];
  evidence: { cellKey: string }[];
  replacementLineage: { cellKey: string; dispatches: number; reason: string }[];
  exclusions: { cellKey: string; reason: string }[];
  portOutputs: Record<string, PortOutput>;
  evaluationSpec?: EvaluationSpec;
  evaluationSpecDigest?: string;
};

async function loadMiniatureBytes(name: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(
    fileURLToPath(new URL(`../fixtures/miniature-run/${name}`, import.meta.url)),
  ));
}

/** Build real injected port stubs from the kit-owned miniature-run fixtures (no adapter closure). */
export async function buildMiniatureAssemblyPorts(): Promise<{
  bench: BenchmarkRecord;
  run: RunRecord;
  ports: AssemblyPorts;
  procedure: AssemblyProcedure;
  expectedBytes: Uint8Array;
}> {
  const [benchmarkBytes, runBytes, scopeBytes, expectedBytes, tasksBytes] = await Promise.all([
    loadMiniatureBytes("benchmark.json"),
    loadMiniatureBytes("run.json"),
    loadMiniatureBytes("injected-scope.json"),
    loadMiniatureBytes("expected-matrix.json"),
    loadMiniatureBytes("tasks.json"),
  ]);
  const bench = parseBenchmark(benchmarkBytes);
  const run = parseRun(runBytes);
  const scope = JSON.parse(new TextDecoder().decode(scopeBytes)) as MiniatureScope;
  const tasks = JSON.parse(new TextDecoder().decode(tasksBytes)) as {
    digest: string;
    record: { evaluation?: { digest?: { sha256?: string } } };
  }[];
  const evaluationByTask = new Map(
    tasks.map((task) => {
      const hex = task.digest.replace(/^sha256:/, "");
      const evalHex = task.record.evaluation?.digest?.sha256;
      return [hex, evalHex === undefined ? undefined : `sha256:${evalHex}`] as const;
    }),
  );
  const exclusionByCell = new Map(scope.exclusions.map((entry) => [entry.cellKey, entry.reason]));
  const deliveriesByCell = new Map(scope.deliveries.map((entry) => [entry.cellKey, entry]));
  const submissionsByCell = new Map<string, typeof scope.submissions>();
  for (const submission of scope.submissions) {
    const list = submissionsByCell.get(submission.cellKey) ?? [];
    list.push(submission);
    submissionsByCell.set(submission.cellKey, list);
  }
  const verdictsByCell = new Map<string, typeof scope.verdicts>();
  for (const verdict of scope.verdicts) {
    const list = verdictsByCell.get(verdict.cellKey) ?? [];
    list.push(verdict);
    verdictsByCell.set(verdict.cellKey, list);
  }
  const lineageByCell = new Map(scope.replacementLineage.map((entry) => [entry.cellKey, entry]));

  const ports: AssemblyPorts = {
    inputScope: {
      async *submissionsForRun() {
        const keys = new Set<string>([
          ...submissionsByCell.keys(),
          ...deliveriesByCell.keys(),
          ...exclusionByCell.keys(),
          ...Object.keys(scope.portOutputs),
        ]);
        for (const cellKey of [...keys].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))) {
          const [taskDigest, armId, replicateText] = cellKey.split("/");
          const submissions = (submissionsByCell.get(cellKey) ?? []).sort((a, b) => a.dispatch - b.dispatch);
          const delivery = deliveriesByCell.get(cellKey);
          const lineage = lineageByCell.get(cellKey);
          const portOut = scope.portOutputs[cellKey];
          const dispatches = lineage?.dispatches
            ?? (submissions.length === 0 ? 0 : Math.max(...submissions.map((entry) => entry.dispatch)));
          yield {
            cellKey,
            armId: armId!,
            replicate: Number(replicateText),
            taskDigest: taskDigest!,
            dispatches,
            ...(dispatches > 0 ? { accounted: dispatches } : {}),
            ...(submissions.length > 0
              ? { submissionDigest: submissions[submissions.length - 1]!.digest as `sha256:${string}` }
              : {}),
            ...(delivery?.record.attempt !== undefined ? { attempt: delivery.record.attempt } : {}),
            ...(delivery !== undefined ? { deliveryDigest: delivery.digest as `sha256:${string}` } : {}),
            verdicts: (verdictsByCell.get(cellKey) ?? []).map((verdict) => ({
              digest: verdict.digest as `sha256:${string}`,
              record: {
                ...(verdict.evaluationSpecification === undefined
                  ? {}
                  : { evaluationSpecification: verdict.evaluationSpecification }),
                ...(verdict.evaluator === undefined ? {} : { evaluator: verdict.evaluator }),
                ...(verdict.verdict === undefined ? {} : { verdict: verdict.verdict }),
              },
              ...(verdict.measurements === undefined ? {} : { measurements: verdict.measurements }),
              ...(scope.evaluationSpec === undefined ? {} : { evaluationSpec: scope.evaluationSpec }),
            })),
            ...(exclusionByCell.has(cellKey)
              ? { exclusionHit: true as const, exclusionReason: exclusionByCell.get(cellKey) }
              : {}),
            ...(evaluationByTask.get(taskDigest!) === undefined
              ? {}
              : { evaluationSpecDigest: evaluationByTask.get(taskDigest!) }),
            ...(scope.evaluationSpec === undefined ? {} : { evaluationSpec: scope.evaluationSpec }),
            ...(portOut?.evaluationTerminal === undefined
              ? {}
              : { evaluationTerminal: portOut.evaluationTerminal }),
            ...(portOut?.integrityTier === undefined
              ? {}
              : { integrityTier: portOut.integrityTier }),
          };
        }
      },
    },
        trust: {
      async resolveAgent(evidence) {
        if (evidence && typeof evidence === "object" && "cellKey" in evidence) {
          const cellKey = String((evidence as { cellKey: string }).cellKey);
          const role = "role" in evidence ? String((evidence as { role: string }).role) : "solver";
          const output = scope.portOutputs[cellKey];
          if (role === "evaluator") {
            // Prefer the per-verdict claim so multi-verdict cells keep distinct identities.
            if ("claim" in evidence && typeof (evidence as { claim?: unknown }).claim === "string") {
              return (evidence as { claim: string }).claim;
            }
            if (output?.evaluator !== undefined) return output.evaluator;
            return "unresolved";
          }
          if (output?.solver !== undefined) return output.solver;
        }
        return "unresolved";
      },
    },
    closeBoundary: {
      async resolve(record) {
        return { at: record.closeAt };
      },
    },
    pinning: {
      async observe(_delivery, arm) {
        const cellKey = typeof arm === "object" && arm && "cellKey" in arm
          ? String((arm as { cellKey: string }).cellKey)
          : "";
        return scope.portOutputs[cellKey]?.verification ?? {
          harness: "match",
          model: "match",
          loadout: "match",
          isolation: "match",
        };
      },
    },
    admission: {
      async tierFor(taskDigest) {
        for (const [cellKey, output] of Object.entries(scope.portOutputs)) {
          if (cellKey.startsWith(`${taskDigest}/`)) return output.integrityTier;
        }
        return "attested-only";
      },
    },
    cost: {
      async costFor(cell) {
        return scope.portOutputs[cell.cellKey]?.cost;
      },
      async latencyFor(cell) {
        return scope.portOutputs[cell.cellKey]?.latencyMs;
      },
    },
  };

  return {
    bench,
    run,
    ports,
    procedure: { procedure: ASSEMBLY_PROCEDURE, version: ASSEMBLY_PROCEDURE_VERSION },
    expectedBytes,
  };
}

/**
 * §16 assembly conformance: the M4 implementation is injected; the corpus and exact Matrix
 * oracle remain kit-owned. Ports are built from fixtures — not closed over inside an adapter.
 */
export function describeAssemblyConformance(assemble: AssembleMatrixFn): void {
  describe("benchmarking assembly conformance (design §8.3/§16)", () => {
    test("reproduces the kit-owned miniature Matrix byte-for-byte via injected ports", async () => {
      const { bench, run, ports, procedure, expectedBytes } = await buildMiniatureAssemblyPorts();
      const result = await assemble(bench, run, ports, procedure);
      expect(result.bytes).toEqual(expectedBytes);
      expect(result.digest).toBe(documentDigest(expectedBytes));
      expect(result.record).toEqual(parseMatrix(expectedBytes));
    });
  });
}
