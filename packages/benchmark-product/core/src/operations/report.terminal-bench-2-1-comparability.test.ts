// SPDX-License-Identifier: Apache-2.0

/**
 * `report` on a run brought onto the official Terminal-Bench 2.1 slate (operator rulings of
 * 2026-10-06, decisions 2 and 7).
 *
 * The slate is bound with `method terminal-bench-2.1` and the results arrive through `run import`,
 * so no venue and no backend exist in this file. `report` then declares the `/10` capability
 * `terminal-bench-2-1-comparability`: it seals the sentence in its slot, and the claim carries the
 * section projected from the Benchmark's own extension. Before it seals anything it runs the
 * assertion the checker runs, so a draft a reader would refuse is refused here, while the
 * operator can still read why.
 *
 * No Task on the slate binds an EvaluationSpec yet, so every imported cell here is `unrun` and the
 * bundle-level test of a judged slate run lands with the change that binds the specs.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { BENCHMARK_RECORD_KIND, expectedCellSet, parseBenchmark, parseReport, parseRun } from "@jinn-network/benchmarking-records";
import { RECORD_KINDS } from "@jinn-network/record-discovery-protocol";
import {
  IMPORTED_RUN_PINNING_LIMIT,
  OWNER_CONTROLLED_PUBLICATION_LIMIT,
  TERMINAL_BENCH_21_COMPARABILITY_LIMIT,
  TERMINAL_BENCH_21_PINS,
} from "@colophon-claims/check";
import type { ExternalRunRecord } from "../intake/external-run-records.js";
import { buildTerminalBench21Tasks } from "../intake/terminal-bench-2-1.js";
import { deriveWorkspaceAuthoredBenchmark, deriveWorkspaceAuthoredTask } from "../intake/workspace-authored.js";
import { loadOrCreateReportSigningKey } from "../report/signing.js";
import { recordWorkspaceAuthorship } from "../run/publication-authority.js";
import { readRunState } from "../run/state.js";
import { getSealedBytes, putSealedBytes } from "../workspace/sealed-store.js";
import { armAdd } from "./arms.js";
import { attachBenchmarkToDraft } from "./attach.js";
import type { OperationContext } from "./context.js";
import { createDraft, readDraftDocument } from "./drafts.js";
import { initWorkspace } from "./init.js";
import { selectMethod } from "./method.js";
import { runReport } from "./report.js";
import { runCollect } from "./run-collect.js";
import { importRunRecords } from "./run-import.js";
import { runLock } from "./run-lock.js";
import { runQuote } from "./run-quote.js";
import { runVerify } from "./verify.js";

let workspaceDir: string;
let evidenceRoot: string;
let hostDir: string;

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "bp-tb21-report-ws-"));
  evidenceRoot = mkdtempSync(join(tmpdir(), "bp-tb21-report-dump-"));
  hostDir = mkdtempSync(join(tmpdir(), "bp-tb21-report-host-"));
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

const DRAFT_ID = "draft-1";
const HARBOR = { harness: "harbor", version: "0.21.0" } as const;

/**
 * Arms, quote, lock, an import in which no slot was driven, and collect: a closed draft.
 *
 * The import names the Harbor reader, as `run import --from harbor` does: `run import` accepts no
 * other route onto this slate. `source` is the label the import seals in its marker. The operation
 * takes it from its caller and does not hold it to the reader's name.
 */
async function closeImported(clock: () => string, source: { readonly harness: string; readonly version?: string }): Promise<void> {
  armAdd(contextFor(clock), { draftId: DRAFT_ID, armId: "oracle", pinning: { harness: { id: "harbor", version: "0.21.0" }, agent: { id: "oracle" } } });
  armAdd(contextFor(clock), { draftId: DRAFT_ID, armId: "terminus-2", pinning: { harness: { id: "harbor", version: "0.21.0" }, agent: { id: "terminus-2" } } });
  const quoted = await runQuote(contextFor(clock), { draftId: DRAFT_ID });
  expect(quoted.ok, JSON.stringify(quoted)).toBe(true);
  const locked = runLock(contextFor(clock), { draftId: DRAFT_ID });
  expect(locked.ok, JSON.stringify(locked)).toBe(true);
  const runState = readRunState(workspaceDir, DRAFT_ID)!;
  const document = readDraftDocument(workspaceDir, DRAFT_ID);
  if (document.spec.taskSet.kind !== "benchmark") throw new Error("unreachable");
  const cellKeys = expectedCellSet(
    parseBenchmark(getSealedBytes(workspaceDir, document.spec.taskSet.benchmarkSha256)),
    parseRun(getSealedBytes(workspaceDir, runState.runSha256!)),
  ).map((coord) => coord.cellKey);
  const records: ExternalRunRecord[] = cellKeys.map((cellKey, index) => ({
    row: index + 1,
    cellKey,
    outcome: "unrun",
    reason: "this slot was never driven",
  }));
  const imported = await importRunRecords(contextFor(clock), {
    draftId: DRAFT_ID,
    records,
    source,
    evidenceRoot,
    namedReader: "harbor",
  });
  expect(imported.ok, JSON.stringify(imported)).toBe(true);
  const collected = await runCollect(contextFor(clock), { draftId: DRAFT_ID });
  expect(collected.ok, JSON.stringify(collected)).toBe(true);
  expect(readDraftDocument(workspaceDir, DRAFT_ID).state).toBe("closed");
}

/** The claimant bind: `method terminal-bench-2.1` stores the builder's own Tasks and Benchmark. */
async function bindOfficialSlate(clock: () => string, slice: string): Promise<void> {
  initWorkspace(contextFor(clock));
  createDraft(contextFor(clock), { draftId: DRAFT_ID, name: "Brought Terminal-Bench 2.1 run" });
  const bound = await selectMethod(contextFor(clock), {
    draftId: DRAFT_ID,
    ref: "terminal-bench-2.1",
    cwd: hostDir,
    hostPath: join(hostDir, "host.json"),
    slice,
  });
  expect(bound.ok, JSON.stringify(bound)).toBe(true);
}

describe("report on a run brought onto the official Terminal-Bench 2.1 slate", () => {
  test("declares the capability: the sentence in its slot, and the section projected from the Benchmark", async () => {
    const clock = makeClock();
    await bindOfficialSlate(clock, "1");
    await closeImported(clock, HARBOR);

    const reported = await runReport(contextFor(clock), { draftId: DRAFT_ID });
    expect(reported.ok, JSON.stringify(reported)).toBe(true);
    if (!reported.ok) return;
    const claim = reported.result.claimPackage;
    expect(claim.terminalBench21Comparability).toEqual({
      datasetId: TERMINAL_BENCH_21_PINS.datasetId,
      datasetRevision: TERMINAL_BENCH_21_PINS.datasetRevision,
      upstreamCommit: TERMINAL_BENCH_21_PINS.upstreamCommit,
      slateDigest: TERMINAL_BENCH_21_PINS.slateDigest,
      coverage: "one_task",
      selectedTaskCount: 1,
      datasetTaskCount: 89,
      limit: TERMINAL_BENCH_21_COMPARABILITY_LIMIT,
    });
    // The signed Report carries it once, directly after the venue sentences of an imported run and
    // the publication-source sentence. A wilson Report has no binary-instrument line before it and
    // no paired-estimate line after it.
    const report = parseReport(getSealedBytes(workspaceDir, reported.result.reportSha256));
    const limitations = report.limitations ?? [];
    expect(limitations[2]).toBe(IMPORTED_RUN_PINNING_LIMIT);
    expect(limitations[5]).toBe(OWNER_CONTROLLED_PUBLICATION_LIMIT);
    expect(limitations[6]).toBe(TERMINAL_BENCH_21_COMPARABILITY_LIMIT);
    expect(limitations).toHaveLength(7);
    expect(claim.limitations).toEqual(limitations);
    // A venue sentence it is not: the claim's venue list stops at the publication-source sentence.
    expect((claim.venueHonesty as { readonly limits: readonly string[] }).limits)
      .not.toContain(TERMINAL_BENCH_21_COMPARABILITY_LIMIT);
    // It appends no check, so the claim pins the list an imported run already pinned.
    expect(claim.verification.checks).toEqual([
      "manifest",
      "evidence-closure",
      "trust",
      "matrix-rederivation",
      "report-verification",
      "claim-consistency",
      "external-import",
    ]);

    // The workspace verifier rebuilds the same claim from the run's own facts.
    const verified = await runVerify(contextFor(clock), { draftId: DRAFT_ID });
    expect(verified.ok, JSON.stringify(verified)).toBe(true);
  }, 120_000);

  test("refuses an import whose sealed marker does not name Harbor, before it seals anything", async () => {
    const clock = makeClock();
    await bindOfficialSlate(clock, "1");
    // No command reaches this: on this slate `run import` refuses every route but `--from harbor`,
    // and the Harbor reader writes `harbor` as the source itself. A caller of the operation can
    // still name that reader and seal another label, and the marker is all a reader of the bundle
    // sees, so `report` holds the marker and does not rely on the import having refused.
    await closeImported(clock, { harness: "my-own-runner", version: "1" });

    const reported = await runReport(contextFor(clock), { draftId: DRAFT_ID });
    expect(reported.ok).toBe(false);
    if (reported.ok) return;
    expect(reported.error.code).toBe("record-integrity");
    expect(reported.error.detail).toMatch(/imported from "my-own-runner", not from a Harbor jobs directory/u);
    // Nothing was sealed, and the draft is still the closed draft it was.
    expect(readDraftDocument(workspaceDir, DRAFT_ID).state).toBe("closed");
    expect(readRunState(workspaceDir, DRAFT_ID)!.reportSha256).toBeUndefined();
  }, 120_000);

  test("refuses a draft whose Tasks are off the pinned slate, naming the task", async () => {
    const clock = makeClock();
    initWorkspace(contextFor(clock));
    createDraft(contextFor(clock), { draftId: DRAFT_ID, name: "Re-authored slate" });
    // The same official item, re-authored under the workspace's own key: the Benchmark keeps the
    // official-slate extension, and its one Task is no longer the Task the checker pins.
    const built = buildTerminalBench21Tasks({ coverage: "one_task" });
    const author = loadOrCreateReportSigningKey(workspaceDir).keyId;
    const at = clock();
    putSealedBytes(workspaceDir, built.profile.bytes);
    const authoredTask = deriveWorkspaceAuthoredTask({ sourceBytes: built.tasks[0]!.bytes, author, sourceKind: "terminal-bench-2-1" });
    const taskSha256 = putSealedBytes(workspaceDir, authoredTask.bytes);
    recordWorkspaceAuthorship({ workspaceDir, recordSha256: taskSha256, recordKind: RECORD_KINDS.task, authoredAt: at });
    const authoredBenchmark = deriveWorkspaceAuthoredBenchmark({ sourceBytes: built.benchmark.bytes, taskSha256s: [taskSha256], author });
    const benchmarkSha256 = putSealedBytes(workspaceDir, authoredBenchmark.bytes);
    recordWorkspaceAuthorship({ workspaceDir, recordSha256: benchmarkSha256, recordKind: BENCHMARK_RECORD_KIND, authoredAt: at });
    attachBenchmarkToDraft(workspaceDir, DRAFT_ID, benchmarkSha256, at);
    expect(taskSha256).not.toBe(TERMINAL_BENCH_21_PINS.tasks[0]!.taskSha256);
    await closeImported(clock, HARBOR);

    const reported = await runReport(contextFor(clock), { draftId: DRAFT_ID });
    expect(reported.ok).toBe(false);
    if (reported.ok) return;
    expect(reported.error.code).toBe("record-integrity");
    expect(reported.error.detail).toContain(`"${TERMINAL_BENCH_21_PINS.tasks[0]!.name}"`);
    expect(reported.error.detail).toMatch(/not the pinned official Task/u);
    expect(readDraftDocument(workspaceDir, DRAFT_ID).state).toBe("closed");
    expect(readRunState(workspaceDir, DRAFT_ID)!.reportSha256).toBeUndefined();
  }, 120_000);
});
