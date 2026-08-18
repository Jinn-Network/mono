import {
  loadPredictionSnapshotFixture,
  verifyPredictionSnapshotFixture,
} from "@jinn-network/task-admission";
import { defineBenchmark } from "@jinn-network/benchmarking-interop";
import { sealTask } from "@jinn-network/task-execution-protocol";
import { sha256Hex } from "../workspace/sealed-store.js";
import { sealSamplePredictionAdmissionReceipt } from "./sample.js";

export async function buildDeepSweV11Tasks(taskNames: readonly string[]): Promise<{
  readonly evaluationSpec: { readonly bytes: Uint8Array; readonly sha256: string };
  readonly tasks: readonly {
    readonly taskName: string;
    readonly bytes: Uint8Array;
    readonly sha256: string;
    readonly receipt: { readonly envelopeBytes: Uint8Array; readonly sha256: string };
  }[];
  readonly benchmark: { readonly bytes: Uint8Array; readonly sha256: string };
}> {
  await verifyPredictionSnapshotFixture();
  const fixture = await loadPredictionSnapshotFixture();
  const goldenTask = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(fixture.task)) as Record<string, unknown>;
  const tasks = [];
  for (const taskName of taskNames) {
    const candidateTask = structuredClone(goldenTask);
    candidateTask.payload = {
      forecast: {
        marketId: `deep-swe-v1.1/${taskName}`,
        question: `DeepSWE v1.1 task ${taskName}`,
        consensusProbabilityYes: "0.500000",
        observedAt: "2026-01-01T00:00:00Z",
        resolvesAt: "2026-01-08T00:00:00Z",
      },
    };
    const bytes = sealTask(candidateTask);
    const receipt = await sealSamplePredictionAdmissionReceipt(bytes, fixture.evaluationSpec);
    tasks.push({ taskName, bytes, sha256: sha256Hex(bytes), receipt });
  }
  const benchmark = defineBenchmark(
    tasks.map((task) => ({ bytes: task.bytes, digest: `sha256:${task.sha256}` as const })),
    {
      name: "deep-swe-v1.1",
      description: "DeepSWE v1.1 selected tasks as Colophon Benchmark items.",
      version: "1.0.0",
    },
  );
  return {
    evaluationSpec: { bytes: fixture.evaluationSpec, sha256: sha256Hex(fixture.evaluationSpec) },
    tasks,
    benchmark: { bytes: benchmark.bytes, sha256: sha256Hex(benchmark.bytes) },
  };
}
