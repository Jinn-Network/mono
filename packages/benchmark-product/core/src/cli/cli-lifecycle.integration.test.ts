/**
 * The CLI-level M1 lifecycle proof (BP-13, deliverable 4 / criterion 4): drives the FULL
 * lifecycle — `init` through `verify` — through `runCli` ONLY, on the REAL local venue (no fake
 * backend, no operations-facade calls except reading a file back off disk for one assertion).
 * Where `../run/run-path.integration.test.ts` proves the run path works as a LIBRARY, this test
 * proves the exact same path works through the CLI surface end to end.
 *
 * Workspace/clock idioms mirror that file: a tmpdir workspace, `afterEach` cleanup, and — because
 * `launch`/`resume` here drive the real local venue's real subprocess supervisor, whose
 * deadline/cancellation bookkeeping compares against actual OS time — the REAL wall clock rather
 * than a synthetic one (see that file's own `makeClock` comment: a clock rooted at a fixed past
 * instant makes every real attempt's deadline look already-expired the moment the supervisor
 * checks it, and every attempt gets cancelled within milliseconds of spawning).
 */

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { SOLVE_HARNESS_PINS } from "../venue/venue.js";
import { claimPackageArtifactPath } from "../workspace/layout.js";
import { runCli } from "./main.js";
import type { CliContext } from "./result.js";

let workspaceDir: string;

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "bp13-cli-lifecycle-"));
});

afterEach(() => {
  rmSync(workspaceDir, { recursive: true, force: true });
});

/** The REAL wall clock (module header) — the same reasoning as `run-path.integration.test.ts`'s
 * own `makeClock`. */
function makeClock(): () => string {
  return () => new Date().toISOString();
}

interface JsonEnvelope<T> {
  readonly ok: boolean;
  readonly result?: T;
  readonly error?: { readonly code: string; readonly detail: string };
}

function parseJson<T>(stdout: string): JsonEnvelope<T> {
  return JSON.parse(stdout) as JsonEnvelope<T>;
}

const SHA256_HEX = /^[a-f0-9]{64}$/;

describe("CLI lifecycle — init through verify, runCli only, real local venue (BP-13 criterion 4)", () => {
  test(
    "quote -> lock -> launch -> status -> resume -> collect -> results -> report -> verify, all --json, plus exit-code discipline",
    async () => {
      const clock = makeClock();
      const progressLines: string[] = [];
      const context: CliContext = { cwd: workspaceDir, clock, progress: (line) => progressLines.push(line) };
      const draftId = "draft-1";

      // ── exit-code discipline, part 1: an unknown flag refuses invalid-invocation, exit 2 ────
      // (checked first — argument parsing refuses before any workspace/draft state is touched.)
      const unknownFlag = await runCli(
        ["quote", "--workspace", workspaceDir, "--principal", "sponsor-1", "--draft", draftId, "--frobnicate", "x", "--json"],
        context,
      );
      expect(unknownFlag.exitCode).toBe(2);
      const unknownFlagBody = parseJson<never>(unknownFlag.stdout);
      expect(unknownFlagBody.ok).toBe(false);
      expect(unknownFlagBody.error?.code).toBe("invalid-invocation");

      // ── 1. init ──────────────────────────────────────────────────────────────────────────
      const init = await runCli(["init", "--workspace", workspaceDir, "--principal", "sponsor-1", "--json"], context);
      expect(init.exitCode).toBe(0);
      expect(parseJson<unknown>(init.stdout).ok).toBe(true);

      // ── 2. draft create ──────────────────────────────────────────────────────────────────
      const create = await runCli(
        [
          "draft", "create",
          "--workspace", workspaceDir, "--principal", "sponsor-1",
          "--id", draftId, "--name", "CLI Lifecycle",
          "--json",
        ],
        context,
      );
      expect(create.exitCode).toBe(0);
      const createBody = parseJson<{ draft: { draftId: string; state: string } }>(create.stdout);
      expect(createBody.ok).toBe(true);
      expect(createBody.result?.draft.draftId).toBe(draftId);
      expect(createBody.result?.draft.state).toBe("draft");

      // ── 3. sample init ───────────────────────────────────────────────────────────────────
      const sample = await runCli(
        ["sample", "init", "--workspace", workspaceDir, "--principal", "sponsor-1", "--draft", draftId, "--json"],
        context,
      );
      expect(sample.exitCode).toBe(0);
      const sampleBody = parseJson<{ benchmarkSha256: string; tasks: unknown[] }>(sample.stdout);
      expect(sampleBody.ok).toBe(true);
      expect(sampleBody.result?.tasks).toHaveLength(3);
      expect(sampleBody.result?.benchmarkSha256).toMatch(SHA256_HEX);

      // ── 4. arm add x2 (the platform's two real harness pins — run-path.integration.test.ts
      //      lines 85-96) ───────────────────────────────────────────────────────────────────
      const baselineArm = await runCli(
        [
          "arm", "add",
          "--workspace", workspaceDir, "--principal", "sponsor-1", "--draft", draftId,
          "--arm", "baseline",
          "--pinning", JSON.stringify({ harness: SOLVE_HARNESS_PINS["prediction-v1-baseline"] }),
          "--json",
        ],
        context,
      );
      expect(baselineArm.exitCode).toBe(0);
      expect(parseJson<unknown>(baselineArm.stdout).ok).toBe(true);

      const sampleUniformArm = await runCli(
        [
          "arm", "add",
          "--workspace", workspaceDir, "--principal", "sponsor-1", "--draft", draftId,
          "--arm", "sample-uniform",
          "--pinning", JSON.stringify({ harness: SOLVE_HARNESS_PINS["sample-uniform"] }),
          "--json",
        ],
        context,
      );
      expect(sampleUniformArm.exitCode).toBe(0);
      expect(parseJson<unknown>(sampleUniformArm.stdout).ok).toBe(true);

      // ── 5. quote ─────────────────────────────────────────────────────────────────────────
      const quote = await runCli(
        ["quote", "--workspace", workspaceDir, "--principal", "sponsor-1", "--draft", draftId, "--json"],
        context,
      );
      expect(quote.exitCode).toBe(0);
      const quoteBody = parseJson<{ draft: { state: string }; quote: { ok: boolean; expectedCellCount: number } }>(
        quote.stdout,
      );
      expect(quoteBody.ok).toBe(true);
      expect(quoteBody.result?.quote.ok).toBe(true);
      expect(quoteBody.result?.quote.expectedCellCount).toBe(6);
      expect(quoteBody.result?.draft.state).toBe("quoted");

      // ── 6. lock ──────────────────────────────────────────────────────────────────────────
      const lock = await runCli(
        ["lock", "--workspace", workspaceDir, "--principal", "sponsor-1", "--draft", draftId, "--json"],
        context,
      );
      expect(lock.exitCode).toBe(0);
      const lockBody = parseJson<{ draft: { state: string }; runSha256: string; closeAt: string }>(lock.stdout);
      expect(lockBody.ok).toBe(true);
      expect(lockBody.result?.runSha256).toMatch(SHA256_HEX);
      expect(lockBody.result?.closeAt).toBeDefined();
      expect(lockBody.result?.draft.state).toBe("locked");

      // ── 7. launch — the real run: real subprocesses, real local venue. --json mode means
      //      NOTHING streams to `context.progress` (module header). ──────────────────────────
      const launch = await runCli(
        ["launch", "--workspace", workspaceDir, "--principal", "sponsor-1", "--draft", draftId, "--json"],
        context,
      );
      expect(launch.exitCode).toBe(0);
      const launchBody = parseJson<{ draft: { state: string } }>(launch.stdout);
      expect(launchBody.ok).toBe(true);
      expect(launchBody.result?.draft.state).toBe("running");
      expect(progressLines).toHaveLength(0);

      // ── 8. status ────────────────────────────────────────────────────────────────────────
      const status = await runCli(
        ["status", "--workspace", workspaceDir, "--principal", "sponsor-1", "--draft", draftId, "--json"],
        context,
      );
      expect(status.exitCode).toBe(0);
      const statusBody = parseJson<{ counts: Record<string, number> }>(status.stdout);
      expect(statusBody.ok).toBe(true);
      expect(statusBody.result?.counts).toMatchObject({ expected: 6, dispatched: 6, delivered: 6, judged: 6, failed: 0 });

      // ── 9. resume — idempotent re-entry: everything is already complete, so nothing is
      //      outstanding and nothing streams. ────────────────────────────────────────────────
      const resume = await runCli(
        ["resume", "--workspace", workspaceDir, "--principal", "sponsor-1", "--draft", draftId, "--json"],
        context,
      );
      expect(resume.exitCode).toBe(0);
      const resumeBody = parseJson<{ outstandingCount: number; evaluationCatchUpCount: number }>(resume.stdout);
      expect(resumeBody.ok).toBe(true);
      expect(resumeBody.result?.outstandingCount).toBe(0);
      expect(resumeBody.result?.evaluationCatchUpCount).toBe(0);
      expect(progressLines).toHaveLength(0);

      // ── 10. collect ──────────────────────────────────────────────────────────────────────
      const collect = await runCli(
        ["collect", "--workspace", workspaceDir, "--principal", "sponsor-1", "--draft", draftId, "--json"],
        context,
      );
      expect(collect.exitCode).toBe(0);
      const collectBody = parseJson<{ draft: { state: string }; matrixSha256: string }>(collect.stdout);
      expect(collectBody.ok).toBe(true);
      expect(collectBody.result?.matrixSha256).toMatch(SHA256_HEX);
      expect(collectBody.result?.draft.state).toBe("closed");

      // ── exit-code discipline, part 2: an ungranted principal is refused authority-denied,
      //    exit 3, on the gated `report` verb — checked while the draft is still "closed", before
      //    the real `report` call below (a draft can only be reported once). ──────────────────
      const scopedGrant = await runCli(
        ["authority", "grant", "--workspace", workspaceDir, "--principal", "sponsor-1", "--grantee", "agent-1", "--json"],
        context,
      );
      expect(scopedGrant.exitCode).toBe(0);
      const deniedReport = await runCli(
        ["report", "--workspace", workspaceDir, "--principal", "agent-1", "--draft", draftId, "--json"],
        context,
      );
      expect(deniedReport.exitCode).toBe(3);
      const deniedReportBody = parseJson<never>(deniedReport.stdout);
      expect(deniedReportBody.ok).toBe(false);
      expect(deniedReportBody.error?.code).toBe("authority-denied");

      // ── 11. results ──────────────────────────────────────────────────────────────────────
      const results = await runCli(
        ["results", "--workspace", workspaceDir, "--principal", "sponsor-1", "--draft", draftId, "--json"],
        context,
      );
      expect(results.exitCode).toBe(0);
      const resultsBody = parseJson<{ runOutcome: string; cells: unknown[]; venueHonesty: unknown }>(results.stdout);
      expect(resultsBody.ok).toBe(true);
      expect(resultsBody.result?.runOutcome).toBe("complete");
      expect(resultsBody.result?.cells).toHaveLength(6);
      expect(resultsBody.result?.venueHonesty).toBeDefined();

      // ── 12. report — sponsor-1 (the founding sponsor) holds every grant by default, per
      //      `run-resume.integration.test.ts`'s own note. ─────────────────────────────────────
      const report = await runCli(
        ["report", "--workspace", workspaceDir, "--principal", "sponsor-1", "--draft", draftId, "--json"],
        context,
      );
      expect(report.exitCode).toBe(0);
      const reportBody = parseJson<{
        reportSha256: string;
        reportEnvelopeSha256: string;
        preregistered: boolean;
        claimPackage: unknown;
      }>(report.stdout);
      expect(reportBody.ok).toBe(true);
      expect(reportBody.result?.reportSha256).toMatch(SHA256_HEX);
      expect(reportBody.result?.reportEnvelopeSha256).toMatch(SHA256_HEX);
      expect(reportBody.result?.preregistered).toBe(true);
      expect(reportBody.result?.claimPackage).toBeDefined();
      expect(existsSync(claimPackageArtifactPath(workspaceDir, draftId))).toBe(true);

      // ── 13. verify ───────────────────────────────────────────────────────────────────────
      const verify = await runCli(
        ["verify", "--workspace", workspaceDir, "--principal", "sponsor-1", "--draft", draftId, "--json"],
        context,
      );
      expect(verify.exitCode).toBe(0);
      const verifyBody = parseJson<{ checks: readonly string[] }>(verify.stdout);
      expect(verifyBody.ok).toBe(true);
      expect(verifyBody.result?.checks).toEqual(["matrix-rederivation", "report-verification", "claim-consistency"]);
    },
    240_000,
  );

  // BP-13 fix 5: human mode (no --json) is the ONLY mode that streams `context.progress`
  // (module header, `launchDeps`) — this test drives the same small sample/2-arm shape through
  // `launch` in human mode and asserts the collector actually saw lines for the cell-event
  // classes the run journal records (`dispatch`, `judged`), not just that it stayed empty.
  test(
    "human mode: launch streams onProgress lines (dispatch, judged) and stdout carries the human success line",
    async () => {
      const clock = makeClock();
      const progressLines: string[] = [];
      const context: CliContext = { cwd: workspaceDir, clock, progress: (line) => progressLines.push(line) };
      const draftId = "draft-1";

      const init = await runCli(["init", "--workspace", workspaceDir, "--principal", "sponsor-1"], context);
      expect(init.exitCode).toBe(0);

      const create = await runCli(
        [
          "draft", "create",
          "--workspace", workspaceDir, "--principal", "sponsor-1",
          "--id", draftId, "--name", "CLI Human Mode",
        ],
        context,
      );
      expect(create.exitCode).toBe(0);

      const sample = await runCli(
        ["sample", "init", "--workspace", workspaceDir, "--principal", "sponsor-1", "--draft", draftId],
        context,
      );
      expect(sample.exitCode).toBe(0);

      const baselineArm = await runCli(
        [
          "arm", "add",
          "--workspace", workspaceDir, "--principal", "sponsor-1", "--draft", draftId,
          "--arm", "baseline",
          "--pinning", JSON.stringify({ harness: SOLVE_HARNESS_PINS["prediction-v1-baseline"] }),
        ],
        context,
      );
      expect(baselineArm.exitCode).toBe(0);

      const sampleUniformArm = await runCli(
        [
          "arm", "add",
          "--workspace", workspaceDir, "--principal", "sponsor-1", "--draft", draftId,
          "--arm", "sample-uniform",
          "--pinning", JSON.stringify({ harness: SOLVE_HARNESS_PINS["sample-uniform"] }),
        ],
        context,
      );
      expect(sampleUniformArm.exitCode).toBe(0);

      const quote = await runCli(
        ["quote", "--workspace", workspaceDir, "--principal", "sponsor-1", "--draft", draftId],
        context,
      );
      expect(quote.exitCode).toBe(0);
      // BP-20: human-mode quote output also renders the §4.6 presentation (run size, coverage,
      // hard cap) below the existing first line — no preview has run for this draft yet, so no
      // "estimated wall time" line should appear (never an invented estimate).
      expect(quote.stdout).toContain("run size: 6 solve + 6 evaluation = 12 cells");
      expect(quote.stdout).toContain("baseline: 3 solve + 3 evaluation");
      expect(quote.stdout).toContain("sample-uniform: 3 solve + 3 evaluation");
      expect(quote.stdout).toContain("coverage: supported keys");
      expect(quote.stdout).toContain("hard cap: not declared");
      expect(quote.stdout).not.toContain("estimated wall time");

      const lock = await runCli(
        ["lock", "--workspace", workspaceDir, "--principal", "sponsor-1", "--draft", draftId],
        context,
      );
      expect(lock.exitCode).toBe(0);

      // Nothing streams before launch — none of the verbs above wire onProgress.
      expect(progressLines).toHaveLength(0);

      const launch = await runCli(
        ["launch", "--workspace", workspaceDir, "--principal", "sponsor-1", "--draft", draftId],
        context,
      );
      expect(launch.exitCode).toBe(0);
      expect(launch.stdout).toBe(`launched draft ${draftId}: run complete\n`);
      expect(launch.stderr).toBe("");

      expect(progressLines.length).toBeGreaterThan(0);
      expect(progressLines.some((line) => line.includes("dispatch"))).toBe(true);
      expect(progressLines.some((line) => line.includes("judged"))).toBe(true);
    },
    120_000,
  );
});
