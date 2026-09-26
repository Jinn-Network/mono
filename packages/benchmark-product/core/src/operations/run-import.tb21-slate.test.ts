import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { expectedCellSet, parseBenchmark, parseRun } from "@jinn-network/benchmarking-records";
import type { ExternalRunRecord } from "../intake/external-run-records.js";
import {
  TERMINAL_BENCH_21_OFFICIAL_SLATE_EXTENSION,
  officialTerminalBench21TaskNames,
} from "../intake/terminal-bench-2-1.js";
import { readRunState } from "../run/state.js";
import { getSealedBytes } from "../workspace/sealed-store.js";
import { armAdd } from "./arms.js";
import type { OperationContext } from "./context.js";
import { createDraft, readDraftDocument } from "./drafts.js";
import { importRunRecords } from "./run-import.js";
import { initWorkspace } from "./init.js";
import { runLock } from "./run-lock.js";
import { runQuote } from "./run-quote.js";
import { selectMethod } from "./method.js";

let workspaceDir: string;
let evidenceRoot: string;
let hostDir: string;

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "bp-tb21-import-ws-"));
  evidenceRoot = mkdtempSync(join(tmpdir(), "bp-tb21-import-dump-"));
  hostDir = mkdtempSync(join(tmpdir(), "bp-tb21-host-"));
  writeFileSync(join(hostDir, "host.json"), "{}");
});

afterEach(() => {
  rmSync(workspaceDir, { recursive: true, force: true });
  rmSync(evidenceRoot, { recursive: true, force: true });
  rmSync(hostDir, { recursive: true, force: true });
});

function makeClock(): () => string {
  let ms = Date.parse("2026-08-05T00:00:00.000Z");
  return () => {
    const value = new Date(ms).toISOString();
    ms += 10;
    return value;
  };
}

function contextFor(clock: () => string): OperationContext {
  return { workspaceDir, principal: "sponsor-1", clock };
}

async function lockedOfficial(
  clock: () => string,
  input: { readonly slice?: string; readonly ids?: string; readonly draftId?: string },
): Promise<{ readonly cellKeys: readonly string[] }> {
  const draftId = input.draftId ?? "draft-1";
  initWorkspace(contextFor(clock));
  createDraft(contextFor(clock), { draftId, name: "TB21 import" });
  const bound = await selectMethod(contextFor(clock), {
    draftId,
    ref: "terminal-bench-2.1",
    cwd: hostDir,
    hostPath: join(hostDir, "host.json"),
    ...(input.slice === undefined ? {} : { slice: input.slice }),
    ...(input.ids === undefined ? {} : { ids: input.ids }),
  });
  expect(bound.ok, JSON.stringify(bound)).toBe(true);
  armAdd(contextFor(clock), { draftId, armId: "baseline", pinning: { harness: { id: "prediction-v1-baseline", version: "1.0.0" } } });
  armAdd(contextFor(clock), { draftId, armId: "sample", pinning: { harness: { id: "sample-uniform", version: "0.1.0" } } });
  const quoted = await runQuote(contextFor(clock), { draftId });
  expect(quoted.ok, JSON.stringify(quoted)).toBe(true);
  const locked = runLock(contextFor(clock), { draftId });
  expect(locked.ok, JSON.stringify(locked)).toBe(true);
  const runState = readRunState(workspaceDir, draftId)!;
  const document = readDraftDocument(workspaceDir, draftId);
  if (document.spec.taskSet.kind !== "benchmark") throw new Error("unreachable");
  const cellKeys = expectedCellSet(
    parseBenchmark(getSealedBytes(workspaceDir, document.spec.taskSet.benchmarkSha256)),
    parseRun(getSealedBytes(workspaceDir, runState.runSha256!)),
  ).map((coord) => coord.cellKey);
  return { cellKeys };
}

function unrunRows(cellKeys: readonly string[]): ExternalRunRecord[] {
  return cellKeys.map((cellKey, index) => ({
    row: index + 1,
    cellKey,
    outcome: "unrun",
    reason: "imported coverage check; this slot was never driven",
  }));
}

const SOURCE = { harness: "tb21-slate-check", version: "1" } as const;

describe("run.import against the official Terminal-Bench 2.1 slate", () => {
  test("full coverage expects 89 tasks once (178 cells at 2 arms × 1 replicate)", async () => {
    const clock = makeClock();
    const { cellKeys } = await lockedOfficial(clock, { slice: "all" });
    const document = readDraftDocument(workspaceDir, "draft-1");
    if (document.spec.taskSet.kind !== "benchmark") throw new Error("unreachable");
    const benchmark = parseBenchmark(getSealedBytes(workspaceDir, document.spec.taskSet.benchmarkSha256));
    expect(benchmark.items).toHaveLength(89);
    expect(new Set(benchmark.items.map((item) => item.task.digest.sha256)).size).toBe(89);
    const slate = benchmark[TERMINAL_BENCH_21_OFFICIAL_SLATE_EXTENSION] as {
      coverage: string;
      selectedTaskNames: string[];
    };
    expect(slate.coverage).toBe("full");
    expect(slate.selectedTaskNames).toEqual([...officialTerminalBench21TaskNames()]);
    expect(cellKeys).toHaveLength(178);

    const imported = await importRunRecords(contextFor(clock), {
      draftId: "draft-1",
      records: unrunRows(cellKeys),
      source: SOURCE,
      evidenceRoot,
    });
    expect(imported.ok, JSON.stringify(imported)).toBe(true);
    if (!imported.ok) return;
    expect(imported.result.importedCellCount).toBe(178);
  }, 120_000);

  test("full coverage refuses a dump that omits one expected cell", async () => {
    const clock = makeClock();
    const { cellKeys } = await lockedOfficial(clock, { slice: "all" });
    const imported = await importRunRecords(contextFor(clock), {
      draftId: "draft-1",
      records: unrunRows(cellKeys.slice(0, -1)),
      source: SOURCE,
      evidenceRoot,
    });
    expect(imported.ok).toBe(false);
    if (imported.ok) return;
    expect(imported.error.code).toBe("validation");
    expect(imported.error.detail).toMatch(/missing slot/u);
    expect(imported.error.detail).toMatch(/178 expected slots/u);
  }, 120_000);

  test("one_task and custom subsets declare which official names they cover", async () => {
    const clock = makeClock();
    const one = await lockedOfficial(clock, { slice: "1", draftId: "one" });
    const oneDoc = readDraftDocument(workspaceDir, "one");
    if (oneDoc.spec.taskSet.kind !== "benchmark") throw new Error("unreachable");
    const oneSlate = parseBenchmark(getSealedBytes(workspaceDir, oneDoc.spec.taskSet.benchmarkSha256))[
      TERMINAL_BENCH_21_OFFICIAL_SLATE_EXTENSION
    ] as { coverage: string; selectedTaskNames: string[] };
    expect(oneSlate).toEqual(expect.objectContaining({
      coverage: "one_task",
      selectedTaskNames: [officialTerminalBench21TaskNames()[0]],
    }));
    expect(one.cellKeys).toHaveLength(2);
    const oneImported = await importRunRecords(contextFor(clock), {
      draftId: "one",
      records: unrunRows(one.cellKeys),
      source: SOURCE,
      evidenceRoot,
    });
    expect(oneImported.ok, JSON.stringify(oneImported)).toBe(true);

    rmSync(workspaceDir, { recursive: true, force: true });
    mkdirSync(workspaceDir);
    const custom = await lockedOfficial(clock, {
      ids: "write-compressor,qemu-startup",
      draftId: "custom",
    });
    const customDoc = readDraftDocument(workspaceDir, "custom");
    if (customDoc.spec.taskSet.kind !== "benchmark") throw new Error("unreachable");
    const customSlate = parseBenchmark(getSealedBytes(workspaceDir, customDoc.spec.taskSet.benchmarkSha256))[
      TERMINAL_BENCH_21_OFFICIAL_SLATE_EXTENSION
    ] as { coverage: string; selectedTaskNames: string[] };
    expect(customSlate.coverage).toBe("custom");
    expect(customSlate.selectedTaskNames).toEqual(["write-compressor", "qemu-startup"]);
    expect(custom.cellKeys).toHaveLength(4);
    const customImported = await importRunRecords(contextFor(clock), {
      draftId: "custom",
      records: unrunRows(custom.cellKeys),
      source: SOURCE,
      evidenceRoot,
    });
    expect(customImported.ok, JSON.stringify(customImported)).toBe(true);
  }, 60_000);
});
