// SPDX-License-Identifier: Apache-2.0

/**
 * `run.import` (#2979) acceptance criterion 4: **the resulting bundle passes the public reader
 * without our executor having run anything.**
 *
 * The "ran nothing" half of that claim is STRUCTURAL here, not mocked. This workspace is built on
 * the native (non-Inspect) harness path exactly as `report.test.ts` builds its own — `sampleInit`
 * → arms → `runQuote` → `runLock` — and then `importRunRecords` stands where `runLaunch` would.
 * No venue is constructed and no backend is wired, so there is nothing in this file that COULD
 * have executed a cell. Everything after the import is the unmodified product chain: `runCollect`
 * → `runReport` → `materializePublicBundle` → the packaged public reader.
 *
 * ## What this file proves, and what it deliberately does not
 *
 * The first test materializes the bundle DIRECTLY. That is not an accident of convenience: by
 * operator ruling (issue #3417) an imported run is refused at PUBLICATION, because the Report's
 * sealed local-venue disclosure asserts an admission gate at dispatch time that no imported run
 * ever passed through. Materializing here keeps the structural claim — the bundle an imported run
 * produces is the ordinary frozen format, and every reader check including matrix re-derivation
 * accepts it — provable, while the second describe block pins the refusal that keeps that bundle
 * from ever reaching an operator through a supported path.
 */

import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { expectedCellSet, parseBenchmark, parseMatrix, parseRun } from "@jinn-network/benchmarking-records";
import type { ExternalRunRecord } from "../intake/external-run-records.js";
import { materializePublicBundle } from "../bundle/materialize.js";
import { verifyPublicBundle } from "../bundle/verify.js";
import { BUNDLE_FORMAT } from "../legacy-closures.js";
import { getSealedBytes } from "../workspace/sealed-store.js";
import { publicBundlesDir } from "../workspace/layout.js";
import { externalRunImportMarker } from "../run/imported-run.js";
import { readRunState, writeRunState } from "../run/state.js";
import { armAdd } from "./arms.js";
import type { OperationContext } from "./context.js";
import { createDraft, readDraftDocument } from "./drafts.js";
import { importRunRecords } from "./run-import.js";
import { initWorkspace } from "./init.js";
import { runCollect } from "./run-collect.js";
import { runLock } from "./run-lock.js";
import { runQuote } from "./run-quote.js";
import { publicationReport } from "./publication-report.js";
import { runPublish } from "./publish.js";
import { runReport } from "./report.js";
import { sampleInit } from "./sample.js";

let workspaceDir: string;
let evidenceRoot: string;

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "bp-import-bundle-ws-"));
  evidenceRoot = mkdtempSync(join(tmpdir(), "bp-import-bundle-dump-"));
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

const ERROR_REASON = "the container exited 137 before writing an output";
const TIMEOUT_REASON = "exceeded the harness's own 30 minute wall clock";
const UNRUN_REASON = "this slot was never scheduled: the sweep was cut short";
const UNGRADEABLE_REASON = "the harness produced an output the grader could not parse";

function writeEvidence(cellKey: string, name: string, body: string): string {
  const dir = join(evidenceRoot, cellKey.replace(/[^A-Za-z0-9._-]/gu, "_"));
  mkdirSync(dir, { recursive: true });
  const relative = join(dir, name).slice(evidenceRoot.length + 1);
  writeFileSync(join(evidenceRoot, relative), body);
  return relative;
}

/** The ladder to a LOCKED draft with NO venue and NO backend anywhere in it. */
async function lockedRun(clock: () => string, draftId: string): Promise<readonly string[]> {
  initWorkspace(contextFor(clock));
  createDraft(contextFor(clock), { draftId, name: "External Import Bundle Test" });
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
  const cellKeys = expectedCellSet(
    parseBenchmark(getSealedBytes(workspaceDir, document.spec.taskSet.benchmarkSha256)),
    parseRun(getSealedBytes(workspaceDir, runState.runSha256!)),
  ).map((coord) => coord.cellKey);
  expect(cellKeys.length).toBe(6);
  return cellKeys;
}

function gradedRow(row: number, cellKey: string, measurements: Record<string, boolean>): ExternalRunRecord {
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

/** Every one of the five import outcomes, so the bundle carries every synthesized shape. */
function mixedRows(cellKeys: readonly string[]): ExternalRunRecord[] {
  return [
    gradedRow(1, cellKeys[0]!, { integrity: true, resolved: true }),
    {
      row: 2,
      cellKey: cellKeys[1]!,
      outcome: "ungradeable",
      reason: UNGRADEABLE_REASON,
      evidence: [{ name: "prediction", path: writeEvidence(cellKeys[1]!, "prediction.json", `{"garbage":true}`) }],
    },
    { row: 3, cellKey: cellKeys[2]!, outcome: "error", reason: ERROR_REASON },
    { row: 4, cellKey: cellKeys[3]!, outcome: "timeout", reason: TIMEOUT_REASON },
    { row: 5, cellKey: cellKeys[4]!, outcome: "unrun", reason: UNRUN_REASON },
    gradedRow(6, cellKeys[5]!, { integrity: true, resolved: false }),
  ];
}

describe("run.import — the imported bundle passes the public reader", () => {
  test("a mixed-outcome imported run materializes a bundle every reader check accepts", async () => {
    const clock = makeClock();
    const draftId = "draft-1";
    const cellKeys = await lockedRun(clock, draftId);

    // Where a driven run calls `runLaunch(..., { createVenue })`. There is no venue and no backend
    // in this test at all: nothing here is capable of executing a cell.
    const imported = await importRunRecords(contextFor(clock), {
      draftId,
      records: mixedRows(cellKeys),
      source: SOURCE,
      evidenceRoot,
    });
    expect(imported.ok, JSON.stringify(imported)).toBe(true);
    if (!imported.ok) return;
    expect(imported.result.importedCellCount).toBe(6);
    expect(imported.result.written).toEqual({ graded: 2, ungradeable: 1, notDelivered: 3 });

    // --- the unmodified chain from here down ------------------------------------------------
    const collected = await runCollect(contextFor(clock), { draftId });
    expect(collected.ok, JSON.stringify(collected)).toBe(true);
    if (!collected.ok) return;
    expect(readDraftDocument(workspaceDir, draftId).state).toBe("closed");

    const reported = await runReport(contextFor(clock), { draftId });
    expect(reported.ok, JSON.stringify(reported)).toBe(true);
    if (!reported.ok) return;

    const runState = readRunState(workspaceDir, draftId)!;
    const materialized = materializePublicBundle({
      workspaceDir,
      draftId,
      benchmarkSha256: reported.result.claimPackage.records.benchmarkSha256,
      runState,
    });

    // Copied out and verified with the source workspace deleted, so nothing the reader accepts can
    // have come from a workspace-local file the bundle does not carry.
    const copied = mkdtempSync(join(tmpdir(), "bp-import-bundle-copy-"));
    try {
      cpSync(materialized.bundleDir, copied, { recursive: true });
      const matrix = parseMatrix(getSealedBytes(workspaceDir, collected.result.matrixSha256));
      rmSync(workspaceDir, { recursive: true, force: true });

      const verified = await verifyPublicBundle(copied);
      expect(verified.identity).toBe(materialized.identity);
      expect(verified.format).toBe(BUNDLE_FORMAT);
      // `matrix-rederivation` is the load-bearing one: it recomputes the Matrix from the bundle's
      // own evidence closure and byte-compares it against the carried Matrix. Its passing is what
      // proves the imported outcomes are the honest aggregation of the imported evidence rather
      // than numbers the importer asserted.
      expect(verified.checks).toEqual([
        "manifest",
        "evidence-closure",
        "trust",
        "matrix-rederivation",
        "report-verification",
        "claim-consistency",
      ]);

      // The reader accepted a run whose cells span all three derived outcomes.
      const byCellKey = new Map(matrix.cells.map((cell) => [cell.cellKey, cell]));
      expect(byCellKey.get(cellKeys[0]!)).toMatchObject({ outcome: "judged", dispatches: 1 });
      expect(byCellKey.get(cellKeys[1]!)).toMatchObject({ outcome: "unscorable", dispatches: 1 });
      expect(byCellKey.get(cellKeys[2]!)).toMatchObject({ outcome: "expired", dispatches: 1 });
      expect(byCellKey.get(cellKeys[3]!)).toMatchObject({ outcome: "expired", dispatches: 1 });
      expect(byCellKey.get(cellKeys[4]!)).toMatchObject({ outcome: "expired", dispatches: 0 });
      expect(byCellKey.get(cellKeys[5]!)).toMatchObject({ outcome: "judged", dispatches: 1 });

      // The honest "why" for a dispatched non-graded slot travels with the bundle: it rides the
      // solve Submission's namespaced annotation, which is inside the `records/` closure the
      // evidence-closure check just walked.
      const recordsDir = join(copied, "records");
      const carried = readdirSync(recordsDir)
        .map((name) => readFileSync(join(recordsDir, name), "utf8"))
        .join("\n");
      expect(carried).toContain(ERROR_REASON);
      expect(carried).toContain(TIMEOUT_REASON);
      expect(carried).toContain(UNGRADEABLE_REASON);
    } finally {
      rmSync(copied, { recursive: true, force: true });
    }
  }, 120_000);
});

/**
 * The operator ruling on #3314: an imported run does not publish, pending issue **#3417**.
 *
 * The bundle above is structurally sound, and that is exactly what makes the refusal necessary
 * rather than cosmetic. The Report it carries states, verbatim and in a SIGNED disclosure, that
 * "Run pinning on the harness, model, and loadout axes is enforced by an admission gate at
 * dispatch time" — while its own cells report every pinning axis as `unverifiable`, because no
 * venue dispatched anything and no admission gate existed. Both the workspace verifier and the
 * shipped reader derive that expected disclosure from `localVenueLimitsForRun(runRecord)`, a pure
 * function of a Run record sealed at `lock`, so nothing the importer writes can correct it. The
 * fix is a bundle-VISIBLE import marker, which is #3417's format work.
 */
describe("run.import — publication of an imported run is refused (#3417)", () => {
  /** The full chain up to `reported`, which is the exact state `publish` accepts from a driven run. */
  async function reportedImportedRun(clock: () => string, draftId: string): Promise<void> {
    const cellKeys = await lockedRun(clock, draftId);
    const imported = await importRunRecords(contextFor(clock), {
      draftId, records: mixedRows(cellKeys), source: SOURCE, evidenceRoot,
    });
    expect(imported.ok, JSON.stringify(imported)).toBe(true);
    const collected = await runCollect(contextFor(clock), { draftId });
    expect(collected.ok, JSON.stringify(collected)).toBe(true);
    const reported = await runReport(contextFor(clock), { draftId });
    expect(reported.ok, JSON.stringify(reported)).toBe(true);
    expect(readDraftDocument(workspaceDir, draftId).state).toBe("reported");
  }

  test("runPublish refuses, names the reason and the issue, and leaves nothing behind", async () => {
    const clock = makeClock();
    const draftId = "draft-1";
    await reportedImportedRun(clock, draftId);

    const published = await runPublish(contextFor(clock), { draftId });
    expect(published.ok).toBe(false);
    if (published.ok) return;
    expect(published.error.code).toBe("conflict");
    expect(published.error.issues?.map((issue) => issue.path)).toEqual([`runs.${draftId}.externalImport`]);
    // The refusal has to be actionable on its own: WHY (the disclosure the bundle would seal is
    // false), WHAT the operator can do about it (nothing here — it is a format change), and WHERE
    // that work lives.
    expect(published.error.detail).toMatch(/imported its results/u);
    expect(published.error.detail).toMatch(/admission gate/u);
    expect(published.error.detail).toMatch(/unverifiable/u);
    expect(published.error.detail).toMatch(/#3417/u);

    // Refused BEFORE a staging directory exists, so there is no half-shippable directory an
    // operator could collect by path, no bundle identity in RunState, and no lifecycle advance.
    expect(existsSync(publicBundlesDir(workspaceDir, draftId))).toBe(false);
    const runState = readRunState(workspaceDir, draftId)!;
    expect(runState.bundleIdentity).toBeUndefined();
    expect(runState.publishedAt).toBeUndefined();
    expect(readDraftDocument(workspaceDir, draftId).state).toBe("reported");

    // Idempotent: a second attempt refuses identically rather than finding a different path in.
    const again = await runPublish(contextFor(clock), { draftId });
    expect(again.ok).toBe(false);
    if (again.ok) return;
    expect(again.error.code).toBe("conflict");
  }, 180_000);

  test("still refuses when only the journal marker survived", async () => {
    const clock = makeClock();
    const draftId = "draft-1";
    await reportedImportedRun(clock, draftId);

    // The half-written import a crash between the journal append and the final RunState write
    // leaves behind. `writeExternalRunImport` orders the marker first precisely so this case
    // stays recognizable; the gate has to actually look.
    const { externalImportSha256: _dropped, ...withoutField } = readRunState(workspaceDir, draftId)!;
    writeRunState(workspaceDir, draftId, withoutField);
    expect(readRunState(workspaceDir, draftId)?.externalImportSha256).toBeUndefined();
    expect(externalRunImportMarker(workspaceDir, draftId)?.source).toBe("run-journal");

    const published = await runPublish(contextFor(clock), { draftId });
    expect(published.ok).toBe(false);
    if (published.ok) return;
    expect(published.error.code).toBe("conflict");
    expect(published.error.detail).toMatch(/#3417/u);
    expect(existsSync(publicBundlesDir(workspaceDir, draftId))).toBe(false);
  }, 180_000);

  test("managed signed-Report publication refuses on the import, not on staging state", async () => {
    const clock = makeClock();
    const draftId = "draft-1";
    await reportedImportedRun(clock, draftId);

    // `publication report` seals the identical `LOCAL_VENUE_LIMITS` into a signed record it
    // announces publicly, WITHOUT materializing a bundle — so closing only `publish` would leave
    // the same contradiction one verb away. What this pins is which refusal comes back: this
    // draft has no managed publication stage either, so it would earn the generic "a managed Run
    // ... is required" refusal on the very next line. Getting the import refusal instead is the
    // evidence that the gate is decided from the run itself and ahead of every stage check, so an
    // imported run cannot advance the managed chain far enough to be refused for a reason an
    // operator could then go and satisfy.
    const reported = await publicationReport(contextFor(clock), { draftId });
    expect(reported.ok).toBe(false);
    if (reported.ok) return;
    expect(reported.error.code).toBe("conflict");
    expect(reported.error.issues?.map((issue) => issue.path)).toEqual([`runs.${draftId}.externalImport`]);
    expect(reported.error.detail).toMatch(/admission gate/u);
    expect(reported.error.detail).toMatch(/#3417/u);
    expect(reported.error.detail).not.toMatch(/managed Run/u);
  }, 180_000);
});
