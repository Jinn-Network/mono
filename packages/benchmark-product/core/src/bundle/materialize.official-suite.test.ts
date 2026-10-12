// SPDX-License-Identifier: Apache-2.0

/**
 * The producer's half of the Terminal-Bench 2.1 task-name projector (operator rulings of
 * 2026-10-06, decision 7).
 *
 * `materializePublicBundle` writes the report page a reader later rebuilds byte for byte, so it
 * must hand `derivePublicComparison` the fact the checker hands it: the claim's
 * `terminalBench21Comparability` section. This file walks the claimant path through the production
 * operations (`method terminal-bench-2.1`, `run import`, `collect`, `report`) and reads the page
 * the producer writes.
 *
 * No slot is driven here: the test imports every cell as `unrun`, so the page names the task and
 * shows no verdict and no reward. Each Task on the slate binds an `external-verifier`
 * EvaluationSpec, so the standalone checker accepts this bundle and rebuilds the same page. The
 * page of a judged slate run is read in `v10-materialize.test.ts`, and walked from a real Harbor
 * jobs directory in `conformance/claimant-path.terminal-bench-2-1.test.ts`.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { expectedCellSet, parseBenchmark, parseRun } from "@jinn-network/benchmarking-records";
import { BUNDLE_V10_FORMAT, TERMINAL_BENCH_21_COMPARABILITY_CAPABILITY, verifyPublicBundle } from "@colophon-claims/check";
import type { ExternalRunRecord } from "../intake/external-run-records.js";
import { TERMINAL_BENCH_21_OFFICIAL_TASKS } from "../intake/terminal-bench-2-1-slate.js";
import { armAdd } from "../operations/arms.js";
import type { OperationContext } from "../operations/context.js";
import { createDraft, readDraftDocument } from "../operations/drafts.js";
import { initWorkspace } from "../operations/init.js";
import { selectMethod } from "../operations/method.js";
import { runReport } from "../operations/report.js";
import { runCollect } from "../operations/run-collect.js";
import { importRunRecords } from "../operations/run-import.js";
import { runLock } from "../operations/run-lock.js";
import { runQuote } from "../operations/run-quote.js";
import { readRunState } from "../run/state.js";
import { TERMINAL_BENCH_2_1_DATASET_ID, TERMINAL_BENCH_2_1_DATASET_REF } from "../runtime/terminal-bench-2-1/manifest.js";
import { getSealedBytes } from "../workspace/sealed-store.js";
import { materializePublicBundle } from "./materialize.js";

let workspaceDir: string;
let evidenceRoot: string;

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "bp-tb21-page-ws-"));
  evidenceRoot = mkdtempSync(join(tmpdir(), "bp-tb21-page-dump-"));
});

afterEach(() => {
  for (const dir of [workspaceDir, evidenceRoot]) rmSync(dir, { recursive: true, force: true });
});

const DRAFT_ID = "draft-1";
const OFFICIAL = TERMINAL_BENCH_21_OFFICIAL_TASKS[0];
const hex12 = (reference: string): string => reference.slice("sha256:".length, "sha256:".length + 12);

/** A one-task slate draft, bound, imported with no slot driven, closed and reported. */
async function reportedSlateDraft(): Promise<{ readonly benchmarkSha256: string; readonly taskSha256: string }> {
  let ms = Date.parse("2026-08-05T00:00:00.000Z");
  const clock = (): string => {
    const value = new Date(ms).toISOString();
    ms += 10;
    return value;
  };
  const context = (): OperationContext => ({ workspaceDir, principal: "sponsor-1", clock });
  initWorkspace(context());
  createDraft(context(), { draftId: DRAFT_ID, name: "Brought Terminal-Bench 2.1 run" });
  const bound = await selectMethod(context(), {
    draftId: DRAFT_ID,
    ref: "terminal-bench-2.1",
    cwd: workspaceDir,
    slice: "1",
  });
  expect(bound.ok, JSON.stringify(bound)).toBe(true);
  for (const armId of ["oracle", "terminus-2"]) {
    armAdd(context(), { draftId: DRAFT_ID, armId, pinning: { harness: { id: "harbor", version: "0.21.0" }, agent: { id: armId } } });
  }
  const quoted = await runQuote(context(), { draftId: DRAFT_ID });
  expect(quoted.ok, JSON.stringify(quoted)).toBe(true);
  const locked = runLock(context(), { draftId: DRAFT_ID });
  expect(locked.ok, JSON.stringify(locked)).toBe(true);
  const document = readDraftDocument(workspaceDir, DRAFT_ID);
  if (document.spec.taskSet.kind !== "benchmark") throw new Error("unreachable");
  const benchmarkSha256 = document.spec.taskSet.benchmarkSha256;
  const cells = expectedCellSet(
    parseBenchmark(getSealedBytes(workspaceDir, benchmarkSha256)),
    parseRun(getSealedBytes(workspaceDir, readRunState(workspaceDir, DRAFT_ID)!.runSha256!)),
  );
  const records: ExternalRunRecord[] = cells.map((cell, index) => ({
    row: index + 1,
    cellKey: cell.cellKey,
    outcome: "unrun",
    reason: "this slot was never driven",
  }));
  const imported = await importRunRecords(context(), {
    draftId: DRAFT_ID,
    records,
    source: { harness: "harbor", version: "0.21.0" },
    evidenceRoot,
    namedReader: "harbor",
  });
  expect(imported.ok, JSON.stringify(imported)).toBe(true);
  const collected = await runCollect(context(), { draftId: DRAFT_ID });
  expect(collected.ok, JSON.stringify(collected)).toBe(true);
  const reported = await runReport(context(), { draftId: DRAFT_ID });
  expect(reported.ok, JSON.stringify(reported)).toBe(true);
  return { benchmarkSha256, taskSha256: cells[0]!.taskDigest };
}

describe("the page the producer writes for a run brought onto the official Terminal-Bench 2.1 slate", () => {
  test("names the task, its dataset, revision and package, and heads each cell with the task name", async () => {
    const { benchmarkSha256, taskSha256 } = await reportedSlateDraft();
    const bundle = materializePublicBundle({
      workspaceDir,
      draftId: DRAFT_ID,
      benchmarkSha256,
      runState: readRunState(workspaceDir, DRAFT_ID)!,
    });
    const manifest = JSON.parse(readFileSync(join(bundle.bundleDir, "bundle.json"), "utf8")) as {
      readonly format: string;
      readonly capabilities: readonly string[];
    };
    expect(manifest.format).toBe(BUNDLE_V10_FORMAT);
    expect(manifest.capabilities).toContain(TERMINAL_BENCH_21_COMPARABILITY_CAPABILITY);

    const summary =
      `Terminal-Bench 2.1 task; dataset ${TERMINAL_BENCH_2_1_DATASET_ID} at revision ${hex12(TERMINAL_BENCH_2_1_DATASET_REF)}; package ${hex12(OFFICIAL.ref)}`;
    const html = readFileSync(join(bundle.bundleDir, "index.html"), "utf8");
    expect(html).toContain(
      `<tr><th scope="row"><strong>${OFFICIAL.name}</strong><br><span class="source-label">${summary}</span></th>`,
    );
    for (const armId of ["oracle", "terminus-2"]) {
      expect(html).toContain(
        `<summary><strong>${armId}</strong> · ${OFFICIAL.name} · replicate 1 · No primary score</summary>`,
      );
    }
    const start = html.indexOf('<section id="comparison"');
    const comparison = html.slice(start, html.indexOf("</section>", start));
    // No slot was driven, so no cell has a verdict to state.
    expect(comparison).not.toContain("Verdict");
    expect(comparison).not.toContain(`Task ${taskSha256.slice(0, 12)}`);
    expect(comparison).not.toContain("no plain-language Colophon projector");

    const readme = readFileSync(join(bundle.bundleDir, "README.md"), "utf8");
    expect(readme).toContain(`- **${OFFICIAL.name}** — ${summary}\n`);

    // The reader rebuilds this page byte for byte, and accepts the bundle.
    expect((await verifyPublicBundle(bundle.bundleDir)).format).toBe(BUNDLE_V10_FORMAT);
  }, 120_000);
});
