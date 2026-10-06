// SPDX-License-Identifier: Apache-2.0

/**
 * `run.import` (#2979) end-to-end against the UNMODIFIED collect path.
 *
 * Every test here builds a real workspace on the native (non-Inspect) harness path — the same
 * `sampleInit` → arms → `runQuote` → `runLock` ladder `report.test.ts` uses — and then calls
 * `importRunRecords` where a driven run would call `runLaunch`. Nothing else changes: `runCollect`
 * runs exactly as it always does. That substitution IS the assertion. If importing ever needed a
 * special case downstream, these tests would be the first thing to break.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { defineBenchmark } from "@jinn-network/benchmarking-interop";
import { expectedCellSet, parseBenchmark, parseMatrix, parseRun } from "@jinn-network/benchmarking-records";
import {
  buildPredictionForecastProfile,
  deriveEvaluationTask,
  parseEvaluationSpec,
  sealEvaluationSpec,
  sealTaskProfile,
} from "@jinn-network/task-execution-profiles";
import { sealTask } from "@jinn-network/task-execution-protocol";
import { EVALUATOR_REQUIREMENT_KEY } from "../venue/provisioner.js";
import {
  readExternalRunRecords,
  readExternalRunRecordsCsv,
  type ExternalRunRecord,
} from "../intake/external-run-records.js";
import { buildSampleBenchmark } from "../intake/sample.js";
import { readRunJournalEntries } from "../run/journal.js";
import { requireWorkspaceAuthorship } from "../run/publication-authority.js";
import { externalRunImportMarker } from "../run/imported-run.js";
import { readRunState, writeRunState } from "../run/state.js";
import {
  dumpIdentityFromPath,
  EXTERNAL_RUN_IMPORT_DECLARATION_PROTOCOL,
  EXTERNAL_RUN_IMPORT_EVALUATOR_ID,
  ExternalRunImportDeclarationSchema,
} from "../run/external-import.js";
import { loadOrCreateReportSigningKey } from "../report/signing.js";
import { readOrderedVerdictMeasurements, readVerdictEnvelope } from "../venue/signing.js";
import { getSealedBytes, putSealedBytes } from "../workspace/sealed-store.js";
import { armAdd } from "./arms.js";
import { attachBenchmarkToDraft } from "./attach.js";
import type { OperationContext } from "./context.js";
import { createDraft, readDraftDocument, updateDraft } from "./drafts.js";
import { importRunRecords } from "./run-import.js";
import { initWorkspace } from "./init.js";
import { runCollect } from "./run-collect.js";
import { runLock } from "./run-lock.js";
import { runQuote } from "./run-quote.js";
import { sampleInit } from "./sample.js";

let workspaceDir: string;
let evidenceRoot: string;

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "bp-run-import-ws-"));
  evidenceRoot = mkdtempSync(join(tmpdir(), "bp-run-import-dump-"));
});

afterEach(() => {
  rmSync(workspaceDir, { recursive: true, force: true });
  rmSync(evidenceRoot, { recursive: true, force: true });
});

function makeClock(): () => string {
  let ms = Date.parse("2026-08-05T00:00:00.000Z");
  return () => {
    const value = new Date(ms).toISOString();
    ms += 10;
    return value;
  };
}

function contextFor(clock: () => string, principal = "sponsor-1"): OperationContext {
  return { workspaceDir, principal, clock };
}

const SOURCE = { harness: "some-external-harness", version: "2.4.0", note: "nightly sweep" } as const;

/**
 * The instant the run under test was sealed, captured by `lockedRun` below.
 *
 * Every imported timestamp must fall inside the sealed run window — at or after the seal instant,
 * at or before the import instant — so a fixture cannot pick a date out of the air. These clocks
 * seal and import within milliseconds of each other, so the rows are stamped at the seal instant
 * itself, which is inside the window at both ends.
 */
let runOpenAt = "";

/** Writes one evidence file into the dump directory and returns its dump-relative path. */
function writeEvidence(cellKey: string, name: string, body: string): string {
  const dir = join(evidenceRoot, cellKey.replace(/[^A-Za-z0-9._-]/gu, "_"));
  mkdirSync(dir, { recursive: true });
  const relative = join(dir, name).slice(evidenceRoot.length + 1);
  writeFileSync(join(evidenceRoot, relative), body);
  return relative;
}

/** The ladder up to a LOCKED draft, on the native prediction path. Two arms x three sample tasks
 * gives six expected slots — one more than the five import outcomes need. */
async function lockedRun(clock: () => string, draftId = "draft-1"): Promise<{
  readonly cellKeys: readonly string[];
  readonly runSha256: string;
}> {
  initWorkspace(contextFor(clock));
  createDraft(contextFor(clock), { draftId, name: "External Import Test" });
  const sample = await sampleInit(contextFor(clock), { draftId });
  expect(sample.ok, JSON.stringify(sample)).toBe(true);
  armAdd(contextFor(clock), { draftId, armId: "baseline", pinning: { harness: { id: "prediction-v1-baseline", version: "1.0.0" } } });
  armAdd(contextFor(clock), { draftId, armId: "sample", pinning: { harness: { id: "sample-uniform", version: "0.1.0" } } });
  const quoted = await runQuote(contextFor(clock), { draftId });
  expect(quoted.ok, JSON.stringify(quoted)).toBe(true);
  const locked = runLock(contextFor(clock), { draftId });
  expect(locked.ok, JSON.stringify(locked)).toBe(true);

  const runState = readRunState(workspaceDir, draftId)!;
  runOpenAt = runState.lockedAt!;
  const document = readDraftDocument(workspaceDir, draftId);
  if (document.spec.taskSet.kind !== "benchmark") throw new Error("unreachable");
  const runRecord = parseRun(getSealedBytes(workspaceDir, runState.runSha256!));
  const benchRecord = parseBenchmark(getSealedBytes(workspaceDir, document.spec.taskSet.benchmarkSha256));
  const cellKeys = expectedCellSet(benchRecord, runRecord).map((coord) => coord.cellKey);
  expect(cellKeys.length).toBe(6);
  return { cellKeys, runSha256: runState.runSha256! };
}

/** A `graded` row: the two measurements the sample EvaluationSpec's verdict rule references, plus
 * one evidence file standing in for the harness's prediction output. */
function gradedRow(row: number, cellKey: string, measurements: Record<string, boolean> = { integrity: true, resolved: true }): ExternalRunRecord {
  return {
    row,
    cellKey,
    outcome: "graded",
    startedAt: runOpenAt,
    endedAt: runOpenAt,
    durationMs: 0,
    evidence: [{ name: "prediction", path: writeEvidence(cellKey, "prediction.json", `{"probabilityYes":"0.5","cell":"${cellKey}"}`) }],
    measurements,
  };
}

function ungradeableRow(row: number, cellKey: string): ExternalRunRecord {
  return {
    row,
    cellKey,
    outcome: "ungradeable",
    reason: "the harness produced an output the grader could not parse",
    evidence: [{ name: "prediction", path: writeEvidence(cellKey, "prediction.json", `{"garbage":true,"cell":"${cellKey}"}`) }],
  };
}

function bareRow(row: number, cellKey: string, outcome: "error" | "timeout" | "unrun", reason: string): ExternalRunRecord {
  return { row, cellKey, outcome, reason };
}

/** All five import outcomes over the six expected slots, in expected-cell order. */
function mixedRows(cellKeys: readonly string[]): ExternalRunRecord[] {
  return [
    gradedRow(1, cellKeys[0]!),
    ungradeableRow(2, cellKeys[1]!),
    bareRow(3, cellKeys[2]!, "error", "the container exited 137 before writing an output"),
    bareRow(4, cellKeys[3]!, "timeout", "exceeded the harness's own 30 minute wall clock"),
    bareRow(5, cellKeys[4]!, "unrun", "this slot was never scheduled: the sweep was cut short"),
    gradedRow(6, cellKeys[5]!, { integrity: true, resolved: false }),
  ];
}

async function importAndCollect(
  clock: () => string,
  records: readonly ExternalRunRecord[],
  draftId = "draft-1",
): Promise<ReturnType<typeof parseMatrix>> {
  const imported = await importRunRecords(contextFor(clock), { draftId, records, source: SOURCE, evidenceRoot });
  expect(imported.ok, JSON.stringify(imported)).toBe(true);
  const collected = await runCollect(contextFor(clock), { draftId });
  expect(collected.ok, JSON.stringify(collected)).toBe(true);
  if (!collected.ok) throw new Error("unreachable");
  return parseMatrix(getSealedBytes(workspaceDir, collected.result.matrixSha256));
}

describe("run.import — the five outcomes through the unmodified collect path", () => {
  test("one mixed import derives judged / unscorable / expired and the right dispatch counts", async () => {
    const clock = makeClock();
    const { cellKeys } = await lockedRun(clock);
    const matrix = await importAndCollect(clock, mixedRows(cellKeys));

    const byCellKey = new Map(matrix.cells.map((cell) => [cell.cellKey, cell]));
    // Never asserted by the importer: every one of these is `deriveOutcome`'s reading of the
    // evidence that was written. A `graded` row whose measurements make the sealed verdict rule
    // inconclusive is still `judged` — the rule ran, and its answer was recorded.
    expect(byCellKey.get(cellKeys[0]!)).toMatchObject({ outcome: "judged", dispatches: 1 });
    expect(byCellKey.get(cellKeys[1]!)).toMatchObject({ outcome: "unscorable", dispatches: 1 });
    expect(byCellKey.get(cellKeys[2]!)).toMatchObject({ outcome: "expired", dispatches: 1 });
    expect(byCellKey.get(cellKeys[3]!)).toMatchObject({ outcome: "expired", dispatches: 1 });
    // The never-dispatched slot counts in the denominator and claims no attempt at all.
    expect(byCellKey.get(cellKeys[4]!)).toMatchObject({ outcome: "expired", dispatches: 0 });
    expect(byCellKey.get(cellKeys[4]!)?.submission).toBeUndefined();
    expect(byCellKey.get(cellKeys[5]!)).toMatchObject({ outcome: "judged", dispatches: 1 });

    expect(readDraftDocument(workspaceDir, "draft-1").state).toBe("closed");
  });

  test("the graded lineage is the exact derivation the public reader re-computes", async () => {
    const clock = makeClock();
    const { cellKeys, runSha256 } = await lockedRun(clock);
    await importAndCollect(clock, mixedRows(cellKeys));

    const journal = readRunJournalEntries(workspaceDir, "draft-1");
    const gradedCellKey = cellKeys[0]!;
    const delivery = journal.find((entry) => entry.kind === "delivery" && entry.cellKey === gradedCellKey)!;
    const evaluation = journal.find((entry) =>
      entry.kind === "evaluation" && entry.cellKey === gradedCellKey && entry.verdictSha256 !== undefined)!;
    if (delivery.kind !== "delivery" || evaluation.kind !== "evaluation") throw new Error("unreachable");

    // `verify.ts` (the packaged public reader) re-derives the evaluation Task from the solve
    // Delivery's outputs plus the subject Task's EvaluationSpec and byte-compares it against the
    // carried record. Recomputing it the same way here is the guard on that: the evidence output
    // NAMES and their ORDER are load-bearing, and a change to either breaks this first.
    const taskDigest = gradedCellKey.split("/")[0]!;
    const subjectTask = JSON.parse(new TextDecoder().decode(getSealedBytes(workspaceDir, taskDigest))) as {
      readonly evaluation: { readonly digest: { readonly sha256: string } };
    };
    const derived = deriveEvaluationTask({
      subjectTask: { name: "subject-task.json", digest: `sha256:${taskDigest}` },
      subjectDelivery: { name: "subject-delivery.json", digest: `sha256:${delivery.deliverySha256}` },
      subjectResults: delivery.outputs.map((output) => ({ name: output.name, digest: `sha256:${output.sha256}` as const })),
      evaluationSpecDigest: `sha256:${subjectTask.evaluation.digest.sha256}`,
    });
    expect(`sha256:${evaluation.evalTaskSha256!}`).toBe(derived.digest);
    expect(getSealedBytes(workspaceDir, evaluation.evalTaskSha256!)).toEqual(derived.bytes);

    // The evaluation Submission's nonce is re-parsed by materialization and re-asserted by the
    // reader; both halves must bind this exact run, leg, cell, and dispatch.
    const evalSubmissionEntry = journal.find((entry) =>
      entry.kind === "submission-accepted" && entry.cellKey === gradedCellKey && entry.leg === "evaluation")!;
    if (evalSubmissionEntry.kind !== "submission-accepted") throw new Error("unreachable");
    const evalSubmission = JSON.parse(new TextDecoder().decode(
      getSealedBytes(workspaceDir, evalSubmissionEntry.submissionSha256),
    )) as { nonce: string; idempotencyKey: string; task: { digest: { sha256: string } }; requirements: Record<string, unknown> };
    expect(evalSubmission.nonce).toBe(`eval:${runSha256}:e1:${gradedCellKey}:1`);
    expect(evalSubmission.idempotencyKey).toBe(evalSubmission.nonce);
    expect(evalSubmission.task.digest.sha256).toBe(evaluation.evalTaskSha256);
    expect(evalSubmission.requirements[EVALUATOR_REQUIREMENT_KEY]).toBe(EXTERNAL_RUN_IMPORT_EVALUATOR_ID);

    // The solve Submission carries no run-pinning evidence, and never gains any.
    const solve = journal.find((entry) =>
      entry.kind === "submission-accepted" && entry.cellKey === gradedCellKey && entry.leg === "solve")!;
    expect(solve.kind === "submission-accepted" && solve.pinningEvidenceSha256).toBeUndefined();
    expect(journal.some((entry) => entry.kind === "submission-pinning-evidence")).toBe(false);
  });

  test("the verdict is computed from the sealed rule, not imported", async () => {
    const clock = makeClock();
    const { cellKeys } = await lockedRun(clock);
    const matrix = await importAndCollect(clock, [
      gradedRow(1, cellKeys[0]!, { integrity: true, resolved: true }),
      gradedRow(2, cellKeys[1]!, { integrity: false, resolved: true }),
      gradedRow(3, cellKeys[2]!, { integrity: true, resolved: false }),
      ...cellKeys.slice(3).map((cellKey, index) => bareRow(4 + index, cellKey, "unrun", "out of scope for this test")),
    ]);

    const verdictFor = (cellKey: string): string => {
      const cell = matrix.cells.find((candidate) => candidate.cellKey === cellKey)!;
      return readVerdictEnvelope(getSealedBytes(workspaceDir, cell.verdicts[0]!.slice("sha256:".length))).verdict;
    };
    // integrity=true, resolved=true  -> the rule passes
    expect(verdictFor(cellKeys[0]!)).toBe("pass");
    // integrity=false               -> the rule fails
    expect(verdictFor(cellKeys[1]!)).toBe("fail");
    // resolved=false                -> the rule's declared inconclusive class fires
    expect(verdictFor(cellKeys[2]!)).toBe("inconclusive");
  });
});

describe("run.import — honesty invariants", () => {
  test("pinning stays unverifiable, and the evaluator is the distinct import identity", async () => {
    const clock = makeClock();
    const { cellKeys } = await lockedRun(clock);
    const matrix = await importAndCollect(clock, mixedRows(cellKeys));

    for (const cell of matrix.cells) {
      // No `pinningEvidenceSha256` is ever journaled, so nothing can quietly report a `match`
      // nobody checked. A future change that starts synthesizing pinning evidence breaks here.
      // (`isolation` is deliberately not in this list: it is derived from the sealed Run policy's
      // own admitted-posture inventory, not from any observation of the attempt, so it reads the
      // same for an imported run as for a run with no dispatches at all.)
      expect(cell.verification, cell.cellKey).toMatchObject({
        harness: "unverifiable",
        model: "unverifiable",
        loadout: "unverifiable",
      });
      // `integrityTier` is NOT an import-sensitive fact: it is derived from the Task's own sealed
      // admission receipt (`integrityTierFromReceipt` — zero replay variance, no external
      // capabilities), which describes the task's replayability and says nothing about whether
      // anyone observed this attempt. Import must neither upgrade nor downgrade it; the sample's
      // receipts make it "re-derivable" here exactly as they do on a driven run.
      expect(cell.integrityTier, cell.cellKey).toBe("re-derivable");
    }

    for (const cell of matrix.cells.filter((candidate) => candidate.outcome === "judged")) {
      expect(cell.evaluator, cell.cellKey).toBe(EXTERNAL_RUN_IMPORT_EVALUATOR_ID);
      const view = readVerdictEnvelope(getSealedBytes(workspaceDir, cell.verdicts[0]!.slice("sha256:".length)));
      expect(view.evaluatorId).toBe(EXTERNAL_RUN_IMPORT_EVALUATOR_ID);
      // The verdict says, in the record itself, that it transcribed someone else's measurements.
      expect(view.limitations?.join(" ")).toMatch(/transcribed/u);
    }
  });

  test("every imported reason survives in a sealed, workspace-authored declaration", async () => {
    const clock = makeClock();
    const { cellKeys, runSha256 } = await lockedRun(clock);
    const imported = await importRunRecords(contextFor(clock), {
      draftId: "draft-1",
      records: mixedRows(cellKeys),
      source: SOURCE,
      evidenceRoot,
    });
    expect(imported.ok, JSON.stringify(imported)).toBe(true);
    if (!imported.ok) return;

    const declaration = ExternalRunImportDeclarationSchema.parse(
      JSON.parse(new TextDecoder().decode(getSealedBytes(workspaceDir, imported.result.declarationSha256))),
    );
    expect(declaration.runSha256).toBe(runSha256);
    expect(declaration.source).toEqual(SOURCE);
    expect(declaration.dump.sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(declaration.dump.byteLength).toBeGreaterThan(0);
    expect(declaration.rows.map((row) => row.cellKey)).toEqual(cellKeys);
    expect(declaration.rows.find((row) => row.outcome === "unrun")?.reason)
      .toBe("this slot was never scheduled: the sweep was cut short");

    // The workspace genuinely authored the declaration, so it binds; it did NOT author the
    // external harness's evidence bytes, and records no authorship over them.
    expect(() => requireWorkspaceAuthorship({
      workspaceDir,
      recordSha256: imported.result.declarationSha256,
      recordKind: EXTERNAL_RUN_IMPORT_DECLARATION_PROTOCOL,
      author: loadOrCreateReportSigningKey(workspaceDir).keyId,
    })).not.toThrow();
    // ...and records none over the harness's own evidence bytes.
    const deliveryEntry = readRunJournalEntries(workspaceDir, "draft-1")
      .find((candidate) => candidate.kind === "delivery")!;
    expect(deliveryEntry.kind === "delivery" && deliveryEntry.outputs.length > 0).toBe(true);
    expect(() => requireWorkspaceAuthorship({
      workspaceDir,
      recordSha256: (deliveryEntry as { outputs: { sha256: string }[] }).outputs[0]!.sha256,
      recordKind: EXTERNAL_RUN_IMPORT_DECLARATION_PROTOCOL,
      author: loadOrCreateReportSigningKey(workspaceDir).keyId,
    })).toThrow();

    expect(readRunState(workspaceDir, "draft-1")?.externalImportSha256).toBe(imported.result.declarationSha256);
    const entries = readRunJournalEntries(workspaceDir, "draft-1");
    const entry = entries.find((candidate) => candidate.kind === "external-import");
    expect(entry).toMatchObject({ declarationSha256: imported.result.declarationSha256, source: SOURCE });
    // FIRST, not last. A crash after the final cell but before a trailing marker would leave a
    // complete-looking journal with no marker and no `externalImportSha256` — a run that reads as
    // driven. Leading with it makes the same crash leave an unmistakably partial import instead.
    expect(entries[0]).toBe(entry);
  });

  test("an imported timestamp outside the sealed run window is refused, leaving the draft locked", async () => {
    const clock = makeClock();
    const { cellKeys } = await lockedRun(clock);
    // A row dated a year before the Run record it is evidence for was sealed. Unbounded, this
    // becomes the `evaluatedAt` inside a SIGNED verdict attesting to work evaluated before its own
    // pre-registration; nothing downstream re-checks it.
    const before = {
      ...gradedRow(1, cellKeys[0]!),
      startedAt: "2025-01-01T00:00:00Z",
      endedAt: "2025-01-01T00:00:00Z",
      durationMs: 0,
    };
    const refused = await importRunRecords(contextFor(clock), {
      draftId: "draft-1",
      records: [
        before,
        ...cellKeys.slice(1).map((cellKey, index) => bareRow(2 + index, cellKey, "unrun", "not part of this test")),
      ],
      source: SOURCE,
      evidenceRoot,
    });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.code).toBe("validation");
    expect((refused.error.issues ?? []).map((issue) => issue.path)).toContain("timestamp-outside-window");
    expect(readDraftDocument(workspaceDir, "draft-1").state).toBe("locked");
    expect(readRunJournalEntries(workspaceDir, "draft-1")).toHaveLength(0);
  }, 60_000);

  test("a source string carrying a control character is refused before anything is written", async () => {
    const clock = makeClock();
    const { cellKeys } = await lockedRun(clock);
    const refused = await importRunRecords(contextFor(clock), {
      draftId: "draft-1",
      records: mixedRows(cellKeys),
      source: { harness: "some\u0007harness" },
      evidenceRoot,
    });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.code).toBe("validation");
    expect(readDraftDocument(workspaceDir, "draft-1").state).toBe("locked");
    expect(readRunJournalEntries(workspaceDir, "draft-1")).toHaveLength(0);
  }, 60_000);
});

describe("run.import — completion does not shrink the denominator", () => {
  test("supplying the missing slots as unrun leaves attrition.expected unchanged", async () => {
    const allGradedClock = makeClock();
    const all = await lockedRun(allGradedClock);
    const gradedMatrix = await importAndCollect(
      allGradedClock,
      all.cellKeys.map((cellKey, index) => gradedRow(index + 1, cellKey)),
    );

    rmSync(workspaceDir, { recursive: true, force: true });
    workspaceDir = mkdtempSync(join(tmpdir(), "bp-run-import-ws-"));
    const completedClock = makeClock();
    const partial = await lockedRun(completedClock);
    const completedMatrix = await importAndCollect(completedClock, [
      gradedRow(1, partial.cellKeys[0]!),
      gradedRow(2, partial.cellKeys[1]!),
      ...partial.cellKeys.slice(2).map((cellKey, index) =>
        bareRow(3 + index, cellKey, "unrun", "the harness never scheduled this slot")),
    ]);

    for (const armId of ["baseline", "sample"]) {
      expect(completedMatrix.attrition.perArm[armId]!.expected)
        .toBe(gradedMatrix.attrition.perArm[armId]!.expected);
    }
    // The denominator held; what moved is where the slots landed inside it.
    const expiredTotal = Object.values(completedMatrix.attrition.perArm)
      .reduce((total, arm) => total + arm.expired, 0);
    expect(expiredTotal).toBe(4);
    expect(Object.values(gradedMatrix.attrition.perArm).reduce((total, arm) => total + arm.expired, 0)).toBe(0);
  }, 120_000);
});

describe("run.import — refusals", () => {
  test("refuses a draft that is not locked", async () => {
    const clock = makeClock();
    const { cellKeys } = await lockedRun(clock);
    const first = await importRunRecords(contextFor(clock), {
      draftId: "draft-1", records: mixedRows(cellKeys), source: SOURCE, evidenceRoot,
    });
    expect(first.ok).toBe(true);

    const second = await importRunRecords(contextFor(clock), {
      draftId: "draft-1", records: mixedRows(cellKeys), source: SOURCE, evidenceRoot,
    });
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.error.code).toBe("illegal-transition");
  });

  test("refuses a run whose journal already has entries", async () => {
    const clock = makeClock();
    const { cellKeys } = await lockedRun(clock);
    const { appendRunJournalEntry } = await import("../run/journal.js");
    appendRunJournalEntry(workspaceDir, "draft-1", { kind: "launched", at: clock() });

    const outcome = await importRunRecords(contextFor(clock), {
      draftId: "draft-1", records: mixedRows(cellKeys), source: SOURCE, evidenceRoot,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("conflict");
    expect(outcome.error.detail).toMatch(/run-journal entries/u);
  });

  test("refuses an Inspect-bound draft rather than synthesizing native Inspect artifacts", async () => {
    const clock = makeClock();
    const { cellKeys } = await lockedRun(clock);
    // Patch the runtime binding onto the already-locked draft document: the point under test is
    // the operation's own refusal, not the lock-time path that would normally establish it.
    const { readDraftDocument: read } = await import("./drafts.js");
    const { atomicWriteFileSync } = await import("../fs/atomic.js");
    const { draftPath } = await import("../workspace/layout.js");
    const document = read(workspaceDir, "draft-1");
    atomicWriteFileSync(draftPath(workspaceDir, "draft-1"), JSON.stringify({
      ...document,
      spec: {
        ...document.spec,
        evaluationRuntime: { adapterId: "inspect", selectionManifestSha256: "0".repeat(64) },
      },
    }, null, 2));

    const outcome = await importRunRecords(contextFor(clock), {
      draftId: "draft-1", records: mixedRows(cellKeys), source: SOURCE, evidenceRoot,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("conflict");
    expect(outcome.error.detail).toMatch(/Inspect/u);
  });

  test("refuses an Inspect-bound draft even when a generic dump labels harness inspect", async () => {
    const clock = makeClock();
    const { cellKeys } = await lockedRun(clock);
    const { readDraftDocument: read } = await import("./drafts.js");
    const { atomicWriteFileSync } = await import("../fs/atomic.js");
    const { draftPath } = await import("../workspace/layout.js");
    const document = read(workspaceDir, "draft-1");
    atomicWriteFileSync(draftPath(workspaceDir, "draft-1"), JSON.stringify({
      ...document,
      spec: {
        ...document.spec,
        evaluationRuntime: { adapterId: "inspect", selectionManifestSha256: "0".repeat(64) },
      },
    }, null, 2));

    const outcome = await importRunRecords(contextFor(clock), {
      draftId: "draft-1",
      records: mixedRows(cellKeys),
      source: { harness: "inspect", version: "0.3.255" },
      evidenceRoot,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("conflict");
    expect(outcome.error.detail).toMatch(/run import --from inspect/u);
  });

  test("allows an Inspect-bound draft only when the named inspect reader supplied the records", async () => {
    const clock = makeClock();
    const { cellKeys } = await lockedRun(clock);
    const { readDraftDocument: read } = await import("./drafts.js");
    const { atomicWriteFileSync } = await import("../fs/atomic.js");
    const { draftPath } = await import("../workspace/layout.js");
    const document = read(workspaceDir, "draft-1");
    atomicWriteFileSync(draftPath(workspaceDir, "draft-1"), JSON.stringify({
      ...document,
      spec: {
        ...document.spec,
        evaluationRuntime: { adapterId: "inspect", selectionManifestSha256: "0".repeat(64) },
      },
    }, null, 2));

    const outcome = await importRunRecords(contextFor(clock), {
      draftId: "draft-1",
      records: mixedRows(cellKeys),
      source: { harness: "inspect", version: "0.3.255" },
      evidenceRoot,
      namedReader: "inspect",
    });
    expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
  });

  test("refuses minVerdicts > 1 rather than fanning one result across evaluator legs", async () => {
    const clock = makeClock();
    initWorkspace(contextFor(clock));
    createDraft(contextFor(clock), { draftId: "draft-1", name: "Multi-verdict" });
    const sample = await sampleInit(contextFor(clock), { draftId: "draft-1" });
    expect(sample.ok).toBe(true);
    armAdd(contextFor(clock), { draftId: "draft-1", armId: "baseline", pinning: { harness: { id: "prediction-v1-baseline", version: "1.0.0" } } });
    armAdd(contextFor(clock), { draftId: "draft-1", armId: "sample", pinning: { harness: { id: "sample-uniform", version: "0.1.0" } } });
    const patched = updateDraft(contextFor(clock), { draftId: "draft-1", patch: { assurance: { preset: "evaluator-panel" } } });
    expect(patched.ok, JSON.stringify(patched)).toBe(true);
    const quoted = await runQuote(contextFor(clock), { draftId: "draft-1" });
    expect(quoted.ok, JSON.stringify(quoted)).toBe(true);
    const locked = runLock(contextFor(clock), { draftId: "draft-1" });
    expect(locked.ok, JSON.stringify(locked)).toBe(true);

    const runState = readRunState(workspaceDir, "draft-1")!;
    const document = readDraftDocument(workspaceDir, "draft-1");
    if (document.spec.taskSet.kind !== "benchmark") throw new Error("unreachable");
    const cellKeys = expectedCellSet(
      parseBenchmark(getSealedBytes(workspaceDir, document.spec.taskSet.benchmarkSha256)),
      parseRun(getSealedBytes(workspaceDir, runState.runSha256!)),
    ).map((coord) => coord.cellKey);

    const outcome = await importRunRecords(contextFor(clock), {
      draftId: "draft-1",
      records: cellKeys.map((cellKey, index) => gradedRow(index + 1, cellKey)),
      source: SOURCE,
      evidenceRoot,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("conflict");
    expect(outcome.error.detail).toMatch(/minVerdicts/u);
  });

  test("a graded row missing a rule-referenced measurement refuses, naming it", async () => {
    const clock = makeClock();
    const { cellKeys } = await lockedRun(clock);
    const outcome = await importRunRecords(contextFor(clock), {
      draftId: "draft-1",
      records: [
        // `resolved` is declared in the spec and referenced by its verdict rule; omitting it means
        // the rule cannot be evaluated, and there is no honest way to guess the answer.
        gradedRow(1, cellKeys[0]!, { integrity: true }),
        ...cellKeys.slice(1).map((cellKey, index) => bareRow(2 + index, cellKey, "unrun", "not part of this test")),
      ],
      source: SOURCE,
      evidenceRoot,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("validation");
    expect(outcome.error.detail).toMatch(/resolved/u);
  });
});

describe("run.import — imported measurements are typed against the sealed spec", () => {
  /** The one verdict every downstream guard re-derives from the same map; if the imported values
   * reach the rule untyped, every one of those guards agrees on the same WRONG answer. */
  function verdictFor(matrix: ReturnType<typeof parseMatrix>, cellKey: string): string {
    const cell = matrix.cells.find((candidate) => candidate.cellKey === cellKey)!;
    return readVerdictEnvelope(getSealedBytes(workspaceDir, cell.verdicts[0]!.slice("sha256:".length))).verdict;
  }

  test("a CSV dump's boolean columns reach the verdict rule as booleans, not as strings", async () => {
    const clock = makeClock();
    const { cellKeys } = await lockedRun(clock);
    const evidence = cellKeys.slice(0, 2).map((cellKey) =>
      writeEvidence(cellKey, "prediction.json", `{"probabilityYes":"0.5","cell":"${cellKey}"}`));
    // The dialect the document publishes, read by the real CSV reader: every field is a string.
    const csv = [
      "cellKey,outcome,reason,evidence,m.integrity,m.resolved",
      `${cellKeys[0]!},graded,,prediction=${evidence[0]!},true,true`,
      `${cellKeys[1]!},graded,,prediction=${evidence[1]!},true,false`,
      ...cellKeys.slice(2).map((cellKey) => `${cellKey},unrun,not part of this test,,,`),
    ].join("\n");
    const matrix = await importAndCollect(clock, readExternalRunRecordsCsv(`${csv}\n`));

    // integrity=true, resolved=true -> the sealed rule passes. Read as the STRING "true" it would
    // fail, because `compare()` falls back to `===` for a non-numeric operand.
    expect(verdictFor(matrix, cellKeys[0]!)).toBe("pass");
    // resolved=false -> the rule's declared inconclusive class fires. As "false" it never would.
    expect(verdictFor(matrix, cellKeys[1]!)).toBe("inconclusive");
  }, 120_000);

  test("a measurement value the declared type cannot accept is refused, naming both", async () => {
    const clock = makeClock();
    const { cellKeys } = await lockedRun(clock);
    const outcome = await importRunRecords(contextFor(clock), {
      draftId: "draft-1",
      records: [
        // `integrity` is declared `type: "boolean"`; "yes" has no honest boolean reading.
        { ...gradedRow(1, cellKeys[0]!), measurements: { integrity: "yes", resolved: true } },
        ...cellKeys.slice(1).map((cellKey, index) => bareRow(2 + index, cellKey, "unrun", "not part of this test")),
      ],
      source: SOURCE,
      evidenceRoot,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.detail).toMatch(/integrity/u);
    expect(outcome.error.detail).toMatch(/boolean/u);
  }, 60_000);

  test("a measurement the sealed spec does not declare is refused rather than flowing untyped", async () => {
    const clock = makeClock();
    const { cellKeys } = await lockedRun(clock);
    const outcome = await importRunRecords(contextFor(clock), {
      draftId: "draft-1",
      records: [
        { ...gradedRow(1, cellKeys[0]!), measurements: { integrity: true, resolved: true, madeUp: 3 } },
        ...cellKeys.slice(1).map((cellKey, index) => bareRow(2 + index, cellKey, "unrun", "not part of this test")),
      ],
      source: SOURCE,
      evidenceRoot,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.detail).toMatch(/madeUp/u);
  }, 60_000);
});

describe("run.import, a declared number measurement", () => {
  /**
   * The ladder up to a LOCKED draft whose three sample Tasks bind a spec declaring one `number`
   * measurement, `reward`, under the guarded rule the official Terminal-Bench 2.1 slate is ruled
   * to seal: pass at 1, fail at 0, inconclusive for any other value. Everything but the
   * measurements and the rule is the bundled sample's own spec and Tasks.
   */
  async function lockedRewardRun(clock: () => string, draftId = "draft-1"): Promise<readonly string[]> {
    initWorkspace(contextFor(clock));
    createDraft(contextFor(clock), { draftId, name: "Reward Import Test" });
    const sample = await buildSampleBenchmark();
    const spec = sealEvaluationSpec({
      ...parseEvaluationSpec(sample.evaluationSpec.bytes),
      measurements: [
        { name: "reward", type: "number", required: true },
        { name: "note", type: "string", required: false },
      ],
      verdictRule: {
        all: [
          {
            inconclusiveWhen: {
              not: {
                any: [
                  { threshold: { measurement: "reward", op: "eq", value: 0 } },
                  { threshold: { measurement: "reward", op: "eq", value: 1 } },
                ],
              },
            },
            class: "non-binary-reward",
          },
          { threshold: { measurement: "reward", op: "eq", value: 1 } },
        ],
      },
      unscorable: [{ name: "non-binary-reward", disposition: "recorded-inconclusive" }],
    });
    const evaluationSpecSha256 = putSealedBytes(workspaceDir, spec.bytes);
    putSealedBytes(workspaceDir, sealTaskProfile(buildPredictionForecastProfile()).bytes);
    const tasks = sample.tasks.map((task) => {
      const source = JSON.parse(new TextDecoder().decode(task.bytes)) as Record<string, unknown>;
      const bytes = sealTask({
        ...source,
        evaluation: { name: "evaluation-spec.json", digest: { sha256: evaluationSpecSha256 } },
      });
      return { bytes, digest: `sha256:${putSealedBytes(workspaceDir, bytes)}` as const };
    });
    const benchmark = defineBenchmark(tasks, {
      name: "reward-import-test",
      description: "Sample tasks bound to a spec that declares one number measurement.",
      version: "1.0.0",
    });
    attachBenchmarkToDraft(workspaceDir, draftId, putSealedBytes(workspaceDir, benchmark.bytes), clock());
    armAdd(contextFor(clock), { draftId, armId: "baseline", pinning: { harness: { id: "prediction-v1-baseline", version: "1.0.0" } } });
    armAdd(contextFor(clock), { draftId, armId: "sample", pinning: { harness: { id: "sample-uniform", version: "0.1.0" } } });
    const quoted = await runQuote(contextFor(clock), { draftId });
    expect(quoted.ok, JSON.stringify(quoted)).toBe(true);
    const locked = runLock(contextFor(clock), { draftId });
    expect(locked.ok, JSON.stringify(locked)).toBe(true);

    const runState = readRunState(workspaceDir, draftId)!;
    runOpenAt = runState.lockedAt!;
    const document = readDraftDocument(workspaceDir, draftId);
    if (document.spec.taskSet.kind !== "benchmark") throw new Error("unreachable");
    const cellKeys = expectedCellSet(
      parseBenchmark(getSealedBytes(workspaceDir, document.spec.taskSet.benchmarkSha256)),
      parseRun(getSealedBytes(workspaceDir, runState.runSha256!)),
    ).map((coord) => coord.cellKey);
    expect(cellKeys.length).toBe(6);
    return cellKeys;
  }

  /** One JSONL line for a `graded` row, written the way a harness would write it: a JSON number
   * stays a JSON number in the file, so `0.5` reaches the reader as the float it is. */
  function rewardLine(cellKey: string, measurements: Record<string, string | number>): string {
    return JSON.stringify({
      cellKey,
      outcome: "graded",
      startedAt: runOpenAt,
      endedAt: runOpenAt,
      durationMs: 0,
      evidence: [{ name: "result", path: writeEvidence(cellKey, "result.json", `{"cell":"${cellKey}"}`) }],
      measurements,
    });
  }

  /** Imports a JSONL dump file through the same two calls `run import --file` makes. */
  function importDumpFile(clock: () => string, lines: readonly string[]) {
    const file = join(evidenceRoot, "records.jsonl");
    writeFileSync(file, `${lines.join("\n")}\n`);
    const text = new TextDecoder().decode(new Uint8Array(readFileSync(file)));
    const records = readExternalRunRecords(text, "jsonl");
    return importRunRecords(contextFor(clock), {
      draftId: "draft-1",
      records,
      source: SOURCE,
      evidenceRoot,
      dump: dumpIdentityFromPath(file, records),
    });
  }

  test("a fractional measurement is sealed as a decimal string and judged by the sealed rule", async () => {
    const clock = makeClock();
    const cellKeys = await lockedRewardRun(clock);
    // `0.5`, `"0.5"`, `"0.50"`, and one ten-millionth, then the two whole values the rule grades.
    const supplied: readonly (string | number)[] = [0.5, "0.5", "0.50", 1e-7, 1, 0];
    const imported = await importDumpFile(clock, cellKeys.map((cellKey, index) =>
      rewardLine(cellKey, { reward: supplied[index]! })));
    expect(imported.ok, JSON.stringify(imported)).toBe(true);
    if (!imported.ok) return;
    expect(imported.result.written).toEqual({ graded: 6, ungradeable: 0, notDelivered: 0 });
    // Six evidence files of this many bytes each; the operation reports what it carried.
    expect(imported.result.evidenceBytes).toBe(cellKeys.reduce((total, cellKey) =>
      total + new TextEncoder().encode(`{"cell":"${cellKey}"}`).length, 0));

    const collected = await runCollect(contextFor(clock), { draftId: "draft-1" });
    expect(collected.ok, JSON.stringify(collected)).toBe(true);
    if (!collected.ok) return;
    const matrix = parseMatrix(getSealedBytes(workspaceDir, collected.result.matrixSha256));
    const sealed = cellKeys.map((cellKey) => {
      const cell = matrix.cells.find((candidate) => candidate.cellKey === cellKey)!;
      expect(cell.outcome, cellKey).toBe("judged");
      const envelope = getSealedBytes(workspaceDir, cell.verdicts[0]!.slice("sha256:".length));
      return {
        reward: readOrderedVerdictMeasurements(envelope).find((measurement) => measurement.name === "reward")!.value,
        verdict: readVerdictEnvelope(envelope).verdict,
      };
    });
    expect(sealed).toEqual([
      { reward: "0.5", verdict: "inconclusive" },
      { reward: "0.5", verdict: "inconclusive" },
      { reward: "0.50", verdict: "inconclusive" },
      { reward: "0.0000001", verdict: "inconclusive" },
      { reward: 1, verdict: "pass" },
      { reward: 0, verdict: "fail" },
    ]);
  }, 120_000);

  test("a value the sealer refuses is refused before the run leaves locked, and the draft stays importable", async () => {
    const clock = makeClock();
    const cellKeys = await lockedRewardRun(clock);
    // An unpaired surrogate types as a string and no canonical JSON document can carry it. The
    // verdict statement is sealed after the `locked -> running` transition, which has no way
    // back, so a refusal there would strand the run for good.
    const refused = await importDumpFile(clock, cellKeys.map((cellKey, index) =>
      rewardLine(cellKey, index === 3 ? { reward: 1, note: "\ud800" } : { reward: 1 })));
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.code).toBe("validation");
    expect(refused.error.detail).toContain(cellKeys[3]!);
    expect(refused.error.detail).toContain("cannot be sealed");
    expect(readDraftDocument(workspaceDir, "draft-1").state).toBe("locked");
    expect(readRunJournalEntries(workspaceDir, "draft-1")).toHaveLength(0);
    expect(readRunState(workspaceDir, "draft-1")?.launchedAt).toBeUndefined();

    const imported = await importDumpFile(clock, cellKeys.map((cellKey) => rewardLine(cellKey, { reward: 1 })));
    expect(imported.ok, JSON.stringify(imported)).toBe(true);
    expect(readDraftDocument(workspaceDir, "draft-1").state).toBe("running");
  }, 120_000);

  test("records that cannot be hashed as given are refused before the run leaves locked", async () => {
    const clock = makeClock();
    const cellKeys = await lockedRewardRun(clock);
    // No `dump` identity is supplied here, so the operation hashes the canonical JSON of the
    // records itself, and canonical JSON cannot carry the float `0.5`. That hash used to be taken
    // after the transition.
    const refused = await importRunRecords(contextFor(clock), {
      draftId: "draft-1",
      records: readExternalRunRecords(`${cellKeys.map((cellKey) => rewardLine(cellKey, { reward: 0.5 })).join("\n")}\n`, "jsonl"),
      source: SOURCE,
      evidenceRoot,
    });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.code).toBe("validation");
    expect(refused.error.detail).toContain("dump identity");
    expect(readDraftDocument(workspaceDir, "draft-1").state).toBe("locked");
    expect(readRunJournalEntries(workspaceDir, "draft-1")).toHaveLength(0);
    expect(readRunState(workspaceDir, "draft-1")?.launchedAt).toBeUndefined();
  }, 120_000);

  test("the aggregate evidence cap is the caller's to set, and a breach leaves the run locked", async () => {
    const clock = makeClock();
    const cellKeys = await lockedRewardRun(clock);
    const lines = cellKeys.map((cellKey) => rewardLine(cellKey, { reward: 1 }));
    const carried = cellKeys.reduce((total, cellKey) =>
      total + new TextEncoder().encode(`{"cell":"${cellKey}"}`).length, 0);
    const file = join(evidenceRoot, "records.jsonl");
    writeFileSync(file, `${lines.join("\n")}\n`);
    const records = readExternalRunRecords(`${lines.join("\n")}\n`, "jsonl");

    const refused = await importRunRecords(contextFor(clock), {
      draftId: "draft-1",
      records,
      source: SOURCE,
      evidenceRoot,
      dump: dumpIdentityFromPath(file, records),
      maxAggregateEvidenceBytes: carried - 1,
    });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.detail).toContain(`above the ${carried - 1}-byte cap`);
    expect(readDraftDocument(workspaceDir, "draft-1").state).toBe("locked");

    const imported = await importRunRecords(contextFor(clock), {
      draftId: "draft-1",
      records,
      source: SOURCE,
      evidenceRoot,
      dump: dumpIdentityFromPath(file, records),
      maxAggregateEvidenceBytes: carried,
    });
    expect(imported.ok, JSON.stringify(imported)).toBe(true);
    if (!imported.ok) return;
    expect(imported.result.evidenceBytes).toBe(carried);
  }, 120_000);
});

describe("run.import — a refused dump leaves the draft importable", () => {
  test("a bad evidence path on a LATER row leaves the draft locked, the journal empty, and re-import possible", async () => {
    const clock = makeClock();
    const { cellKeys } = await lockedRun(clock);
    const broken: ExternalRunRecord[] = [
      gradedRow(1, cellKeys[0]!),
      { ...gradedRow(2, cellKeys[1]!), evidence: [{ name: "prediction", path: "typo/prediction.json" }] },
      ...cellKeys.slice(2).map((cellKey, index) => bareRow(3 + index, cellKey, "unrun", "not part of this test")),
    ];
    const refused = await importRunRecords(contextFor(clock), {
      draftId: "draft-1", records: broken, source: SOURCE, evidenceRoot,
    });
    expect(refused.ok).toBe(false);

    // The draft must survive the refusal: nothing transitioned, nothing was journaled, and no
    // launch was stamped. Otherwise one typo on row 2 of 200 kills the run permanently.
    expect(readDraftDocument(workspaceDir, "draft-1").state).toBe("locked");
    expect(readRunJournalEntries(workspaceDir, "draft-1")).toHaveLength(0);
    expect(readRunState(workspaceDir, "draft-1")?.launchedAt).toBeUndefined();

    const fixed = [...broken];
    fixed[1] = gradedRow(2, cellKeys[1]!);
    const imported = await importRunRecords(contextFor(clock), {
      draftId: "draft-1", records: fixed, source: SOURCE, evidenceRoot,
    });
    expect(imported.ok, JSON.stringify(imported)).toBe(true);
    expect(readDraftDocument(workspaceDir, "draft-1").state).toBe("running");
  }, 120_000);

  test("an evidence path that escapes the dump directory is refused, naming the row", async () => {
    const clock = makeClock();
    const { cellKeys } = await lockedRun(clock);
    for (const path of ["../../etc/passwd", "/etc/passwd"]) {
      const outcome = await importRunRecords(contextFor(clock), {
        draftId: "draft-1",
        records: [
          { ...gradedRow(1, cellKeys[0]!), evidence: [{ name: "prediction", path }] },
          ...cellKeys.slice(1).map((cellKey, index) => bareRow(2 + index, cellKey, "unrun", "not part of this test")),
        ],
        source: SOURCE,
        evidenceRoot,
      });
      expect(outcome.ok, path).toBe(false);
      if (outcome.ok) return;
      expect(outcome.error.detail, path).toMatch(/row 1/u);
      expect(readDraftDocument(workspaceDir, "draft-1").state).toBe("locked");
    }
  }, 120_000);
});

/**
 * The publication gate reads a durable fact about the run, not a flag this operation passes along.
 * These tests pin the two signals `../run/imported-run.ts` consults, including the half-written
 * case the marker-first journal ordering exists to make honest — `report` and `publish` still
 * treat either signal as an imported run (issue #3417).
 */
describe("run.import — the durable import marker the publication gate reads", () => {
  test("absent on a locked, never-imported run; names the declaration once imported", async () => {
    const clock = makeClock();
    const { cellKeys } = await lockedRun(clock);
    // A locked run with an empty journal is exactly the shape a DRIVEN run has at this point, so
    // this is the control: the gate must find nothing here or it would refuse every run.
    expect(externalRunImportMarker(workspaceDir, "draft-1")).toBeUndefined();

    const imported = await importRunRecords(contextFor(clock), {
      draftId: "draft-1", records: mixedRows(cellKeys), source: SOURCE, evidenceRoot,
    });
    expect(imported.ok, JSON.stringify(imported)).toBe(true);
    if (!imported.ok) return;
    expect(externalRunImportMarker(workspaceDir, "draft-1")).toEqual({
      declarationSha256: imported.result.declarationSha256,
      source: "run-state",
    });
  }, 120_000);

  test("survives in the journal when the RunState field never landed", async () => {
    const clock = makeClock();
    const { cellKeys } = await lockedRun(clock);
    const imported = await importRunRecords(contextFor(clock), {
      draftId: "draft-1", records: mixedRows(cellKeys), source: SOURCE, evidenceRoot,
    });
    expect(imported.ok, JSON.stringify(imported)).toBe(true);
    if (!imported.ok) return;

    // Exactly the state a crash between the journal marker and the final `writeRunState` leaves —
    // the case `writeExternalRunImport` orders the marker FIRST to keep honest. A gate that read
    // only RunState would call this run driven.
    const { externalImportSha256: _dropped, ...withoutField } = readRunState(workspaceDir, "draft-1")!;
    writeRunState(workspaceDir, "draft-1", withoutField);
    expect(readRunState(workspaceDir, "draft-1")?.externalImportSha256).toBeUndefined();

    expect(externalRunImportMarker(workspaceDir, "draft-1")).toEqual({
      declarationSha256: imported.result.declarationSha256,
      harness: SOURCE.harness,
      source: "run-journal",
    });
  }, 120_000);
});
