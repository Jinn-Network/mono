import { describe, expect, it } from "vitest";
import { claudeCodeLauncher, codexLauncher, cursorLauncher, hermesLauncher, interpretResult } from "./index.js";
import type { AttemptIdentity } from "@jinn-network/task-execution-supervisor";
import type { TaskView, WorkspacePaths } from "@jinn-network/task-execution-workspace";

const view = { task: { instructions: "do the work", outputs: [] }, effectiveRequirements: {}, profile: { profile: "https://jinn.network/task-profiles/repository-work/1.0" } } as unknown as TaskView;
const paths = { work: "/attempt/work", input: "/attempt/input", harnessState: "/attempt/harness-state", secrets: "/attempt/secrets", out: "/attempt/out", root: "/attempt", logs: "/attempt/logs", tmp: "/attempt/tmp", meta: "/attempt/meta" } as WorkspacePaths;
const attempt = { attemptUri: "urn:uuid:00000000-0000-0000-0000-000000000001", nonce: "n", attemptNumber: 1 } as AttemptIdentity;

describe("v1 launchers", () => {
  for (const launcher of [claudeCodeLauncher, codexLauncher, hermesLauncher, cursorLauncher]) {
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
    for (const launcher of [claudeCodeLauncher, codexLauncher, cursorLauncher]) {
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

  it("does not treat an unspecified blame-rule signal as matching every exit", () => {
    const plan = {
      validExitCodes: [0],
      blameExitCodes: [
        { match: { exitCode: 65 }, blame: "task", reasonCode: "invalid-evaluation-input" },
        { match: { signal: "SIGKILL" }, blame: "infrastructure", reasonCode: "killed" },
      ],
    };
    expect(interpretResult(plan, { exitCode: 1 }).reasonCode).toBe("invalid-exit");
    expect(interpretResult(plan, { signal: "SIGKILL" }).reasonCode).toBe("killed");
  });
});
