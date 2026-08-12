import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { checkJudgeability } from "@jinn-network/benchmarking-records";
import { describe, expect, test } from "vitest";
import { importSweBench, type SweBenchRow } from "./swebench.js";

async function loadFixture(name: string): Promise<string> {
  return readFile(
    fileURLToPath(new URL(`../../fixtures/swebench/${name}`, import.meta.url)),
    "utf8",
  );
}

describe("importSweBench (§10.1 op 1)", () => {
  test("maps a golden SWE-bench row to a stable Task digest + judgeable Benchmark", async () => {
    const row = JSON.parse(await loadFixture("row.json")) as SweBenchRow;
    const expected = JSON.parse(await loadFixture("expected.v2.json")) as {
      taskDigest: `sha256:${string}`;
      evaluationSpecDigest: `sha256:${string}`;
    };
    const opts = {
      name: "swe-bench probe",
      description: "interop SWE-bench importer fixture",
      version: "1.0.0",
      author: "urn:uuid:10000000-0000-5000-8000-000000000001",
      provenanceTimestamp: "2026-07-29T00:00:00Z",
    } as const;
    const imported = importSweBench([row], opts);
    expect(imported.tasks).toHaveLength(1);
    expect(imported.tasks[0]!.digest).toBe(expected.taskDigest);
    expect(imported.benchmark.record.items).toHaveLength(1);
    expect(imported.benchmark.record.items[0]!.task.digest?.sha256)
      .toBe(expected.taskDigest.slice("sha256:".length));
    const again = importSweBench([row], opts);
    expect(again.tasks[0]!.digest).toBe(imported.tasks[0]!.digest);
    expect(again.benchmark.digest).toBe(imported.benchmark.digest);
    expect(checkJudgeability(
      imported.benchmark.record,
      (digest) => imported.tasks.find((task) => task.digest.slice("sha256:".length) === digest)?.bytes,
    )).toEqual({ ok: true });
    // EvaluationSpec digest remains the profiles-mapper golden (provenance enrichment is Task-only).
    const { sweRebenchRowToTaskAndSpec } = await import("@jinn-network/task-execution-profiles");
    expect(sweRebenchRowToTaskAndSpec(row).evaluationSpecDigest).toBe(expected.evaluationSpecDigest);
  });
});
