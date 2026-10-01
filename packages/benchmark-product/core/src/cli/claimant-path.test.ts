/**
 * The claimant path a stranger follows to bring a finished run (issues #4943, #4944, #4945, #4946,
 * #4947, #4949, #4951, #4953, found by the pre-publish rehearsal).
 *
 * Every case here is a place the rehearsal's walker was stopped or misled by help text: the first
 * documented command needed a workspace nothing said how to create, `method --help` described the
 * service's launch path, `--host` was mandatory and unread, `quote` read as a failure, and `anchor`
 * named no accepted provider. The walk at the end is the proof that the published order reaches a
 * locked draft without a refusal.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { PRODUCIBLE_ANCHOR_PROFILES } from "../anchor/profiles.js";
import { officialTerminalBench21TaskNames } from "../intake/terminal-bench-2-1.js";
import {
  TERMINAL_BENCH_2_1_DATASET_ID,
  TERMINAL_BENCH_2_1_DATASET_REF,
} from "../runtime/terminal-bench-2-1/manifest.js";
import { CLAIMANT_COMMAND_PATH, renderClaimantCommandPath } from "./claimant-path.js";
import { CLI_VERB_NAMES, runCli } from "./main.js";
import type { CliContext, CliResult } from "./result.js";

let root: string;
let workspaceDir: string;
let tick: number;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "claimant-path-"));
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

function base(): readonly string[] {
  return ["--workspace", workspaceDir, "--principal", "me"];
}

async function ok(argv: readonly string[], ctx: CliContext): Promise<CliResult> {
  const result = await runCli(argv, ctx);
  if (result.exitCode !== 0) throw new Error(`${argv.join(" ")} exited ${result.exitCode}: ${result.stdout}${result.stderr}`);
  return result;
}

/** A Harbor arm pinned the way `arm add --help` describes: the agent and the model, by id. */
function harborPinning(agent: string, model?: string): string {
  return JSON.stringify({ agent: { id: agent }, ...(model === undefined ? {} : { model: { id: model } }) });
}

describe("the exported claimant command path", () => {
  test("is the order a brought run needs, with anchor the only optional step", () => {
    expect(CLAIMANT_COMMAND_PATH.map((step) => step.verb)).toEqual([
      "init", "draft create", "method", "arm add", "quote", "lock", "anchor", "run import", "collect", "report", "publish",
    ]);
    expect(CLAIMANT_COMMAND_PATH.filter((step) => step.optional).map((step) => step.verb)).toEqual(["anchor"]);
    expect(renderClaimantCommandPath()).toBe(
      "init, draft create, method, arm add, quote, lock, [anchor], run import, collect, report, publish",
    );
  });

  test("names only verbs the CLI dispatches", () => {
    for (const step of CLAIMANT_COMMAND_PATH) expect(CLI_VERB_NAMES, step.verb).toContain(step.verb);
  });
});

describe("method --help describes a brought run", () => {
  test("lists the claimant path in order and no longer sends the claimant to doctor or launch", async () => {
    const help = (await ok(["method", "--help"], context())).stdout;
    expect(help).toContain(renderClaimantCommandPath());
    expect(help).toContain("quote is required before lock today");
    expect(help).not.toMatch(/\bdoctor\b/u);
    expect(help).not.toMatch(/\blaunch\b/u);
  });

  test("says where --workspace, --principal and --draft come from", async () => {
    const help = (await ok(["method", "--help"], context())).stdout;
    expect(help).toMatch(/--workspace[^\n]*init/u);
    expect(help).toMatch(/--draft[^\n]*draft create/u);
  });

  test("marks --host optional for the one catalog id that reads nothing from it, and says what --n reads", async () => {
    const help = (await ok(["method", "--help"], context())).stdout;
    const row = help.slice(help.indexOf("  terminal-bench-2.1\n"), help.indexOf("  terminal-bench-3.0\n"));
    expect(row).toContain("--host: optional");
    expect(row).not.toContain("hostKeys");
    expect(help.slice(help.indexOf("  terminal-bench-3.0\n"))).toContain("hostKeys: executable, registryMetadataPath");
    expect(help).toMatch(/registryMetadataPath[^\n]*\n[^\n]*--n/u);
  });
});

describe("refusals and verb help name what a claimant must supply", () => {
  test("a missing --workspace names init", async () => {
    const refused = await runCli(["method", "terminal-bench-2.1"], context());
    expect(refused.exitCode).toBe(2);
    expect(refused.stderr).toContain("--workspace is required");
    expect(refused.stderr).toContain("init --workspace <dir> --principal <id>");
  });

  test("arm add --help says how the Harbor reader matches an arm and that pinnings must differ", async () => {
    const help = (await ok(["arm", "add", "--help"], context())).stdout;
    expect(help).toContain("--arm <armId> (--pinning <json> | --agent <agentId>)");
    expect(help).toContain("run import --from harbor");
    expect(help).toContain("the arm id equals the Harbor agent name");
    expect(help).toContain("pinning.agent.id");
    expect(help).toContain("pinning.model.id");
    expect(help).toContain("pairwise distinct");
  });

  test("anchor --help lists every accepted provider value and says an endpoint must be supplied", async () => {
    const help = (await ok(["anchor", "--help"], context())).stdout;
    expect(help).toContain("--subject lock|matrix [--provider <profileUri>] [--endpoint <url>]");
    for (const profile of PRODUCIBLE_ANCHOR_PROFILES) expect(help).toContain(profile);
    expect(help).toContain("an endpoint must be supplied");
    expect(help).toContain("before run import");
  });

  test("quote --help says it is required before lock today", async () => {
    const help = (await ok(["quote", "--help"], context())).stdout;
    expect(help).toContain("Required before lock today");
  });
});

describe("the published order reaches a locked official slate without a refusal", () => {
  test("init, draft create, method (no --host), arm add, quote, lock", async () => {
    const ctx = context();
    await ok(["init", ...base()], ctx);
    await ok(["draft", "create", ...base(), "--name", "tb21", "--id", "draft-1"], ctx);

    const bound = await ok(["method", "terminal-bench-2.1", ...base(), "--draft", "draft-1", "--slice", "10"], ctx);
    expect(bound.stdout).toMatch(/^bound official terminal-bench-2\.1 method [a-f0-9]{64} for draft draft-1\n$/u);
    // Issue #4949: the host file never reached the sealed method, so leaving it out seals the same
    // Benchmark as supplying one.
    writeFileSync(join(root, "host.json"), JSON.stringify({ executable: "/usr/local/bin/harbor" }));
    await ok(["draft", "create", ...base(), "--name", "with host", "--id", "draft-2"], ctx);
    const withHost = await ok(
      ["method", "terminal-bench-2.1", ...base(), "--draft", "draft-2", "--slice", "10", "--host", "host.json"],
      ctx,
    );
    expect(withHost.stdout.replace("draft-2", "draft-1")).toBe(bound.stdout);

    await ok(["arm", "add", ...base(), "--draft", "draft-1", "--arm", "terminus-2", "--pinning", harborPinning("terminus-2", "provider/model-x")], ctx);
    await ok(["arm", "add", ...base(), "--draft", "draft-1", "--arm", "oracle", "--pinning", harborPinning("oracle")], ctx);

    // Issue #4947: this output reads as a failure and comes straight before an irreversible lock.
    const quoted = await ok(["quote", ...base(), "--draft", "draft-1"], ctx);
    expect(quoted.stdout).toContain("quoted draft draft-1: 20 cells, ok=false");
    expect(quoted.stdout).toContain("unsupported-requirement: arm terminus-2:");
    expect(quoted.stdout).toContain("the local venue");
    expect(quoted.stdout).toContain("do not block lock");
    expect(quoted.stdout).toContain("run import");

    // `ok` keeps its meaning and the machine envelope carries no prose: only the human rendering
    // gained the note.
    const quotedJson = JSON.parse((await ok(["quote", ...base(), "--draft", "draft-1", "--json"], ctx)).stdout) as {
      result: { quote: { ok: boolean; errors: { code: string }[] } };
    };
    expect(quotedJson.result.quote.ok).toBe(false);
    expect(quotedJson.result.quote.errors.every((error) => error.code === "unsupported-requirement")).toBe(true);

    const locked = await ok(["lock", ...base(), "--draft", "draft-1", "--ack-sample-size"], ctx);
    expect(locked.stdout).toMatch(/locked draft draft-1: run [a-f0-9]{64}, closes /u);
  }, 120_000);

  test("a quote the venue accepts carries no venue note", async () => {
    const ctx = context();
    await ok(["init", ...base()], ctx);
    await ok(["draft", "create", ...base(), "--name", "sample", "--id", "draft-1"], ctx);
    await ok(["sample", "init", ...base(), "--draft", "draft-1"], ctx);
    await ok(["arm", "add", ...base(), "--draft", "draft-1", "--arm", "baseline", "--pinning", JSON.stringify({ harness: { id: "prediction-v1-baseline", version: "1.0.0" } })], ctx);
    await ok(["arm", "add", ...base(), "--draft", "draft-1", "--arm", "sample", "--pinning", JSON.stringify({ harness: { id: "sample-uniform", version: "0.1.0" } })], ctx);
    const quoted = await ok(["quote", ...base(), "--draft", "draft-1"], ctx);
    expect(quoted.stdout).toContain("ok=true");
    expect(quoted.stdout).not.toContain("the local venue");
  }, 120_000);
});

describe("inspect prints what Harbor needs for an official slate (issue #4953)", () => {
  test("the dataset pin and the task names in Harbor's own form, without opening sealed records", async () => {
    const ctx = context();
    await ok(["init", ...base()], ctx);
    await ok(["draft", "create", ...base(), "--name", "tb21", "--id", "draft-1"], ctx);
    await ok(["method", "terminal-bench-2.1", ...base(), "--draft", "draft-1", "--slice", "10"], ctx);

    const inspected = JSON.parse((await ok(["inspect", ...base(), "--draft", "draft-1", "--json"], ctx)).stdout) as {
      result: { inspection: { benchmark: { itemCount: number; officialSlate?: Record<string, unknown> } } };
    };
    const { benchmark } = inspected.result.inspection;
    expect(benchmark.itemCount).toBe(10);
    // Verbatim what a Harbor 0.21 job config records for this slate (`datasets[0].name`, `.ref`,
    // `.task_names`), so the values can be pasted into a Harbor command as they are.
    expect(benchmark.officialSlate).toEqual({
      protocol: "terminal-bench-2.1",
      datasetId: TERMINAL_BENCH_2_1_DATASET_ID,
      datasetRevision: TERMINAL_BENCH_2_1_DATASET_REF,
      harborDataset: "terminal-bench/terminal-bench-2-1@sha256:7d7bdc1cbedad549fc1140404bd4dc45e5fd0ea7c4186773687d177ad3a0699a",
      harborTaskNames: [
        "terminal-bench/adaptive-rejection-sampler",
        "terminal-bench/bn-fit-modify",
        "terminal-bench/break-filter-js-from-html",
        "terminal-bench/build-cython-ext",
        "terminal-bench/build-pmars",
        "terminal-bench/build-pov-ray",
        "terminal-bench/caffe-cifar-10",
        "terminal-bench/cancel-async-tasks",
        "terminal-bench/chess-best-move",
        "terminal-bench/circuit-fibsqrt",
      ],
    });
    expect((benchmark.officialSlate?.harborTaskNames as string[]).map((name) => name.split("/")[1]))
      .toEqual(officialTerminalBench21TaskNames().slice(0, 10));

    // The human rendering is the same document, so the names are there without `--json` too.
    const human = (await ok(["inspect", ...base(), "--draft", "draft-1"], ctx)).stdout;
    expect(human).toContain('"terminal-bench/chess-best-move"');
  }, 60_000);

  test("a benchmark that is not an official slate carries no Harbor names", async () => {
    const ctx = context();
    await ok(["init", ...base()], ctx);
    await ok(["draft", "create", ...base(), "--name", "sample", "--id", "draft-1"], ctx);
    await ok(["sample", "init", ...base(), "--draft", "draft-1"], ctx);
    const inspected = JSON.parse((await ok(["inspect", ...base(), "--draft", "draft-1", "--json"], ctx)).stdout) as {
      result: { inspection: { benchmark: Record<string, unknown> } };
    };
    expect(inspected.result.inspection.benchmark).not.toHaveProperty("officialSlate");
  }, 60_000);
});
