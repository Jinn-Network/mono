import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { buildSampleBenchmark } from "../intake/sample.js";
import { putSealedBytes } from "../workspace/sealed-store.js";
import { scanPredictionSnapshotAdmissionReceipts } from "./admission-receipts.js";

let workspaceDir: string;

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "bp12-admission-receipts-"));
});

afterEach(() => {
  rmSync(workspaceDir, { recursive: true, force: true });
});

describe("scanPredictionSnapshotAdmissionReceipts", () => {
  test("an empty (or absent) records directory yields an empty map, no crash", () => {
    expect(scanPredictionSnapshotAdmissionReceipts(workspaceDir).size).toBe(0);
  });

  test("finds every bundled sample task's real receipt, keyed by the admitted task's own digest", async () => {
    const sample = await buildSampleBenchmark();
    for (const task of sample.tasks) {
      putSealedBytes(workspaceDir, task.bytes);
      putSealedBytes(workspaceDir, task.receipt.envelopeBytes);
    }
    putSealedBytes(workspaceDir, sample.evaluationSpec.bytes);
    putSealedBytes(workspaceDir, sample.benchmark.bytes);

    const receipts = scanPredictionSnapshotAdmissionReceipts(workspaceDir);
    expect(receipts.size).toBe(sample.tasks.length);
    for (const task of sample.tasks) {
      expect(receipts.get(task.sha256), task.marketId).toEqual({ zeroReplayVariance: true, externalCapabilities: false });
    }
  });

  test("a task with no minted receipt has no entry (conservative default applies upstream)", async () => {
    const sample = await buildSampleBenchmark();
    // Store only the first task's receipt — the others remain unadmitted from this scan's view.
    putSealedBytes(workspaceDir, sample.tasks[0]!.receipt.envelopeBytes);

    const receipts = scanPredictionSnapshotAdmissionReceipts(workspaceDir);
    expect(receipts.has(sample.tasks[0]!.sha256)).toBe(true);
    expect(receipts.has(sample.tasks[1]!.sha256)).toBe(false);
    expect(receipts.has(sample.tasks[2]!.sha256)).toBe(false);
  });

  test("non-receipt sealed records (plain Task/Benchmark bytes, arbitrary JSON) are silently skipped", async () => {
    const sample = await buildSampleBenchmark();
    putSealedBytes(workspaceDir, sample.tasks[0]!.bytes);
    putSealedBytes(workspaceDir, sample.benchmark.bytes);
    putSealedBytes(workspaceDir, sample.evaluationSpec.bytes);
    putSealedBytes(workspaceDir, new TextEncoder().encode(JSON.stringify({ arbitrary: "json", not: "a receipt" })));

    // No receipts were stored at all — every record above is a non-receipt shape.
    expect(scanPredictionSnapshotAdmissionReceipts(workspaceDir).size).toBe(0);
  });
});
