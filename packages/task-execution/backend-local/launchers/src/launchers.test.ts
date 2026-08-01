import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { claudeCodeLauncher, codexLauncher, cursorLauncher, hermesLauncher, interpretResult, predictionV1BaselineLauncher } from "./index.js";
import type { AttemptIdentity } from "@jinn-network/task-execution-supervisor";
import type { TaskView, WorkspacePaths } from "@jinn-network/task-execution-workspace";

const view = { task: { instructions: "do the work", outputs: [] }, effectiveRequirements: {}, profile: { profile: "https://jinn.network/task-profiles/repository-work/1.0" } } as unknown as TaskView;
const paths = { work: "/attempt/work", input: "/attempt/input", harnessState: "/attempt/harness-state", secrets: "/attempt/secrets", out: "/attempt/out", root: "/attempt", logs: "/attempt/logs", tmp: "/attempt/tmp", meta: "/attempt/meta" } as WorkspacePaths;
const attempt = { attemptUri: "urn:uuid:00000000-0000-0000-0000-000000000001", nonce: "n", attemptNumber: 1 } as AttemptIdentity;

const scratchRoots: string[] = [];
afterEach(() => {
  for (const root of scratchRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("v1 launchers", () => {
  for (const launcher of [claudeCodeLauncher, codexLauncher, hermesLauncher, cursorLauncher, predictionV1BaselineLauncher]) {
    it(`${launcher.id} plans deterministically and hermetically`, () => {
      const first = launcher.plan(view, paths, attempt);
      process.env.OPENROUTER_API_KEY = "ambient-secret";
      expect(launcher.plan(view, paths, attempt)).toEqual(first);
      expect(Object.values(first.env).join(" ")).not.toContain("ambient-secret");
      expect(first.cwd).toBe(paths.work);
    });
  }

  it("declares every plan's secret forwards statically", () => {
    expect(hermesLauncher.capabilities().secretForwards).toEqual([
      { grantKey: "openrouter-api-key", target: "openrouter-api-key" },
    ]);
    expect(hermesLauncher.plan(view, paths, attempt).secretForwards).toEqual(
      hermesLauncher.capabilities().secretForwards,
    );
    for (const launcher of [claudeCodeLauncher, codexLauncher, cursorLauncher, predictionV1BaselineLauncher]) {
      expect(launcher.capabilities().secretForwards).toEqual([]);
      expect(launcher.plan(view, paths, attempt).secretForwards).toEqual([]);
    }
  });

  it("uses the exit record over a lying success envelope and preserves resumable limits", () => {
    const plan = claudeCodeLauncher.plan(view, paths, attempt);
    expect(interpretResult(plan, { exitCode: 1 }, { subtype: "success" }).state).toBe("failed");
    expect(interpretResult(plan, { exitCode: 0 }, { subtype: "error_max_turns" })).toMatchObject({ state: "delivered", outcome: "partial", recoveryAdvice: "resume-with-session" });
    expect(interpretResult(plan, { exitCode: 0 }).outcome).toBe("fulfilled");
  });

  // E42: daemon-harness e2e posts probabilityYes as a decimal string ('0.75'), matching
  // PredictionV1TaskSchema / the in-process PredictionV1BaselineImpl. Requiring typeof ===
  // 'number' made the launcher exit 2 → backend-terminal → delivery-wait-failed.
  it("prediction-v1-baseline accepts string probabilityYes from a legacy SignedTaskV1 input", () => {
    const root = mkdtempSync(join(tmpdir(), "jinn-pred-baseline-"));
    scratchRoots.push(root);
    const inputDir = join(root, "input");
    const outDir = join(root, "out");
    const workDir = join(root, "work");
    mkdirSync(inputDir, { recursive: true });
    mkdirSync(outDir, { recursive: true });
    mkdirSync(workDir, { recursive: true });
    writeFileSync(
      join(inputDir, "legacy-signed-task-v1.json"),
      JSON.stringify({
        schemaVersion: "task.v1",
        spec: {
          consensusSnapshot: { probabilityYes: "0.75", source: "polymarket-clob" },
          source: { url: "https://polymarket.com/event/fixture" },
        },
      }),
    );

    const plan = predictionV1BaselineLauncher.plan(
      view,
      { ...paths, input: inputDir, out: outDir, work: workDir, root },
      attempt,
    );
    const result = spawnSync(plan.argv[0]!, plan.argv.slice(1), {
      cwd: plan.cwd,
      env: { ...process.env, ...plan.env },
      encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(0);
    const solution = JSON.parse(readFileSync(join(outDir, "prediction-v1-solution.json"), "utf8"));
    expect(solution.probabilityYes).toBe("0.75");
  });
});
