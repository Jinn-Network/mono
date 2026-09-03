/**
 * The seal-time sample-size advisory through `runCli` exactly as `bin.ts` calls it (issue #2978).
 *
 * The lock is irreversible, and until this gate it accepted any replicate and item count without
 * comment. The gate's whole value is that the width reaches the operator BEFORE the seal, so the
 * load-bearing assertions are that an unflagged lock refuses without sealing anything, that the
 * refusal itself carries the widths, and that the flagged lock seals the same numbers it printed.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { parseRun, readRunSampleSizeAdvisory } from "@jinn-network/benchmarking-records";
import { expectedIntervalWidth } from "../run/sample-size-advisory.js";
import { readRunState } from "../run/state.js";
import { getSealedBytes } from "../workspace/sealed-store.js";
import { runCli } from "./main.js";
import type { CliContext, CliResult } from "./result.js";

let workspaceDir: string;
let tick: number;

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "sample-size-cli-"));
  tick = 0;
});

afterEach(() => {
  rmSync(workspaceDir, { recursive: true, force: true });
});

function contextFor(progress?: (line: string) => void): CliContext {
  return {
    cwd: workspaceDir,
    clock: () => `2026-08-17T00:00:${String(tick++).padStart(2, "0")}Z`,
    ...(progress === undefined ? {} : { progress }),
  };
}

function base(): readonly string[] {
  return ["--workspace", workspaceDir, "--principal", "sponsor-1"];
}

interface JsonEnvelope<T> {
  readonly ok: boolean;
  readonly result?: T;
  readonly error?: { readonly code: string; readonly detail: string };
}

function parseJson<T>(stdout: string): JsonEnvelope<T> {
  return JSON.parse(stdout) as JsonEnvelope<T>;
}

/** `sample init` seeds three tasks, so a one-replicate draft locks at n = 3 per arm. */
const SAMPLED_TASKS = 3;

async function setUpQuotedDraft(context: CliContext, draftId = "advisory-draft"): Promise<void> {
  const run = async (argv: readonly string[]): Promise<CliResult> => {
    const result = await runCli([...argv, "--json"], context);
    if (result.exitCode !== 0) throw new Error(`${argv.join(" ")} failed: ${result.stdout}${result.stderr}`);
    return result;
  };
  await run(["init", ...base()]);
  await run(["draft", "create", ...base(), "--name", "Advisory Draft", "--id", draftId]);
  await run(["sample", "init", ...base(), "--draft", draftId]);
  await run([
    "arm", "add", ...base(), "--draft", draftId, "--arm", "baseline",
    "--pinning", JSON.stringify({ harness: { id: "prediction-v1-baseline", version: "1.0.0" } }),
  ]);
  await run([
    "arm", "add", ...base(), "--draft", draftId, "--arm", "sample",
    "--pinning", JSON.stringify({ harness: { id: "sample-uniform", version: "0.1.0" } }),
  ]);
  await run(["quote", ...base(), "--draft", draftId]);
}

describe("lock — the sample-size advisory gate", () => {
  test("refuses an unacknowledged lock and seals nothing", async () => {
    const context = contextFor();
    await setUpQuotedDraft(context);

    const refused = await runCli(["lock", ...base(), "--draft", "advisory-draft", "--json"], context);
    expect(refused.exitCode).toBe(2);
    expect(parseJson(refused.stdout).error?.code).toBe("invalid-invocation");
    // The draft is exactly where it was: the gate runs before anything irreversible.
    expect(readRunState(workspaceDir, "advisory-draft")?.runSha256).toBeUndefined();
  });

  test("the refusal itself carries the width at the declared n and at two reference sizes", async () => {
    const context = contextFor();
    await setUpQuotedDraft(context);

    const refused = await runCli(["lock", ...base(), "--draft", "advisory-draft", "--json"], context);
    const detail = parseJson(refused.stdout).error?.detail ?? "";
    for (const n of [SAMPLED_TASKS, SAMPLED_TASKS * 2, Math.max(1, Math.round(SAMPLED_TASKS / 2))]) {
      expect(detail).toContain(`n=${n}: interval width ${expectedIntervalWidth(n)}`);
    }
    expect(detail).toContain("--ack-sample-size");
  });

  test("acknowledging locks, prints the advisory, and seals the numbers it printed", async () => {
    const progress: string[] = [];
    const context = contextFor((line) => progress.push(line));
    await setUpQuotedDraft(context);

    const locked = await runCli(["lock", "--ack-sample-size", ...base(), "--draft", "advisory-draft"], context);
    expect(locked.exitCode, locked.stderr).toBe(0);
    // The width prints on stdout beside the digest it was sealed into, not on the progress
    // channel: `lock` streams nothing, which is what `cli-lifecycle.integration.test.ts` pins.
    expect(locked.stdout).toContain(`n=${SAMPLED_TASKS}: interval width ${expectedIntervalWidth(SAMPLED_TASKS)}`);
    expect(locked.stdout).toContain("locked draft advisory-draft");
    expect(progress).toEqual([]);

    const runSha256 = readRunState(workspaceDir, "advisory-draft")?.runSha256;
    expect(runSha256).toBeDefined();
    const record = parseRun(getSealedBytes(workspaceDir, runSha256!)) as unknown as Record<string, unknown>;
    expect(readRunSampleSizeAdvisory(record)).toEqual({
      n: SAMPLED_TASKS,
      expectedIntervalWidth: expectedIntervalWidth(SAMPLED_TASKS),
    });
  });

  test("the machine envelope carries the advisory too, so a scripted lock records what it accepted", async () => {
    const context = contextFor();
    await setUpQuotedDraft(context);

    const locked = await runCli(["lock", "--ack-sample-size", ...base(), "--draft", "advisory-draft", "--json"], context);
    expect(locked.exitCode).toBe(0);
    const body = parseJson<{ sampleSizeAdvisory: { n: number; expectedIntervalWidth: string } }>(locked.stdout);
    expect(body.result?.sampleSizeAdvisory.n).toBe(SAMPLED_TASKS);
    expect(body.result?.sampleSizeAdvisory.expectedIntervalWidth).toBe(expectedIntervalWidth(SAMPLED_TASKS));
  });

  test("a draft no lock could seal is refused by the lock, not by the advisory gate", async () => {
    const context = contextFor();
    await runCli(["init", ...base(), "--json"], context);
    await runCli(["draft", "create", ...base(), "--name", "Bare", "--id", "bare", "--json"], context);

    const refused = await runCli(["lock", ...base(), "--draft", "bare", "--json"], context);
    expect(refused.exitCode).not.toBe(0);
    expect(parseJson(refused.stdout).error?.code).toBe("illegal-transition");
  });
});
