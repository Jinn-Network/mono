/**
 * BP-21 ACs 1-2 — assurance presets end to end on the REAL local venue: `evaluator-panel` with
 * agreeing evaluator identities, `strict-agreement` with a manufactured disagreement reducing to
 * conflicted, and `evaluator-panel` with an `overrides: { minVerdicts: 3 }` panel judging by
 * majority through retained dissent. Same register as `./run-path.integration.test.ts`: PUBLIC
 * operations only (init -> draft -> sample -> arms -> quote -> lock -> launch -> collect ->
 * results -> report), the real `createLocalVenue` backend with real subprocess launchers, no
 * in-memory backend, no faked verdicts. The ONLY test seam is the venue's own loudly-documented
 * `evaluationContextVariationForTesting` hook (see `../venue/venue.ts`), injected through the
 * public `RunLaunchDeps.createVenue` dependency — the sanctioned way to manufacture a controlled
 * evaluator disagreement.
 *
 * HOW THE MANUFACTURED DISAGREEMENT WORKS — an honestly-labeled, TEST-ONLY construction: the hook
 * rewrites `input/evaluation-context.json` for ONE selected evaluator so its resolution snapshot
 * names a different market (`resolutionSnapshot.marketId` diverges from the `market.marketId` the
 * same context declares — see `../venue/resolution.ts` for the real context shape). That
 * evaluator then genuinely grades against a different resolution: the prediction evaluator's
 * `market.identity` integrity check fails (`@jinn-network/task-execution-evaluator-adapters`'s
 * `parse.ts`) and its real, harness-recomputed, consistency-checked verdict is "fail", while the
 * untampered evaluators return "pass". Two flips that look simpler would NOT work, which is why
 * this one is the derivation: flipping only the snapshot's YES/NO `outcome` changes the Brier
 * measurements but never the pass/fail verdict, and forcing a non-"resolved" status makes the
 * spec's own verdict-rule recompute land on "inconclusive"/"fail" inconsistently with the
 * adapter's verdict, so the harness's verdict-consistency check would reject the attempt instead
 * of delivering a genuine opposite verdict.
 *
 * Fixture idioms (tmp dir prefix, contextFor/makeClock, afterEach cleanup, sample benchmark +
 * two-arm pinning) mirror `./run-path.integration.test.ts`.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  parseMatrix,
  parseReport,
  parseRun,
  type MatrixRecord,
  type ReportRecord,
} from "@jinn-network/benchmarking-records";
import { parseDsseEnvelope } from "@jinn-network/trust-core";
import type { Assurance } from "../domain/draft.js";
import { armAdd } from "../operations/arms.js";
import type { OperationContext } from "../operations/context.js";
import { createDraft, updateDraft } from "../operations/drafts.js";
import { initWorkspace } from "../operations/init.js";
import { runReport, type RunReportResult } from "../operations/report.js";
import { runCollect } from "../operations/run-collect.js";
import { runLaunch, type RunLaunchDeps } from "../operations/run-launch.js";
import { runLock } from "../operations/run-lock.js";
import { runQuote } from "../operations/run-quote.js";
import { runResults, type RunResultsDocument } from "../operations/run-results.js";
import { sampleInit } from "../operations/sample.js";
import type { SampleResolution } from "../venue/resolution.js";
import { readVerdictEnvelope } from "../venue/signing.js";
import { createLocalVenue, SOLVE_HARNESS_PINS } from "../venue/venue.js";
import { getSealedBytes } from "../workspace/sealed-store.js";
import { readRunJournalEntries, type RunJournalEntry } from "./journal.js";

let workspaceDir: string;

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "bp21-assurance-"));
});

afterEach(() => {
  rmSync(workspaceDir, { recursive: true, force: true });
});

/**
 * The REAL wall clock (see `./run-path.integration.test.ts`'s own note): these tests drive the
 * real local venue's real subprocess supervisor, whose deadline bookkeeping compares against
 * actual OS time — a synthetic clock rooted at a fixed past instant makes every real attempt's
 * deadline already-expired and the supervisor cancels every attempt within milliseconds.
 */
function makeClock(): () => string {
  return () => new Date().toISOString();
}

function contextFor(clock: () => string, principal = "sponsor-1"): OperationContext {
  return { workspaceDir, principal, clock };
}

function evaluatorIri(index: number): string {
  return `urn:jinn:benchmark-product:local-venue:evaluator-${index}`;
}

function bareSha256(digest: string): string {
  return digest.startsWith("sha256:") ? digest.slice("sha256:".length) : digest;
}

/**
 * TEST-ONLY manufactured disagreement (module header): for the one targeted evaluator identity,
 * rewrite the evaluation context so `resolutionSnapshot.marketId` no longer identifies the
 * declared `market.marketId` — that evaluator genuinely grades against a different resolution
 * and its real verdict is "fail". Every other evaluator's context passes through byte-untouched.
 */
function divergedResolutionVariation(
  targetEvaluatorIri: string,
): (evaluatorId: string, contextBytes: Uint8Array) => Uint8Array {
  return (evaluatorId, contextBytes) => {
    if (evaluatorId !== targetEvaluatorIri) return contextBytes;
    const resolution = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(contextBytes),
    ) as SampleResolution;
    const diverged: SampleResolution = {
      ...resolution,
      resolutionSnapshot: {
        ...resolution.resolutionSnapshot,
        marketId: `${resolution.resolutionSnapshot.marketId}-diverged-for-dissent`,
      },
    };
    return new TextEncoder().encode(JSON.stringify(diverged));
  };
}

type EvaluationEntry = Extract<RunJournalEntry, { kind: "evaluation" }>;

interface WilsonArmHeadline {
  readonly n: number;
  readonly passRate: string;
  readonly wilsonInterval: { readonly low: string; readonly high: string };
}

interface WilsonSubjectResults {
  readonly verdictRule: string;
  readonly arms: Record<string, WilsonArmHeadline>;
  readonly conflicted: { readonly count: number; readonly cellKeys: readonly string[] };
}

/** Narrows the sealed Report's wilson@1 results shape (the same shape `../report/claim.ts`'s own
 * `wilsonSubjectResults` extracts) — a mismatch here is a real finding, not a cast to paper over. */
function wilsonResultsOf(reportRecord: ReportRecord): WilsonSubjectResults {
  const results = reportRecord.results as { readonly perSubject?: readonly { readonly results?: unknown }[] };
  expect(results.perSubject).toHaveLength(1);
  return results.perSubject![0]!.results as WilsonSubjectResults;
}

function evaluationEntriesByCell(entries: readonly RunJournalEntry[]): Map<string, EvaluationEntry[]> {
  const byCell = new Map<string, EvaluationEntry[]>();
  for (const entry of entries) {
    if (entry.kind !== "evaluation") continue;
    const list = byCell.get(entry.cellKey) ?? [];
    list.push(entry);
    byCell.set(entry.cellKey, list);
  }
  return byCell;
}

interface ScenarioOutcome {
  readonly runSha256: string;
  readonly matrix: MatrixRecord;
  readonly results: RunResultsDocument;
  readonly report: RunReportResult;
  readonly reportRecord: ReportRecord;
  readonly journalEntries: readonly RunJournalEntry[];
}

/**
 * One full public-operations lifecycle on the real venue: init -> draft -> sample -> assurance
 * (via the public `updateDraft` patch) -> two real arms -> quote -> lock -> launch -> collect ->
 * results -> report. `sponsor-1` is the founding sponsor (initWorkspace) and holds every gated
 * grant by default — the explicit-grant gating path is covered by `./run-path.integration.test.ts`.
 */
async function runAssuredLifecycle(input: {
  readonly clock: () => string;
  readonly draftId: string;
  readonly assurance: Assurance;
  readonly variation?: (evaluatorId: string, contextBytes: Uint8Array) => Uint8Array;
}): Promise<ScenarioOutcome> {
  const { clock, draftId } = input;

  const initialized = initWorkspace(contextFor(clock));
  expect(initialized.ok).toBe(true);
  const created = createDraft(contextFor(clock), { draftId, name: "Assurance Presets" });
  expect(created.ok).toBe(true);

  const sample = await sampleInit(contextFor(clock), { draftId });
  expect(sample.ok).toBe(true);
  if (!sample.ok) throw new Error("unreachable");
  expect(sample.result.tasks).toHaveLength(3);

  const updated = updateDraft(contextFor(clock), { draftId, patch: { assurance: input.assurance } });
  expect(updated.ok, JSON.stringify(updated)).toBe(true);

  const baselineArm = armAdd(contextFor(clock), {
    draftId,
    armId: "baseline",
    pinning: { harness: SOLVE_HARNESS_PINS["prediction-v1-baseline"] },
  });
  expect(baselineArm.ok).toBe(true);
  const sampleArm = armAdd(contextFor(clock), {
    draftId,
    armId: "sample-uniform",
    pinning: { harness: SOLVE_HARNESS_PINS["sample-uniform"] },
  });
  expect(sampleArm.ok).toBe(true);

  const quoted = await runQuote(contextFor(clock), { draftId });
  expect(quoted.ok, JSON.stringify(quoted)).toBe(true);

  const locked = runLock(contextFor(clock), { draftId });
  expect(locked.ok, JSON.stringify(locked)).toBe(true);
  if (!locked.ok) throw new Error("unreachable");
  const runSha256 = locked.result.runSha256;

  const launchDeps: RunLaunchDeps =
    input.variation === undefined
      ? {}
      : {
          // The one sanctioned seam: wrap the REAL venue factory, forwarding every option
          // untouched, plus the test-only evaluation-context variation hook (module header).
          createVenue: (options) =>
            createLocalVenue({ ...options, evaluationContextVariationForTesting: input.variation }),
        };
  const launched = await runLaunch(contextFor(clock), { draftId }, launchDeps);
  expect(launched.ok, JSON.stringify(launched)).toBe(true);

  const collected = await runCollect(contextFor(clock), { draftId });
  expect(collected.ok, JSON.stringify(collected)).toBe(true);
  if (!collected.ok) throw new Error("unreachable");
  const matrix = parseMatrix(getSealedBytes(workspaceDir, collected.result.matrixSha256));
  expect(matrix.cells).toHaveLength(6);
  expect(matrix.completeness).toMatchObject({ expected: 6, judged: 6, runOutcome: "complete" });

  const results = runResults(contextFor(clock), { draftId });
  expect(results.ok, JSON.stringify(results)).toBe(true);
  if (!results.ok) throw new Error("unreachable");

  const report = await runReport(contextFor(clock), { draftId });
  expect(report.ok, JSON.stringify(report)).toBe(true);
  if (!report.ok) throw new Error("unreachable");
  const reportRecord = parseReport(getSealedBytes(workspaceDir, report.result.reportSha256));

  return {
    runSha256,
    matrix,
    results: results.result,
    report: report.result,
    reportRecord,
    journalEntries: readRunJournalEntries(workspaceDir, draftId),
  };
}

describe("evaluator-panel — two agreeing evaluator identities (AC1)", () => {
  test(
    "every delivered cell carries two distinctly-keyed, distinctly-attributed agreeing verdicts",
    async () => {
      const clock = makeClock();
      const outcome = await runAssuredLifecycle({
        clock,
        draftId: "panel-agree",
        assurance: { preset: "evaluator-panel" },
      });

      // ── sealed Run pre-registration: the resolved primitives, not the preset label ─────────
      const runRecord = parseRun(getSealedBytes(workspaceDir, outcome.runSha256));
      expect(runRecord.policy.independence).toBe("gating");
      expect(runRecord.policy.evaluation?.minVerdicts).toBe(2);
      expect(runRecord.policy.evaluation?.distinctEvaluator).toBe(true);

      // ── verdict evidence: EXACTLY 2 sealed DSSE envelopes per cell, distinct keyids AND
      //    distinct evaluator IRIs — real signatures from real per-evaluator keys ─────────────
      for (const cell of outcome.matrix.cells) {
        expect(cell.verdicts, cell.cellKey).toHaveLength(2);
        const keyids = new Set<string>();
        const evaluators = new Set<string>();
        for (const digest of cell.verdicts) {
          const envelopeBytes = getSealedBytes(workspaceDir, bareSha256(digest));
          const envelope = parseDsseEnvelope(envelopeBytes);
          expect(envelope.signatures, cell.cellKey).toHaveLength(1);
          const keyid = envelope.signatures[0]!.keyid;
          expect(keyid, cell.cellKey).toBeDefined();
          keyids.add(keyid!);
          evaluators.add(readVerdictEnvelope(envelopeBytes).evaluatorId);
        }
        expect(keyids.size, cell.cellKey).toBe(2);
        expect(evaluators, cell.cellKey).toEqual(new Set([evaluatorIri(1), evaluatorIri(2)]));
      }

      // ── run journal: two evaluator-attributed evaluation legs per delivered cell ───────────
      const byCell = evaluationEntriesByCell(outcome.journalEntries);
      expect(byCell.size).toBe(6);
      for (const [cellKey, entries] of byCell) {
        expect(entries, cellKey).toHaveLength(2);
        for (const legIndex of [1, 2]) {
          const leg = entries.find((entry) => entry.evalIndex === legIndex);
          expect(leg, `${cellKey} leg ${legIndex}`).toBeDefined();
          expect(leg?.evaluator, `${cellKey} leg ${legIndex}`).toBe(evaluatorIri(legIndex));
          expect(leg?.verdictSha256, `${cellKey} leg ${legIndex}`).toBeDefined();
        }
      }

      // ── results doc: both verdicts valid (signature-verified, gating-distinct), no dissent ─
      expect(outcome.results.cells).toHaveLength(6);
      for (const cell of outcome.results.cells) {
        expect(cell.verdicts, cell.cellKey).toHaveLength(2);
        expect(cell.validVerdicts, cell.cellKey).toHaveLength(2);
        expect(new Set(cell.verdicts.map((verdict) => verdict.verdict)), cell.cellKey).toEqual(new Set(["pass"]));
      }
      expect(outcome.results.dissentCells).toEqual([]);

      // ── report + claim: pre-registered, zero conflicted, preset AND resolved primitives ────
      expect(outcome.report.preregistered).toBe(true);
      const wilson = wilsonResultsOf(outcome.reportRecord);
      expect(wilson.conflicted.count).toBe(0);
      expect(wilson.conflicted.cellKeys).toEqual([]);
      const claim = outcome.report.claimPackage;
      expect(claim.assurance.preset).toBe("evaluator-panel");
      expect(claim.assurance.resolved.minVerdicts).toBe(2);
      expect(claim.assurance.resolved.verdictRule).toBe("majority");
      expect(claim.conflicted.count).toBe(0);
    },
    240_000,
  );
});

describe("strict-agreement — manufactured dissent reduces to conflicted (AC2, first half)", () => {
  test(
    "one diverged evaluator conflicts every cell under unanimous; dissent is never dropped",
    async () => {
      const clock = makeClock();
      const outcome = await runAssuredLifecycle({
        clock,
        draftId: "strict-dissent",
        assurance: { preset: "strict-agreement" },
        variation: divergedResolutionVariation(evaluatorIri(2)),
      });

      const allCellKeys = outcome.matrix.cells.map((cell) => cell.cellKey);

      // ── every cell carries two verdicts with DIFFERING values, both retained ───────────────
      for (const cell of outcome.results.cells) {
        expect(cell.verdicts, cell.cellKey).toHaveLength(2);
        expect(new Set(cell.verdicts.map((verdict) => verdict.verdict)), cell.cellKey).toEqual(
          new Set(["pass", "fail"]),
        );
        const dissenting = cell.verdicts.find((verdict) => verdict.verdict === "fail");
        expect(dissenting?.evaluator, cell.cellKey).toBe(evaluatorIri(2));
      }
      expect(new Set(outcome.results.dissentCells)).toEqual(new Set(allCellKeys));
      expect(outcome.results.dissentCells).toHaveLength(6);

      // ── report: every delivered cell dropped-with-report under unanimous ───────────────────
      const wilson = wilsonResultsOf(outcome.reportRecord);
      expect(wilson.conflicted.count).toBe(6);
      expect(wilson.conflicted.cellKeys).toEqual([...allCellKeys].sort());
      for (const armId of ["baseline", "sample-uniform"]) {
        expect(wilson.arms[armId]?.n, armId).toBe(0);
      }

      // ── claim: conflicted carried verbatim, resolved rule "unanimous" ──────────────────────
      const claim = outcome.report.claimPackage;
      expect(claim.conflicted.count).toBe(wilson.conflicted.count);
      expect(claim.conflicted.cellKeys).toEqual([...wilson.conflicted.cellKeys]);
      expect(claim.assurance.preset).toBe("strict-agreement");
      expect(claim.assurance.resolved.verdictRule).toBe("unanimous");
      // P4b Task 5: `headline` is optional on ClaimPackage (paired-delta carries `comparison`
      // instead); this lifecycle is wilson-only, so it is always present here.
      expect(claim.headline).toBeDefined();
      for (const armId of ["baseline", "sample-uniform"]) {
        expect(claim.headline?.[armId]?.n, armId).toBe(0);
      }

      // ── dissent never dropped: spot-check one cell's two verdict digests, present verbatim
      //    in BOTH the results doc and the sealed Matrix cell ─────────────────────────────────
      const spotCell = outcome.results.cells[0]!;
      const matrixCell = outcome.matrix.cells.find((cell) => cell.cellKey === spotCell.cellKey);
      expect(matrixCell).toBeDefined();
      expect(spotCell.verdicts).toHaveLength(2);
      for (const verdict of spotCell.verdicts) {
        expect(matrixCell!.verdicts.map(bareSha256), spotCell.cellKey).toContain(verdict.sha256);
      }
    },
    240_000,
  );
});

describe("evaluator-panel with overrides {minVerdicts: 3} — majority through retained dissent (AC2, second half)", () => {
  test(
    "a 2-1 panel judges decisively by majority while the dissenting verdict stays visible and valid",
    async () => {
      const clock = makeClock();
      const outcome = await runAssuredLifecycle({
        clock,
        draftId: "panel-majority",
        assurance: { preset: "evaluator-panel", overrides: { minVerdicts: 3 } },
        variation: divergedResolutionVariation(evaluatorIri(3)),
      });

      // ── the overrides path flows into the SEALED Run (resolveAssurance -> compile -> seal) ─
      const runRecord = parseRun(getSealedBytes(workspaceDir, outcome.runSha256));
      expect(runRecord.policy.independence).toBe("gating");
      expect(runRecord.policy.evaluation?.minVerdicts).toBe(3);
      expect(runRecord.policy.evaluation?.distinctEvaluator).toBe(true);

      // ── 3 verdicts per cell (2 agreeing + 1 dissenting), ALL THREE valid: dissent is a
      //    disagreement, not an invalidity — signature-verified and gating-distinct alike ─────
      expect(outcome.results.cells).toHaveLength(6);
      for (const cell of outcome.results.cells) {
        expect(cell.verdicts, cell.cellKey).toHaveLength(3);
        expect(cell.validVerdicts, cell.cellKey).toHaveLength(3);
        const passes = cell.verdicts.filter((verdict) => verdict.verdict === "pass");
        const fails = cell.verdicts.filter((verdict) => verdict.verdict === "fail");
        expect(passes, cell.cellKey).toHaveLength(2);
        expect(fails, cell.cellKey).toHaveLength(1);
        expect(fails[0]?.evaluator, cell.cellKey).toBe(evaluatorIri(3));
        expect(new Set(passes.map((verdict) => verdict.evaluator)), cell.cellKey).toEqual(
          new Set([evaluatorIri(1), evaluatorIri(2)]),
        );
      }
      expect(new Set(outcome.results.dissentCells)).toEqual(
        new Set(outcome.matrix.cells.map((cell) => cell.cellKey)),
      );

      // ── report: 2-1 is decisive under majority — nothing conflicted, full-n headline whose
      //    pass rates carry the majority value (pass on every cell) ───────────────────────────
      const wilson = wilsonResultsOf(outcome.reportRecord);
      expect(wilson.conflicted.count).toBe(0);
      expect(wilson.conflicted.cellKeys).toEqual([]);
      for (const armId of ["baseline", "sample-uniform"]) {
        expect(wilson.arms[armId]?.n, armId).toBe(3);
        expect(Number(wilson.arms[armId]?.passRate), armId).toBe(1);
      }

      const claim = outcome.report.claimPackage;
      expect(claim.assurance.preset).toBe("evaluator-panel");
      expect(claim.assurance.resolved.minVerdicts).toBe(3);
      expect(claim.assurance.resolved.verdictRule).toBe("majority");
      expect(claim.conflicted.count).toBe(0);
      // P4b Task 5: `headline` is optional on ClaimPackage; this lifecycle is wilson-only.
      expect(claim.headline).toBeDefined();
      for (const armId of ["baseline", "sample-uniform"]) {
        expect(claim.headline?.[armId]?.n, armId).toBe(3);
        expect(Number(claim.headline?.[armId]?.passRate), armId).toBe(1);
      }
    },
    300_000,
  );
});
