import { describe, expect, test } from "vitest";
import { selectProfileSafeLauncher } from "./routing.js";
import type { LauncherContract } from "./contract.js";

const repository = "https://jinn.network/task-profiles/repository-work/1.0";
const evaluation = "https://jinn.network/task-profiles/evaluation-task/1.0";

function launcher(id: string, profiles: readonly string[]): LauncherContract {
  return {
    id,
    capabilities: () => ({
      taskProfiles: profiles,
      inputMediaTypes: [],
      outputMediaTypes: [],
      structuredOutput: false,
      resume: false,
      interruptionBehaviorDefault: "repeatable",
      secretForwards: [],
      runPinning: { keys: [] },
    }),
    plan() { throw new Error("not used"); },
  };
}

describe("selectProfileSafeLauncher", () => {
  test("routes evaluation work to its dedicated harness despite reversed registry order", () => {
    const generic = launcher("generic", [repository]);
    const evaluator = launcher("evaluation-harness", [evaluation]);

    expect(selectProfileSafeLauncher([generic, evaluator], evaluation)).toBe(evaluator);
    expect(selectProfileSafeLauncher([evaluator, generic], evaluation)).toBe(evaluator);
  });

  test("refuses an explicit harness that does not support the resolved profile", () => {
    const generic = launcher("generic", [repository]);
    const evaluator = launcher("evaluation-harness", [evaluation]);

    expect(() => selectProfileSafeLauncher([generic, evaluator], repository, "evaluation-harness"))
      .toThrow('does not support profile');
    expect(() => selectProfileSafeLauncher([generic, evaluator], evaluation, "generic"))
      .toThrow('does not support profile');
  });

  test("refuses generic launchers for evaluation even if they falsely advertise it", () => {
    const generic = launcher("generic", [repository, evaluation]);
    const evaluator = launcher("evaluation-harness", [evaluation]);

    expect(selectProfileSafeLauncher([generic, evaluator], evaluation)).toBe(evaluator);
    expect(() => selectProfileSafeLauncher([generic], evaluation)).toThrow("dedicated evaluation harness");
  });
});
