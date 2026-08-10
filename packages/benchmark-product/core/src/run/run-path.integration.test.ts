/**
 * AC2 — the official-run integration test (BP-12, M1 composition dossier): one end-to-end
 * pass over the PUBLIC run operations only (quote -> lock -> launch -> status -> collect ->
 * results), on the real local venue (`../venue/venue.js`'s `createLocalVenue`), with real
 * subprocess-spawning launchers — no in-memory backend, no `task-execution-testing`. This is
 * the one test in the packet that proves the official run path actually works against the
 * real local execution backend, not a fake standing in for it.
 *
 * Fixture idioms (tmp dir prefix, contextFor/makeClock, afterEach cleanup) mirror
 * `../operations/run-launch.test.ts` and `./drive.test.ts`; the sample benchmark and arm
 * pinning shape mirror `../venue/venue.integration.test.ts`.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { parseMatrix, parseRun } from "@jinn-network/benchmarking-records";
import { parseDsseEnvelope } from "@jinn-network/trust-core";
import { readAuditEntries } from "../audit/journal.js";
import { armAdd } from "../operations/arms.js";
import { authorityGrant } from "../operations/authority-ops.js";
import type { OperationContext } from "../operations/context.js";
import { createDraft, readDraftDocument } from "../operations/drafts.js";
import { initWorkspace } from "../operations/init.js";
import { runCollect } from "../operations/run-collect.js";
import { runLaunch } from "../operations/run-launch.js";
import { runLock } from "../operations/run-lock.js";
import { runQuote } from "../operations/run-quote.js";
import { runResults } from "../operations/run-results.js";
import { runStatus } from "../operations/run-status.js";
import { sampleInit } from "../operations/sample.js";
import { readVerdictEnvelope } from "../venue/signing.js";
import { SOLVE_HARNESS_PINS } from "../venue/venue.js";
import { resultsArtifactPath } from "../workspace/layout.js";
import { getSealedBytes } from "../workspace/sealed-store.js";
import { readRunJournalEntries } from "./journal.js";

const SIX_FRACTION_DIGITS = /^-?\d+\.\d{6}$/;

let workspaceDir: string;

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "bp12-run-path-"));
});

afterEach(() => {
  rmSync(workspaceDir, { recursive: true, force: true });
});

/**
 * The REAL wall clock, not a synthetic frozen-in-the-past one: this test drives the real local
 * venue's real subprocess supervisor (`venue.integration.test.ts`'s own `now: () => new
 * Date().toISOString()` pattern), whose deadline/cancellation bookkeeping compares against
 * actual OS time. A synthetic clock rooted at a fixed past instant (the pattern the
 * fake-backend operation tests use, e.g. `../operations/run-launch.test.ts`) makes every real
 * attempt's deadline already-expired by the time the supervisor checks it against the real
 * clock, and the supervisor cancels every attempt within milliseconds of spawning it.
 */
function makeClock(): () => string {
  return () => new Date().toISOString();
}

function contextFor(clock: () => string, principal = "sponsor-1"): OperationContext {
  return { workspaceDir, principal, clock };
}

describe("official run path — public operations only, real local venue (AC2)", () => {
  test(
    "quote -> gated lock -> gated launch -> status -> collect -> results, end to end on the real backend",
    async () => {
      const clock = makeClock();
      const draftId = "draft-1";

      // ── 1. workspace, bundled sample, two arms ──────────────────────────────────────────
      const initialized = initWorkspace(contextFor(clock));
      expect(initialized.ok).toBe(true);
      const created = createDraft(contextFor(clock), { draftId, name: "Official Run" });
      expect(created.ok).toBe(true);

      const sample = await sampleInit(contextFor(clock), { draftId });
      expect(sample.ok).toBe(true);
      if (!sample.ok) throw new Error("unreachable");
      expect(sample.result.tasks).toHaveLength(3);

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

      // ── 2. quote ─────────────────────────────────────────────────────────────────────────
      const quoted = await runQuote(contextFor(clock), { draftId });
      expect(quoted.ok).toBe(true);
      if (!quoted.ok) throw new Error("unreachable");
      expect(quoted.result.quote.ok).toBe(true);
      expect(quoted.result.quote.expectedCellCount).toBe(6);
      expect(readDraftDocument(workspaceDir, draftId).state).toBe("quoted");

      // ── 3. gated lock (AC5, inline) ──────────────────────────────────────────────────────
      const scoped = authorityGrant(contextFor(clock), { principalId: "agent-1", operations: [] });
      expect(scoped.ok).toBe(true);

      const deniedLock = runLock(contextFor(clock, "agent-1"), { draftId });
      expect(deniedLock.ok).toBe(false);
      if (deniedLock.ok) throw new Error("unreachable");
      expect(deniedLock.error.code).toBe("authority-denied");
      const auditAfterDenial = readAuditEntries(workspaceDir);
      expect(auditAfterDenial[auditAfterDenial.length - 1]).toMatchObject({
        action: "lock",
        actor: "agent-1",
        outcome: "authority-denied",
      });

      const grantedLockLaunch = authorityGrant(contextFor(clock), {
        principalId: "agent-1",
        operations: ["lock", "launch"],
      });
      expect(grantedLockLaunch.ok).toBe(true);

      const locked = runLock(contextFor(clock, "agent-1"), { draftId });
      expect(locked.ok).toBe(true);
      if (!locked.ok) throw new Error("unreachable");
      expect(locked.result.draft.state).toBe("locked");

      const runRecord = parseRun(getSealedBytes(workspaceDir, locked.result.runSha256));
      expect(runRecord.arms).toHaveLength(2);
      expect(runRecord.analysisPlan?.[0]).toMatchObject({
        method: "jinn.benchmarking.method/wilson",
        version: "1",
      });
      expect(runRecord.policy.independence).toBe("disclosed");
      expect(runRecord.policy.evaluation.minVerdicts).toBe(1);
      expect(runRecord.venue).toMatchObject({ kind: "self-run" });
      expect(runRecord.closeAt).toBe(locked.result.closeAt);

      // Draft is immutable after lock — updateDraft/armAdd both refuse illegal-transition.
      const lateArm = armAdd(contextFor(clock), { draftId, armId: "late", pinning: {} });
      expect(lateArm.ok).toBe(false);
      if (lateArm.ok) throw new Error("unreachable");
      expect(lateArm.error.code).toBe("illegal-transition");

      // ── 4. launch — the real run: 6 solve cells (2 real launchers x 3 items) + 6 evaluation
      //      cells, all real subprocesses on the local venue's real backend ──────────────────
      const launched = await runLaunch(contextFor(clock, "agent-1"), { draftId });
      expect(launched.ok).toBe(true);
      if (!launched.ok) throw new Error("unreachable");
      expect(launched.result.draft.state).toBe("running");

      // Every evaluation journal entry is evaluator-attributed (BP-21): minVerdicts 1 means one
      // leg per cell, served by the venue's first evaluator identity.
      const journalEntries = readRunJournalEntries(workspaceDir, draftId);
      const evaluationJournalEntries = journalEntries.filter((entry) => entry.kind === "evaluation");
      expect(evaluationJournalEntries).toHaveLength(6);
      for (const entry of evaluationJournalEntries) {
        expect(entry).toMatchObject({
          evaluator: "urn:jinn:benchmark-product:local-venue:evaluator-1",
          evalIndex: 1,
        });
      }

      // ── 5. status ────────────────────────────────────────────────────────────────────────
      const status = runStatus(contextFor(clock), { draftId });
      expect(status.ok).toBe(true);
      if (!status.ok) throw new Error("unreachable");
      expect(status.result.cells).toHaveLength(6);
      expect(status.result.counts).toMatchObject({
        expected: 6,
        dispatched: 6,
        delivered: 6,
        judged: 6,
        failed: 0,
      });
      for (const cell of status.result.cells) {
        expect(cell.status, cell.cellKey).toBe("judged");
      }

      // ── 6. collect ───────────────────────────────────────────────────────────────────────
      const collected = await runCollect(contextFor(clock), { draftId });
      expect(collected.ok).toBe(true);
      if (!collected.ok) throw new Error("unreachable");
      expect(collected.result.draft.state).toBe("closed");

      const matrix = parseMatrix(getSealedBytes(workspaceDir, collected.result.matrixSha256));
      expect(matrix.cells).toHaveLength(6);
      expect(matrix.completeness).toMatchObject({ expected: 6, judged: 6, runOutcome: "complete" });
      for (const cell of matrix.cells) {
        expect(cell.outcome, cell.cellKey).toBe("judged");
        expect(cell.integrityTier, cell.cellKey).toBe("re-derivable");
        // The trust resolver (BP-21) resolves this identity ONLY after verifying the real
        // verdict envelope's DSSE signature against evaluator-1's workspace-registered key —
        // "unresolved" here would mean the signature-verifying resolver failed against genuine
        // venue-signed verdicts.
        expect(cell.evaluator, cell.cellKey).toBe("urn:jinn:benchmark-product:local-venue:evaluator-1");
        // The venue wires an exact {id, version} pin plus a matching launcherDeployments
        // identity digest for every harness it serves (venue.ts's own header) — the harness
        // axis is therefore expected to verify as "match" against the real backend's admission
        // gate. If this were ever "unverifiable" or "mismatch" that would be a real finding
        // about the venue's admission wiring, not something to relax the assertion for.
        expect(cell.verification.harness, cell.cellKey).toBe("match");
      }

      // ── 7. verdict evidence ──────────────────────────────────────────────────────────────
      for (const cell of matrix.cells) {
        expect(cell.verdicts, cell.cellKey).toHaveLength(1);
        const [prefixedDigest] = cell.verdicts;
        expect(prefixedDigest).toBeDefined();
        if (prefixedDigest === undefined) continue;
        const verdictSha256 = prefixedDigest.startsWith("sha256:")
          ? prefixedDigest.slice("sha256:".length)
          : prefixedDigest;
        const envelopeBytes = getSealedBytes(workspaceDir, verdictSha256);

        const parsedEnvelope = parseDsseEnvelope(envelopeBytes);
        expect(parsedEnvelope.payloadType).toBe("application/vnd.in-toto+json");

        const view = readVerdictEnvelope(envelopeBytes);
        expect(view.measurements["solverBrier"], cell.cellKey).toEqual(expect.stringMatching(SIX_FRACTION_DIGITS));
        expect(view.measurements["consensusBrier"], cell.cellKey).toEqual(expect.stringMatching(SIX_FRACTION_DIGITS));
        expect(view.measurements["brierSpread"], cell.cellKey).toEqual(expect.stringMatching(SIX_FRACTION_DIGITS));

        if (cell.armId === "baseline") {
          // prediction-v1-baseline echoes the posted consensus verbatim — solverBrier and
          // consensusBrier are scored against the identical predicted value, so the spread is
          // exactly zero by construction (consensus echo).
          expect(view.measurements["brierSpread"], cell.cellKey).toBe("0.000000");
        } else if (cell.armId === "sample-uniform") {
          // sample-uniform always predicts 0.5; every bundled sample task's consensus is != 0.5
          // (0.64 / 0.32 / 1.0), so the real coin-flip baseline's spread is never zero here.
          expect(view.measurements["brierSpread"], cell.cellKey).not.toBe("0.000000");
        }
      }

      // ── 8. results ───────────────────────────────────────────────────────────────────────
      const results = runResults(contextFor(clock), { draftId });
      expect(results.ok).toBe(true);
      if (!results.ok) throw new Error("unreachable");
      expect(results.result.runOutcome).toBe("complete");
      expect(results.result.completeness).toMatchObject({ expected: 6, judged: 6 });
      expect(results.result.cells).toHaveLength(6);
      for (const cell of results.result.cells) {
        expect(cell.outcome, cell.cellKey).toBe("judged");
      }
      expect(results.result.attrition).toBeDefined();
      expect(results.result.venueHonesty).toMatchObject({
        venue: "self-run",
        preRegistration: "structural-and-append-order-only",
      });
      expect(results.result.venueHonesty.limits.length).toBeGreaterThan(0);

      const artifactPath = resultsArtifactPath(workspaceDir, draftId);
      expect(existsSync(artifactPath)).toBe(true);
      expect(JSON.parse(readFileSync(artifactPath, "utf8"))).toEqual(results.result);

      // ── 9. audit ─────────────────────────────────────────────────────────────────────────
      const audit = readAuditEntries(workspaceDir);
      for (const action of ["quote", "lock", "launch", "run.collect", "run.results"] as const) {
        expect(
          audit.some((entry) => entry.action === action && entry.outcome === "ok"),
          `expected an "ok" audit entry for action "${action}"`,
        ).toBe(true);
      }
    },
    240_000,
  );
});
