import {
  loadPredictionSnapshotFixture,
  verifyPredictionSnapshotFixture,
} from "@jinn-network/task-admission";
import { defineBenchmark } from "@jinn-network/benchmarking-interop";
import { sealTask } from "@jinn-network/task-execution-protocol";
import { sha256Hex } from "../workspace/sealed-store.js";
import { sealSamplePredictionAdmissionReceipt } from "./sample.js";

export async function buildApexSweDevTasks(taskIds: readonly string[]): Promise<{
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
  for (const taskId of taskIds) {
    const candidateTask = structuredClone(goldenTask);
    candidateTask.payload = {
      forecast: {
        marketId: `apex-swe-dev/${taskId}`,
        question: `APEX-SWE-dev task ${taskId}`,
        consensusProbabilityYes: "0.500000",
        observedAt: "2026-01-01T00:00:00Z",
        resolvesAt: "2026-01-08T00:00:00Z",
      },
    };
    const bytes = sealTask(candidateTask);
    const receipt = await sealSamplePredictionAdmissionReceipt(bytes, fixture.evaluationSpec);
    tasks.push({ taskName: taskId, bytes, sha256: sha256Hex(bytes), receipt });
  }
  const benchmark = defineBenchmark(
    tasks.map((task) => ({ bytes: task.bytes, digest: `sha256:${task.sha256}` as const })),
    {
      name: "apex-swe-dev",
      description: "APEX-SWE-dev selected tasks as Colophon Benchmark items.",
      version: "1.0.0",
    },
  );
  return {
    evaluationSpec: { bytes: fixture.evaluationSpec, sha256: sha256Hex(fixture.evaluationSpec) },
    tasks,
    benchmark: { bytes: benchmark.bytes, sha256: sha256Hex(benchmark.bytes) },
  };
}
