// SPDX-License-Identifier: Apache-2.0

/**
 * An analysis beyond the per-arm rate, on the official Terminal-Bench 2.1 slate, through the CLI.
 *
 * A draft's `analysis` has no flag of its own: the one way to set it is `draft update --file`. On
 * the official slate this version reports the per-arm pass rate only, so a draft that asks for a
 * paired comparison must be told before its Run is sealed, not after the run is paid for.
 *
 * `lock` and `quote` run the same compilation, and `lock` needs a quote of the draft as it stands.
 * So the claimant meets the refusal at `quote`, the step `lock` requires, and `lock` stays
 * refused: the draft cannot reach a sealed Run while it carries the analysis.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { BENCHMARKING_METHOD_IDS, BENCHMARKING_METHOD_VERSION } from "@jinn-network/benchmarking-records";
import { runCli } from "./main.js";
import type { CliContext, CliResult } from "./result.js";

let root: string;
let workspaceDir: string;
let tick: number;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "slate-analysis-"));
  workspaceDir = join(root, "ws");
  tick = 0;
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

function context(): CliContext {
  return {
    cwd: root,
    clock: () => new Date(Date.parse("2026-10-01T00:00:00.000Z") + 1000 * tick++).toISOString(),
  };
}

const base = (): readonly string[] => ["--workspace", workspaceDir, "--principal", "me"];

async function ok(argv: readonly string[], ctx: CliContext): Promise<CliResult> {
  const result = await runCli(argv, ctx);
  if (result.exitCode !== 0) throw new Error(`${argv.join(" ")} exited ${result.exitCode}: ${result.stdout}${result.stderr}`);
  return result;
}

const REFUSAL = "this version reports a run on the official Terminal-Bench 2.1 slate with the per-arm pass rate only, "
  + `and this draft selects "${BENCHMARKING_METHOD_IDS.pairedDelta}"; set the draft's analysis to `
  + `"${BENCHMARKING_METHOD_IDS.wilson}" version "${BENCHMARKING_METHOD_VERSION}", which is the per-arm rate`;

describe("a paired analysis on the official Terminal-Bench 2.1 slate", () => {
  test("set by draft update --file, is refused at quote, and the draft cannot lock", async () => {
    const ctx = context();
    await ok(["init", ...base()], ctx);
    await ok(["draft", "create", ...base(), "--name", "tb21", "--id", "draft-1"], ctx);
    await ok(["method", "terminal-bench-2.1", ...base(), "--draft", "draft-1", "--slice", "10"], ctx);
    await ok(["arm", "add", ...base(), "--draft", "draft-1", "--arm", "terminus-2", "--pinning", JSON.stringify({ agent: { id: "terminus-2" }, model: { id: "provider/model-x" } })], ctx);
    await ok(["arm", "add", ...base(), "--draft", "draft-1", "--arm", "oracle", "--pinning", JSON.stringify({ agent: { id: "oracle" } })], ctx);
    // Quoted as it stands, with no analysis: this draft could lock.
    await ok(["quote", ...base(), "--draft", "draft-1"], ctx);

    const patchPath = join(root, "paired.json");
    writeFileSync(patchPath, JSON.stringify({
      analysis: {
        method: BENCHMARKING_METHOD_IDS.pairedDelta,
        version: BENCHMARKING_METHOD_VERSION,
        baseline: "oracle",
        candidate: "terminus-2",
        parameters: { seed: 123456789, resamples: 1000, alpha: "0.05" },
      },
    }));
    await ok(["draft", "update", ...base(), "--draft", "draft-1", "--file", patchPath], ctx);

    // The patch moved the spec, so the earlier quote no longer covers the draft and `lock` refuses.
    const lockedStale = await runCli(["lock", ...base(), "--draft", "draft-1", "--ack-sample-size", "--json"], ctx);
    expect(lockedStale.exitCode).toBe(1);

    // The quote `lock` asks for is where the claimant is told why.
    const quoted = await runCli(["quote", ...base(), "--draft", "draft-1", "--json"], ctx);
    expect(quoted.exitCode).toBe(1);
    const envelope = JSON.parse(quoted.stdout) as { ok: boolean; error: { code: string; detail: string; issues: { path: string }[] } };
    expect(envelope.ok).toBe(false);
    expect(envelope.error.code).toBe("validation");
    expect(envelope.error.detail).toBe(REFUSAL);
    expect(envelope.error.issues[0]?.path).toBe("spec.analysis");
    const human = await runCli(["quote", ...base(), "--draft", "draft-1"], ctx);
    expect(human.exitCode).toBe(1);
    expect(human.stdout + human.stderr).toContain(REFUSAL);

    // Still no quote of the draft as it stands, so still no lock, and no Run was sealed.
    const locked = await runCli(["lock", ...base(), "--draft", "draft-1", "--ack-sample-size", "--json"], ctx);
    expect(locked.exitCode).toBe(1);
    const shown = JSON.parse((await ok(["draft", "show", ...base(), "--draft", "draft-1", "--json"], ctx)).stdout) as {
      result: { draft: { state: string } };
    };
    expect(shown.result.draft.state).not.toBe("locked");

    // The refusal names the way back, and it works: `draft update` cannot remove a field, and the
    // explicit per-arm selection seals the same plan as no selection.
    writeFileSync(patchPath, JSON.stringify({
      analysis: { method: BENCHMARKING_METHOD_IDS.wilson, version: BENCHMARKING_METHOD_VERSION },
    }));
    await ok(["draft", "update", ...base(), "--draft", "draft-1", "--file", patchPath], ctx);
    await ok(["quote", ...base(), "--draft", "draft-1"], ctx);
    const relocked = await ok(["lock", ...base(), "--draft", "draft-1", "--ack-sample-size"], ctx);
    expect(relocked.stdout).toMatch(/locked draft draft-1: run [a-f0-9]{64}, closes /u);
  }, 120_000);
});
