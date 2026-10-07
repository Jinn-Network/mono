// SPDX-License-Identifier: Apache-2.0

/**
 * The claimant path on the official Terminal-Bench 2.1 slate, driven end to end through the CLI
 * (#4937).
 *
 * Every step of this path had a test, and each used its own stand-in: the catalog method was
 * tested up to the lock, the Harbor reader against a hand-built name table, and import against the
 * bundled sample tasks. The slate `method terminal-bench-2.1` binds and the jobs directory a real
 * Harbor 0.21 run writes never met in one test, so the reader refused every draft the method
 * produced and nothing caught it.
 *
 * This test is that meeting. It types the commands a claimant types, in order, against a temp
 * workspace and the real Harbor 0.21.0 jobs directory under
 * `test/fixtures/harbor-0.21-jobs-terminal-bench-2-1/`. It is hermetic: no network, no Docker, no
 * model, and no venue beyond what `quote` reads from the local machine.
 *
 * To extend the path, append to `CLAIMANT_STEPS`: each step is one CLI invocation at a fixed
 * instant, and `beforeAll` runs the list once, stopping at the first failure.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { runCli } from "../cli/main.js";
import type { CliContext, CliResult } from "../cli/result.js";
import { readDraftDocument } from "../operations/drafts.js";
import { ExternalRunImportDeclarationSchema } from "../run/external-import.js";
import { getSealedBytes } from "../workspace/sealed-store.js";

const HARBOR_JOBS = fileURLToPath(
  new URL("../../test/fixtures/harbor-0.21-jobs-terminal-bench-2-1/jobs", import.meta.url),
);

const PRINCIPAL = "claimant";
const DRAFT = "draft-1";
/** The three official tasks the fixture holds trials for. */
const TASKS = ["adaptive-rejection-sampler", "cancel-async-tasks", "chess-best-move"] as const;
/** The two Harbor jobs in the fixture, as the arms a claimant declares for them. */
const TERMINUS_PINNING = {
  agent: { id: "terminus-2", version: "2.0.0" },
  model: { id: "openrouter/deepseek/deepseek-v4.1-flash" },
};
const ORACLE_PINNING = { agent: { id: "oracle", version: "1.0.0" } };

/** The lock must precede the fixture's earliest trial start (12:58:28Z) ... */
const BEFORE_THE_RUN = "2026-10-01T12:00:00.000Z";
/** ... and the import must follow its latest trial finish (13:39:36Z). */
const AFTER_THE_RUN = "2026-10-01T14:00:00.000Z";

interface ClaimantPaths {
  readonly workspaceDir: string;
  readonly hostPath: string;
}

interface ClaimantStep {
  readonly name: string;
  /** The instant the command runs at. */
  readonly at: string;
  readonly argv: (paths: ClaimantPaths) => readonly string[];
}

function onDraft(paths: ClaimantPaths): readonly string[] {
  return ["--workspace", paths.workspaceDir, "--principal", PRINCIPAL, "--draft", DRAFT, "--json"];
}

/** The claimant's commands, in the order they are typed. */
const CLAIMANT_STEPS: readonly ClaimantStep[] = [
  {
    name: "init",
    at: BEFORE_THE_RUN,
    argv: (paths) => ["init", "--workspace", paths.workspaceDir, "--principal", PRINCIPAL, "--json"],
  },
  {
    name: "draft create",
    at: BEFORE_THE_RUN,
    argv: (paths) => [
      "draft", "create", "--workspace", paths.workspaceDir, "--principal", PRINCIPAL,
      "--name", "Terminal-Bench 2.1, brought from Harbor", "--id", DRAFT, "--json",
    ],
  },
  {
    name: "method terminal-bench-2.1",
    at: BEFORE_THE_RUN,
    argv: (paths) => [
      "method", "terminal-bench-2.1", ...onDraft(paths), "--ids", TASKS.join(","), "--host", paths.hostPath,
    ],
  },
  {
    name: "arm add terminus-2",
    at: BEFORE_THE_RUN,
    argv: (paths) => [
      "arm", "add", ...onDraft(paths), "--arm", "terminus-2", "--pinning", JSON.stringify(TERMINUS_PINNING),
    ],
  },
  {
    name: "arm add oracle",
    at: BEFORE_THE_RUN,
    argv: (paths) => ["arm", "add", ...onDraft(paths), "--arm", "oracle", "--pinning", JSON.stringify(ORACLE_PINNING)],
  },
  { name: "quote", at: BEFORE_THE_RUN, argv: (paths) => ["quote", ...onDraft(paths)] },
  {
    name: "lock",
    at: BEFORE_THE_RUN,
    argv: (paths) => ["lock", ...onDraft(paths), "--ack-sample-size", "--no-anchor"],
  },
  {
    name: "run import --from harbor",
    at: AFTER_THE_RUN,
    argv: (paths) => ["run", "import", "--from", "harbor", HARBOR_JOBS, ...onDraft(paths)],
  },
];

let root: string;
let paths: ClaimantPaths;
const ran = new Map<string, CliResult>();

/** A clock that starts at `at` and never repeats or runs backwards within one command. */
function clockAt(at: string): () => string {
  let ms = Date.parse(at);
  return () => {
    const value = new Date(ms).toISOString();
    ms += 10;
    return value;
  };
}

function resultOf(step: string): Record<string, any> {
  const result = ran.get(step);
  if (result === undefined) throw new Error(`the claimant path never reached "${step}"`);
  const envelope = JSON.parse(result.stdout) as { ok: boolean; result?: Record<string, any> };
  if (!envelope.ok || envelope.result === undefined) throw new Error(`"${step}" did not succeed: ${result.stdout}`);
  return envelope.result;
}

function sealedJson(sha256: string): Record<string, any> {
  return JSON.parse(new TextDecoder().decode(getSealedBytes(paths.workspaceDir, sha256))) as Record<string, any>;
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "bp-claimant-path-tb21-"));
  paths = { workspaceDir: join(root, "ws"), hostPath: join(root, "host.json") };
  writeFileSync(paths.hostPath, "{}");
  for (const step of CLAIMANT_STEPS) {
    const context: CliContext = { cwd: root, clock: clockAt(step.at) };
    const result = await runCli([...step.argv(paths)], context);
    ran.set(step.name, result);
    if (result.exitCode !== 0) break;
  }
}, 120_000);

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("claimant path: method terminal-bench-2.1 to an imported Harbor 0.21 run", () => {
  test.each(CLAIMANT_STEPS.map((step) => step.name))("%s exits 0", (name) => {
    const result = ran.get(name);
    expect(result, `the path stopped before "${name}"`).toBeDefined();
    expect(result!.exitCode, result!.stdout + result!.stderr).toBe(0);
  });

  test("the catalog method binds the official slate and the lock seals a Run on it", () => {
    expect(resultOf("method terminal-bench-2.1")).toMatchObject({ catalogId: "terminal-bench-2.1", official: true });
    expect(resultOf("lock")["runSha256"]).toMatch(/^[a-f0-9]{64}$/u);
  });

  test("the Harbor jobs directory imports onto the locked slate, every cell graded", () => {
    expect(resultOf("run import --from harbor")).toMatchObject({
      importedCellCount: 6,
      written: { graded: 6, ungradeable: 0, notDelivered: 0 },
    });
    expect(readDraftDocument(paths.workspaceDir, DRAFT).state).toBe("running");
  });

  test("each imported cell is graded from its Harbor trial's raw reward", () => {
    const declaration = ExternalRunImportDeclarationSchema.parse(
      sealedJson(resultOf("run import --from harbor")["declarationSha256"] as string),
    );
    expect(declaration.source).toEqual({ harness: "harbor", version: "0.21.0" });
    const classified = Object.fromEntries(declaration.rows.map((row) => {
      const [taskSha256, armId] = row.cellKey.split("/") as [string, string];
      const taskName = sealedJson(taskSha256)["payload"]["taskName"] as string;
      return [`${armId}: ${taskName}`, row.reason === undefined ? row.outcome : `${row.outcome} (${row.reason})`];
    }));
    // Each official Task seals an EvaluationSpec that declares Harbor's `reward`, so a finished
    // trial whose result carries that reward is graded by it. That includes the terminus-2 trial
    // of chess-best-move, which ran to `AgentTimeoutError` and still has a reward of 0.
    expect(classified).toEqual({
      "oracle: adaptive-rejection-sampler": "graded",
      "oracle: cancel-async-tasks": "graded",
      "oracle: chess-best-move": "graded",
      "terminus-2: adaptive-rejection-sampler": "graded",
      "terminus-2: cancel-async-tasks": "graded",
      "terminus-2: chess-best-move": "graded",
    });
    const evidenced = declaration.rows.filter((row) => row.evidence !== undefined);
    expect(evidenced).toHaveLength(6);
    for (const row of evidenced) {
      expect(row.evidence!.map((file) => file.name)).toEqual(["trial-result.json", "trial-config.json", "reward.txt"]);
    }
  });
});
