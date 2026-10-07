// SPDX-License-Identifier: Apache-2.0

/**
 * The run plan of a draft on the official Terminal-Bench 2.1 slate, through the CLI (issue #4975).
 *
 * A claimant who brings a full slate with `run import --from harbor` can meet four limits: the
 * evidence cap, the run window, the replicate count and the Harbor version. Each used to be met
 * only at import, after the Harbor run had been paid for. These cases hold the three this verb
 * surface owns to the point before the run starts: `method` plans the replicates and a window that
 * fits them, `lock` says what the Harbor run must meet, and `run import` applies the Harbor
 * reader's own evidence cap.
 */

import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { parseRun } from "@jinn-network/benchmarking-records";
import { HARBOR_RUN_IMPORT_VERSIONS, harborRunImportEvidenceCap } from "../intake/harbor-run-records.js";
import { officialTerminalBench21TaskNames } from "../intake/terminal-bench-2-1.js";
import { EXTERNAL_IMPORT_MAX_AGGREGATE_BYTES } from "../run/external-import.js";
import {
  TERMINAL_BENCH_2_1_DATASET_ID,
  TERMINAL_BENCH_2_1_DATASET_REF,
} from "../runtime/terminal-bench-2-1/manifest.js";
import { getSealedBytes } from "../workspace/sealed-store.js";
import { runCli, USAGE } from "./main.js";
import type { CliContext, CliResult } from "./result.js";

const HARBOR_JOBS = fileURLToPath(
  new URL("../../test/fixtures/harbor-0.21-jobs-terminal-bench-2-1/jobs", import.meta.url),
);
/** The three official tasks the fixture holds trials for, all inside the ten-task slice. */
const FIXTURE_TASKS = ["adaptive-rejection-sampler", "cancel-async-tasks", "chess-best-move"] as const;
/** The lock must precede the fixture's earliest trial start (12:58:28Z) ... */
const BEFORE_THE_RUN = "2026-10-01T12:00:00.000Z";
/** ... and the import must follow its latest trial finish (13:39:36Z). */
const AFTER_THE_RUN = "2026-10-01T14:00:00.000Z";

const HOUR_MS = 3_600_000;
const HARBOR_DATASET = `${TERMINAL_BENCH_2_1_DATASET_ID}@${TERMINAL_BENCH_2_1_DATASET_REF}`;
const NOT_COMPARABLE = "A Terminal-Bench 2.1 run with fewer than 5 trials of each task is not leaderboard-comparable.";

let root: string;
let workspaceDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "slate-run-plan-"));
  workspaceDir = join(root, "ws");
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

/** A clock that starts at `at` and never repeats or runs backwards. */
function contextAt(at = BEFORE_THE_RUN): CliContext {
  let ms = Date.parse(at);
  return {
    cwd: root,
    clock: () => {
      const value = new Date(ms).toISOString();
      ms += 10;
      return value;
    },
  };
}

const base = (): readonly string[] => ["--workspace", workspaceDir, "--principal", "me"];

async function ok(argv: readonly string[], ctx: CliContext): Promise<CliResult> {
  const result = await runCli(argv, ctx);
  if (result.exitCode !== 0) throw new Error(`${argv.join(" ")} exited ${result.exitCode}: ${result.stdout}${result.stderr}`);
  return result;
}

interface Envelope {
  readonly ok: boolean;
  readonly result?: Record<string, any>;
  readonly error?: { readonly code: string; readonly detail: string; readonly issues?: readonly { readonly path: string }[] };
}

const envelope = (result: CliResult): Envelope => JSON.parse(result.stdout) as Envelope;

async function init(ctx: CliContext): Promise<void> {
  await ok(["init", ...base()], ctx);
}

async function createDraft(ctx: CliContext, draftId: string): Promise<void> {
  await ok(["draft", "create", ...base(), "--name", draftId, "--id", draftId], ctx);
}

async function updateDraft(ctx: CliContext, draftId: string, patch: unknown): Promise<void> {
  const patchPath = join(root, `${draftId}-patch.json`);
  writeFileSync(patchPath, JSON.stringify(patch));
  await ok(["draft", "update", ...base(), "--draft", draftId, "--file", patchPath], ctx);
}

/** The run plan a draft carries: its replicate count and its run window. */
async function runPlan(ctx: CliContext, draftId: string): Promise<{ replicates: number; closeAfterMs: number }> {
  const shown = envelope(await ok(["draft", "show", ...base(), "--draft", draftId, "--json"], ctx));
  const spec = shown.result!["draft"].spec;
  return { replicates: spec.replicates, closeAfterMs: spec.policy.closeAfterMs };
}

async function bind(ctx: CliContext, draftId: string, flags: readonly string[]): Promise<CliResult> {
  return runCli(["method", "terminal-bench-2.1", ...base(), "--draft", draftId, ...flags], ctx);
}

/** Two Harbor arms pinned the way `arm add --help` describes, then the quote `lock` requires. */
async function addArmsAndQuote(ctx: CliContext, draftId: string): Promise<void> {
  await ok(["arm", "add", ...base(), "--draft", draftId, "--arm", "terminus-2", "--pinning",
    JSON.stringify({ agent: { id: "terminus-2" }, model: { id: "openrouter/deepseek/deepseek-v4.1-flash" } })], ctx);
  await ok(["arm", "add", ...base(), "--draft", draftId, "--arm", "oracle", "--pinning", JSON.stringify({ agent: { id: "oracle" } })], ctx);
  await ok(["quote", ...base(), "--draft", draftId], ctx);
}

describe("method terminal-bench-2.1 plans the replicates and a run window that fits them", () => {
  test("one replicate stays the default, and ten tasks keep the 24 hour window", async () => {
    const ctx = contextAt();
    await init(ctx);
    await createDraft(ctx, "draft-1");
    const bound = await bind(ctx, "draft-1", ["--slice", "10"]);
    expect(bound.exitCode, bound.stderr).toBe(0);
    // 10 tasks x 1 replicate x 2 hours is 20 hours, under the 24 hour floor.
    expect(await runPlan(ctx, "draft-1")).toEqual({ replicates: 1, closeAfterMs: 24 * HOUR_MS });
  });

  test("--replicates sets the count, and the window is 2 hours for each task and replicate", async () => {
    const ctx = contextAt();
    await init(ctx);
    for (const [draftId, flags, expected] of [
      ["ten-by-two", ["--slice", "10", "--replicates", "2"], { replicates: 2, closeAfterMs: 40 * HOUR_MS }],
      ["all-by-one", ["--slice", "all"], { replicates: 1, closeAfterMs: 178 * HOUR_MS }],
      ["all-by-five", ["--slice", "all", "--replicates", "5"], { replicates: 5, closeAfterMs: 890 * HOUR_MS }],
      ["three-by-five", ["--ids", FIXTURE_TASKS.join(","), "--replicates", "5"], { replicates: 5, closeAfterMs: 30 * HOUR_MS }],
      ["first-twenty", ["--n", "20", "--replicates", "1"], { replicates: 1, closeAfterMs: 40 * HOUR_MS }],
    ] as const) {
      await createDraft(ctx, draftId);
      const bound = await bind(ctx, draftId, [...flags, "--json"]);
      expect(bound.exitCode, `${draftId}: ${bound.stdout}`).toBe(0);
      expect(await runPlan(ctx, draftId), draftId).toEqual(expected);
      // The bind's own envelope carries the draft as it now stands.
      const spec = envelope(bound).result!["draft"].spec;
      expect({ replicates: spec.replicates, closeAfterMs: spec.policy.closeAfterMs }, draftId).toEqual(expected);
    }
  }, 60_000);

  test("without the flag, a count the draft already carries is kept and sizes the window", async () => {
    const ctx = contextAt();
    await init(ctx);
    await createDraft(ctx, "draft-1");
    await updateDraft(ctx, "draft-1", { replicates: 3 });
    expect((await bind(ctx, "draft-1", ["--slice", "10"])).exitCode).toBe(0);
    expect(await runPlan(ctx, "draft-1")).toEqual({ replicates: 3, closeAfterMs: 60 * HOUR_MS });
  });

  test("a longer window the claimant already set is kept", async () => {
    const ctx = contextAt();
    await init(ctx);
    await createDraft(ctx, "draft-1");
    const sixtyDays = 60 * 24 * HOUR_MS;
    await updateDraft(ctx, "draft-1", {
      policy: { completenessFloor: "1", cellWindowMs: HOUR_MS, replacement: { allowed: false }, closeAfterMs: sixtyDays },
    });
    // The full slate at five replicates asks for 890 hours, which is about 37 days.
    expect((await bind(ctx, "draft-1", ["--slice", "all", "--replicates", "5"])).exitCode).toBe(0);
    expect(await runPlan(ctx, "draft-1")).toEqual({ replicates: 5, closeAfterMs: sixtyDays });
  });

  test("a shorter window is raised to one that fits", async () => {
    const ctx = contextAt();
    await init(ctx);
    await createDraft(ctx, "draft-1");
    await updateDraft(ctx, "draft-1", {
      policy: { completenessFloor: "1", cellWindowMs: HOUR_MS, replacement: { allowed: false }, closeAfterMs: HOUR_MS },
    });
    expect((await bind(ctx, "draft-1", ["--slice", "1"])).exitCode).toBe(0);
    expect(await runPlan(ctx, "draft-1")).toEqual({ replicates: 1, closeAfterMs: 24 * HOUR_MS });
  });

  test("lock seals the close time from that window", async () => {
    const ctx = contextAt();
    await init(ctx);
    await createDraft(ctx, "draft-1");
    expect((await bind(ctx, "draft-1", ["--slice", "10", "--replicates", "2"])).exitCode).toBe(0);
    await addArmsAndQuote(ctx, "draft-1");
    const locked = envelope(await ok(["lock", ...base(), "--draft", "draft-1", "--ack-sample-size", "--json"], ctx));
    const run = parseRun(getSealedBytes(workspaceDir, locked.result!["runSha256"] as string));
    expect(run.replicates).toBe(2);
    expect(run.closeAt).toBe(locked.result!["closeAt"]);
    // 40 hours after the instant the lock ran at. The clock moved a few ticks past its start.
    const lockedAfterStartMs = Date.parse(run.closeAt) - 40 * HOUR_MS - Date.parse(BEFORE_THE_RUN);
    expect(lockedAfterStartMs).toBeGreaterThanOrEqual(0);
    expect(lockedAfterStartMs).toBeLessThan(60_000);
  }, 60_000);
});

describe("--replicates is refused wherever the bind would not act on it", () => {
  test.each(["0", "01", "-1", "1.5", "five", ""])("a count of %j is not a positive integer", async (value) => {
    const ctx = contextAt();
    await init(ctx);
    await createDraft(ctx, "draft-1");
    const refused = await bind(ctx, "draft-1", ["--slice", "10", `--replicates=${value}`, "--json"]);
    expect(refused.exitCode).toBe(2);
    expect(envelope(refused).error).toMatchObject({ code: "invalid-invocation", detail: "--replicates must be a positive integer" });
    // Nothing was bound: the draft has no benchmark and its plan is untouched.
    const shown = envelope(await ok(["draft", "show", ...base(), "--draft", "draft-1", "--json"], ctx));
    expect(shown.result!["draft"].spec.taskSet).toEqual({ kind: "pendingSample" });
    expect(await runPlan(ctx, "draft-1")).toEqual({ replicates: 1, closeAfterMs: 24 * HOUR_MS });
  });

  test("a count too large for any run window is refused with the draft untouched", async () => {
    const ctx = contextAt();
    await init(ctx);
    await createDraft(ctx, "draft-1");
    const refused = await bind(ctx, "draft-1", ["--slice", "10", "--replicates", "999999999999", "--json"]);
    expect(refused.exitCode).toBe(1);
    expect(envelope(refused).error?.code).toBe("validation");
    const shown = envelope(await ok(["draft", "show", ...base(), "--draft", "draft-1", "--json"], ctx));
    expect(shown.result!["draft"].spec.taskSet).toEqual({ kind: "pendingSample" });
    // The same draft still binds.
    expect((await bind(ctx, "draft-1", ["--slice", "10", "--replicates", "2"])).exitCode).toBe(0);
  });

  test("another catalog id reads no count, so it refuses the flag by name", async () => {
    const ctx = contextAt();
    await init(ctx);
    await createDraft(ctx, "draft-1");
    writeFileSync(join(root, "host.json"), "{}");
    const refused = await runCli(
      ["method", "swe-bench-verified", ...base(), "--draft", "draft-1", "--slice", "1", "--host", "host.json", "--replicates", "5", "--json"],
      ctx,
    );
    expect(refused.exitCode).toBe(2);
    const error = envelope(refused).error!;
    expect(error.code).toBe("invalid-invocation");
    expect(error.issues?.[0]?.path).toBe("--replicates");
    expect(error.detail).toContain("only valid with the terminal-bench-2.1 catalog id");
    // Without the flag the same bind is accepted, so the flag alone was the refusal.
    const bound = await runCli(
      ["method", "swe-bench-verified", ...base(), "--draft", "draft-1", "--slice", "1", "--host", "host.json", "--json"],
      ctx,
    );
    expect(bound.exitCode, bound.stdout).toBe(0);
  });

  test("a method file is a complete document, so it refuses the flag too", async () => {
    const ctx = contextAt();
    await init(ctx);
    await createDraft(ctx, "draft-1");
    writeFileSync(join(root, "method.json"), JSON.stringify({ taskReference: "task.py@task" }));
    const refused = await runCli(["method", "method.json", ...base(), "--draft", "draft-1", "--replicates", "5", "--json"], ctx);
    expect(refused.exitCode).toBe(2);
    expect(envelope(refused).error?.issues?.[0]?.path).toBe("--replicates");
  });
});

describe("help names the replicate flag and the window", () => {
  test("USAGE and method --help carry --replicates, the default, the window and the five-trial line", async () => {
    expect(USAGE).toContain("[--replicates <n>]");
    const help = (await ok(["method", "--help"], contextAt())).stdout;
    expect(help).toContain("[--replicates <n>]");
    expect(help).toMatch(/--replicates <n>\s+planned trials of each task/u);
    expect(help).toContain("which is 1 on a new draft");
    expect(help).toContain("2 hours for each task and replicate");
    expect(help).toContain("never less than 24 hours");
    expect(help).toMatch(/Fewer than 5 is not\s+leaderboard-comparable/u);
  });

  test("anchor --help calls the endpoint an address, and says anchoring configure keeps https", async () => {
    const help = (await ok(["anchor", "--help"], contextAt())).stdout;
    expect(help).toContain("--endpoint is the address of the timestamp service to ask");
    expect(help).not.toContain("the https address of the timestamp service");
    expect(help).toContain("may\nbe http or https");
    expect(help).toContain("anchoring configure keeps an https address only");
  });

  test("arm add --help states the two-arm minimum", async () => {
    const help = (await ok(["arm", "add", "--help"], contextAt())).stdout;
    expect(help).toContain("A draft needs at least two arms");
  });
});

describe("lock on the official slate says what the Harbor run must meet", () => {
  async function quotedSlateDraft(ctx: CliContext, draftId: string, flags: readonly string[]): Promise<void> {
    await createDraft(ctx, draftId);
    expect((await bind(ctx, draftId, flags)).exitCode).toBe(0);
    await addArmsAndQuote(ctx, draftId);
  }

  test("under the receipt: the accepted version, retries off, the dataset pin and the attempts value", async () => {
    const ctx = contextAt();
    await init(ctx);
    await quotedSlateDraft(ctx, "draft-1", ["--slice", "10", "--replicates", "2"]);
    const locked = await ok(["lock", ...base(), "--draft", "draft-1", "--ack-sample-size"], ctx);
    const lines = locked.stdout.split("\n");
    const receipt = lines.findIndex((line) => /^locked draft draft-1: run [a-f0-9]{64}, closes \d{4}-/u.test(line));
    expect(receipt, locked.stdout).toBeGreaterThanOrEqual(0);
    expect(lines.slice(receipt + 1)).toEqual([
      "run import --from harbor accepts the Harbor run of this lock only when:",
      `  Harbor is version ${HARBOR_RUN_IMPORT_VERSIONS.join(" or ")}`,
      "  retries are off: harbor run --max-retries 0, which is Harbor's default",
      `  the dataset is the sealed revision: harbor run --dataset ${HARBOR_DATASET}`,
      "  each task has one trial for each replicate: harbor run --n-attempts 2",
      "  every trial starts after this lock and ends before the close time above",
      `This run plans 2 trials of each task. ${NOT_COMPARABLE}`,
      "",
    ]);
    // The version is the one the reader accepts today, spelled out so a change to the list is seen here.
    expect(locked.stdout).toContain("Harbor is version 0.21.0\n");
    expect(HARBOR_DATASET).toBe(
      "terminal-bench/terminal-bench-2-1@sha256:7d7bdc1cbedad549fc1140404bd4dc45e5fd0ea7c4186773687d177ad3a0699a",
    );
  }, 60_000);

  test("--json carries the same facts as values, and the sealed Run does not carry them", async () => {
    const ctx = contextAt();
    await init(ctx);
    await quotedSlateDraft(ctx, "draft-1", ["--slice", "10", "--replicates", "2"]);
    const locked = await ok(["lock", ...base(), "--draft", "draft-1", "--ack-sample-size", "--json"], ctx);
    expect(locked.stdout.split("\n").filter((line) => line.length > 0)).toHaveLength(1);
    const result = envelope(locked).result!;
    expect(result["harborRun"]).toEqual({
      harness: "harbor",
      versions: ["0.21.0"],
      maxRetries: 0,
      dataset: HARBOR_DATASET,
      attemptsPerTask: 2,
      leaderboardTrialsPerTask: 5,
    });
    // Advice about the run is not part of the pre-registration: the Run record names no Harbor
    // version and no flag.
    const sealed = new TextDecoder().decode(getSealedBytes(workspaceDir, result["runSha256"] as string));
    expect(sealed).not.toContain("0.21.0");
    expect(sealed).not.toContain("attempts");
    expect(sealed).not.toContain("leaderboard");
  }, 60_000);

  test("under five replicates, the refusal before the seal already says the run is not leaderboard-comparable", async () => {
    const ctx = contextAt();
    await init(ctx);
    await quotedSlateDraft(ctx, "draft-1", ["--slice", "10"]);
    const refused = await runCli(["lock", ...base(), "--draft", "draft-1", "--json"], ctx);
    expect(refused.exitCode).toBe(2);
    const detail = envelope(refused).error!.detail;
    expect(detail).toContain(`This run plans 1 trial of each task. ${NOT_COMPARABLE}`);
    expect(detail).toContain("bind a new draft with method terminal-bench-2.1 --replicates <n>");
    // The sample-size advisory and the way to acknowledge it are still there, in that order.
    expect(detail).toMatch(/n=10: interval width /u);
    expect(detail.indexOf("n=10: interval width ")).toBeLessThan(detail.indexOf(NOT_COMPARABLE));
    expect(detail.indexOf(NOT_COMPARABLE)).toBeLessThan(detail.indexOf("--ack-sample-size to seal at this n."));
    // Nothing was sealed.
    const shown = envelope(await ok(["draft", "show", ...base(), "--draft", "draft-1", "--json"], ctx));
    expect(shown.result!["draft"].state).toBe("quoted");
  }, 60_000);

  test("at five replicates neither the refusal nor the lock says anything about the leaderboard", async () => {
    const ctx = contextAt();
    await init(ctx);
    await quotedSlateDraft(ctx, "draft-1", ["--ids", FIXTURE_TASKS.join(","), "--replicates", "5"]);
    const refused = await runCli(["lock", ...base(), "--draft", "draft-1", "--json"], ctx);
    expect(refused.exitCode).toBe(2);
    expect(envelope(refused).error!.detail).not.toContain("leaderboard");
    const locked = await ok(["lock", ...base(), "--draft", "draft-1", "--ack-sample-size"], ctx);
    expect(locked.stdout).toContain("harbor run --n-attempts 5\n");
    expect(locked.stdout).not.toContain("leaderboard");
  }, 60_000);

  test("a draft that is not on the slate gets none of it", async () => {
    const ctx = contextAt();
    await init(ctx);
    /** The bundled sample benchmark, with its two venue arms, quoted. */
    const quotedSampleDraft = async (draftId: string): Promise<void> => {
      await createDraft(ctx, draftId);
      await ok(["sample", "init", ...base(), "--draft", draftId], ctx);
      await ok(["arm", "add", ...base(), "--draft", draftId, "--arm", "baseline", "--pinning", JSON.stringify({ harness: { id: "prediction-v1-baseline", version: "1.0.0" } })], ctx);
      await ok(["arm", "add", ...base(), "--draft", draftId, "--arm", "sample", "--pinning", JSON.stringify({ harness: { id: "sample-uniform", version: "0.1.0" } })], ctx);
      await ok(["quote", ...base(), "--draft", draftId], ctx);
    };

    await quotedSampleDraft("draft-1");
    const refused = await runCli(["lock", ...base(), "--draft", "draft-1", "--json"], ctx);
    expect(refused.exitCode).toBe(2);
    expect(envelope(refused).error!.detail).not.toContain("leaderboard");
    const locked = await ok(["lock", ...base(), "--draft", "draft-1", "--ack-sample-size", "--json"], ctx);
    expect(envelope(locked).result).not.toHaveProperty("harborRun");

    await quotedSampleDraft("draft-2");
    const human = await ok(["lock", ...base(), "--draft", "draft-2", "--ack-sample-size"], ctx);
    expect(human.stdout).not.toMatch(/harbor/iu);
    // The receipt is still the last line the lock itself prints.
    expect(human.stdout.trimEnd().split("\n").at(-1)).toMatch(/^locked draft draft-2: run [a-f0-9]{64}, closes /u);
  }, 120_000);
});

describe("run import --from harbor applies the Harbor reader's evidence cap", () => {
  /** Every trial directory under a jobs directory: `<jobs>/<job>/<trial>/`. */
  function trialDirs(jobsDir: string): string[] {
    return readdirSync(jobsDir).flatMap((job) => {
      const jobDir = join(jobsDir, job);
      return readdirSync(jobDir).map((entry) => join(jobDir, entry)).filter((path) => statSync(path).isDirectory());
    });
  }

  test("a run over 64 MiB of evidence imports when it is inside 4 MiB for each cell of the locked run", async () => {
    const before = contextAt(BEFORE_THE_RUN);
    await init(before);
    await createDraft(before, "draft-1");
    // Ten tasks by two arms is 20 cells, so the reader's cap is 80 MiB: above the 64 MiB default.
    expect((await bind(before, "draft-1", ["--slice", "10"])).exitCode).toBe(0);
    expect(officialTerminalBench21TaskNames().slice(0, 10)).toEqual(expect.arrayContaining([...FIXTURE_TASKS]));
    await addArmsAndQuote(before, "draft-1");
    await ok(["lock", ...base(), "--draft", "draft-1", "--ack-sample-size", "--no-anchor"], before);

    // The real jobs directory, with the recording and trajectory each of its six trials would
    // carry after a long agent run: twelve files of 5.6 MiB, 67.2 MiB in all. Each file is under
    // the 8 MiB cap on one evidence file.
    const jobsDir = join(root, "jobs");
    cpSync(HARBOR_JOBS, jobsDir, { recursive: true });
    const large = Buffer.alloc(Math.round(5.6 * 1024 * 1024), "a");
    const trials = trialDirs(jobsDir);
    expect(trials).toHaveLength(6);
    for (const trial of trials) {
      mkdirSync(join(trial, "agent"), { recursive: true });
      writeFileSync(join(trial, "agent", "recording.cast"), large);
      writeFileSync(join(trial, "agent", "trajectory.json"), large);
    }

    const imported = await runCli(
      ["run", "import", "--from", "harbor", jobsDir, ...base(), "--draft", "draft-1", "--json"],
      contextAt(AFTER_THE_RUN),
    );
    expect(imported.exitCode, imported.stdout.slice(0, 2_000)).toBe(0);
    const result = envelope(imported).result!;
    expect(result["written"]).toEqual({ graded: 6, ungradeable: 0, notDelivered: 14 });
    expect(result["evidenceBytes"]).toBeGreaterThan(EXTERNAL_IMPORT_MAX_AGGREGATE_BYTES);
    expect(result["evidenceBytes"]).toBeLessThan(harborRunImportEvidenceCap(20));
  }, 120_000);
});
