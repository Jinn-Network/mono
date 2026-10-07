// SPDX-License-Identifier: Apache-2.0

/**
 * Test fixture: a run brought onto the official Terminal-Bench 2.1 slate, published as a bundle.
 *
 * Every step is the production operation a claimant's command calls: `method terminal-bench-2.1`
 * binds the slate, two arms are added, the draft is quoted and locked, the results arrive through
 * `run import` under the Harbor reader's name, and `collect`, `report` and `publish` follow. No
 * venue and no backend exist here, so nothing in this file could have executed a cell.
 *
 * The imported rows carry Harbor's `reward` as their one measurement, the measurement each
 * official Task's `external-verifier` EvaluationSpec declares. The verdict is not imported: the
 * sealed rule computes it, and the checker recomputes it from the bundle.
 *
 * What this fixture does NOT exercise is the Harbor reader itself (`--from harbor` over a jobs
 * directory). The rows are built in memory, with a stand-in for the trial's `result.json`.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectedCellSet, itemTaskDigest, parseBenchmark, parseRun } from "@jinn-network/benchmarking-records";
import type { ExternalRunRecord } from "../../intake/external-run-records.js";
import { officialTerminalBench21TaskNames } from "../../intake/terminal-bench-2-1.js";
import { armAdd } from "../../operations/arms.js";
import type { OperationContext } from "../../operations/context.js";
import { createDraft, readDraftDocument } from "../../operations/drafts.js";
import { initWorkspace } from "../../operations/init.js";
import { selectMethod } from "../../operations/method.js";
import { runPublish } from "../../operations/publish.js";
import { runReport } from "../../operations/report.js";
import type { OperationResult } from "../../operations/result.js";
import { runCollect } from "../../operations/run-collect.js";
import { importRunRecords } from "../../operations/run-import.js";
import { runLock } from "../../operations/run-lock.js";
import { runQuote } from "../../operations/run-quote.js";
import { readRunState } from "../../run/state.js";
import { getSealedBytes } from "../../workspace/sealed-store.js";

/** The reward Harbor reported for one trial, as the Harbor reader hands it to import: a whole
 * reward as a number, any other as a decimal string. `undefined` is a slot with no trial. */
export type SlateReward = number | string | undefined;

export interface TerminalBench21SlateBundleFixture {
  readonly workspaceDir: string;
  readonly draftId: string;
  readonly bundle: { readonly bundleDir: string; readonly identity: string };
  /** The official task names the run covers, in slate order. */
  readonly taskNames: readonly string[];
  readonly benchmarkSha256: string;
  readonly runSha256: string;
}

const ARMS = ["oracle", "terminus-2"] as const;
export type SlateArmId = (typeof ARMS)[number];

function unwrap<T>(step: string, result: OperationResult<T>): T {
  if (!result.ok) throw new Error(`${step} failed: ${JSON.stringify(result.error)}`);
  return result.result;
}

function makeClock(): () => string {
  let ms = Date.parse("2026-08-05T00:00:00.000Z");
  return () => {
    const value = new Date(ms).toISOString();
    ms += 10;
    return value;
  };
}

/**
 * Builds the published bundle.
 *
 * `rewards` gives each arm's reward per task, in slate order. The default is three tasks: the
 * oracle arm passes all three, and the other arm passes one, fails one, and reports a reward of
 * one half, which the sealed rule answers as inconclusive.
 */
export async function createTerminalBench21SlateBundleFixture(input: {
  readonly workspaceDir: string;
  readonly rewards?: Readonly<Record<SlateArmId, readonly SlateReward[]>>;
}): Promise<TerminalBench21SlateBundleFixture> {
  const { workspaceDir } = input;
  const rewards = input.rewards ?? { oracle: [1, 1, 1], "terminus-2": [1, 0, "0.5"] };
  const taskNames = officialTerminalBench21TaskNames().slice(0, rewards.oracle.length);
  const draftId = "brought-terminal-bench-2-1";
  const clock = makeClock();
  const context: OperationContext = { workspaceDir, principal: "sponsor-1", clock };
  const evidenceRoot = mkdtempSync(join(tmpdir(), "tb21-slate-fixture-jobs-"));

  unwrap("init", initWorkspace(context));
  unwrap("draft create", createDraft(context, { draftId, name: "Brought Terminal-Bench 2.1 run" }));
  const bound = unwrap("method", await selectMethod(context, {
    draftId,
    ref: "terminal-bench-2.1",
    cwd: workspaceDir,
    ids: taskNames.join(","),
  }));
  for (const armId of ARMS) {
    unwrap("arm add", armAdd(context, {
      draftId,
      armId,
      pinning: { harness: { id: "harbor", version: "0.21.0" }, agent: { id: armId } },
    }));
  }
  unwrap("quote", await runQuote(context, { draftId }));
  unwrap("lock", runLock(context, { draftId }));

  const runState = readRunState(workspaceDir, draftId)!;
  const benchmarkSha256 = bound.benchmarkSha256!;
  const benchmark = parseBenchmark(getSealedBytes(workspaceDir, benchmarkSha256));
  const cells = expectedCellSet(benchmark, parseRun(getSealedBytes(workspaceDir, runState.runSha256!)));
  const taskIndex = new Map(benchmark.items.map((item, index) => [itemTaskDigest(item), index]));
  const records: ExternalRunRecord[] = cells.map((cell, index) => {
    const row = index + 1;
    const reward = rewards[cell.armId as SlateArmId]?.[taskIndex.get(cell.taskDigest)!];
    if (reward === undefined) {
      return { row, cellKey: cell.cellKey, outcome: "unrun", reason: "no trial was run for this slot" };
    }
    // The stand-in for the Harbor trial's own result file, under the name the sealed spec's
    // evidence conventions give it. It names its task and agent, as a real one does, so no two
    // cells carry the same evidence bytes.
    const trialDir = join(evidenceRoot, `trial-${row}`);
    mkdirSync(trialDir, { recursive: true });
    writeFileSync(join(trialDir, "result.json"), JSON.stringify({
      task_name: `terminal-bench/${taskNames[taskIndex.get(cell.taskDigest)!]}`,
      agent_info: { name: cell.armId },
      verifier_result: { rewards: { reward: Number(reward) } },
    }));
    return {
      row,
      cellKey: cell.cellKey,
      outcome: "graded",
      startedAt: runState.lockedAt!,
      endedAt: runState.lockedAt!,
      durationMs: 0,
      evidence: [{ name: "trial-result.json", path: `trial-${row}/result.json` }],
      measurements: { reward },
    };
  });
  unwrap("run import", await importRunRecords(context, {
    draftId,
    records,
    source: { harness: "harbor", version: "0.21.0" },
    evidenceRoot,
    namedReader: "harbor",
  }));
  unwrap("collect", await runCollect(context, { draftId }));
  unwrap("report", await runReport(context, { draftId }));
  const published = unwrap("publish", await runPublish(context, { draftId }));
  if (readDraftDocument(workspaceDir, draftId).state !== "published-bundle") {
    throw new Error("publish did not leave the draft in published-bundle");
  }
  return {
    workspaceDir,
    draftId,
    bundle: { bundleDir: join(workspaceDir, published.bundleRelativePath), identity: published.bundleIdentity },
    taskNames,
    benchmarkSha256,
    runSha256: runState.runSha256!,
  };
}
