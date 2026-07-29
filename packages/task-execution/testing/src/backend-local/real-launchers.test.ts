import {
  claudeCodeLauncher, codexLauncher, cursorLauncher, hermesLauncher, interpretResult,
  makeClaudeCodeLauncher, makeCodexLauncher, makeCursorLauncher, makeHermesLauncher,
} from "@jinn-network/task-execution-launchers";
import { describe, expect, test } from "vitest";
import { describeLauncherContract, makeSampleLauncherInputs } from "./launcher-contract.js";

// Concrete subjects are owned by the downstream testing package (program §7.25).
describeLauncherContract(claudeCodeLauncher);
describeLauncherContract(codexLauncher);
describeLauncherContract(hermesLauncher);
describeLauncherContract(cursorLauncher);

const cases = [
  { launcher: claudeCodeLauncher, prefix: ["claude", "--setting-sources", "project", "--permission-mode", "bypassPermissions", "--verbose", "--output-format", "stream-json", "--include-hook-events", "-p"], schema: "--json-schema" },
  { launcher: codexLauncher, prefix: ["codex", "exec", "--json", "--ignore-user-config"], schema: "--output-schema" },
  { launcher: hermesLauncher, prefix: ["hermes", "chat", "-q"], schema: "--json-schema" },
  { launcher: cursorLauncher, prefix: ["agent", "-p", "--force", "--trust", "--sandbox", "disabled", "--approve-mcps"], schema: "--output-schema" },
] as const;

describe("real launcher exact planning", () => {
  for (const subject of cases) {
    test(`${subject.launcher.id} uses its harness-specific noninteractive invocation`, () => {
      const { view, paths, attempt } = makePinnedInputs(subject.launcher.id);
      const plan = subject.launcher.plan(view, paths, attempt);
      expect(plan.argv.slice(0, subject.prefix.length)).toEqual(subject.prefix);
      expect(plan.argv).toContain(subject.schema);
      expect(plan.cwd).toBe(paths.work);
      expect(plan.env.JINN_ATTEMPT_ID).toBe(attempt.attemptUri);
      expect(plan.env.AMBIENT_API_KEY).toBeUndefined();
      expect(subject.launcher.capabilities().runPinning.keys.map((entry) => entry.key)).toEqual(
        subject.launcher.id === "cursor"
          ? ["harness", "isolationPolicy", "loadout", "model"]
          : ["effort", "harness", "isolationPolicy", "loadout", "model"],
      );
    });

    test(`${subject.launcher.id} fails closed on a pin for another harness`, () => {
      const { view, paths, attempt } = makePinnedInputs("wrong-harness");
      expect(() => subject.launcher.plan(view, paths, attempt)).toThrow(/harness pin/u);
    });

    test(`${subject.launcher.id} exit/signal authority cannot be overruled`, () => {
      const { view, paths, attempt } = makePinnedInputs(subject.launcher.id);
      const plan = subject.launcher.plan(view, paths, attempt);
      expect(interpretResult(plan, { exitCode: 1 }, { subtype: "success" }).state).toBe("failed");
      expect(interpretResult(plan, { exitCode: 0, signal: "SIGKILL" }, { subtype: "success" }).state).toBe("failed");
    });
  }

  test("claude limit exhaustion is resumable partial and structured output is alongside envelope", () => {
    const { view, paths, attempt } = makePinnedInputs("claude-code");
    const result = interpretResult(claudeCodeLauncher.plan(view, paths, attempt), { exitCode: 0 }, {
      subtype: "error_max_turns", structuredOutput: { score: 1 }, sessionId: "session-1",
      harnessVersion: "1.2.3", capabilities: ["structured-output"],
    });
    expect(result).toMatchObject({
      state: "delivered", outcome: "partial", recoveryAdvice: "resume-with-session",
      structuredOutput: { score: 1 }, correlation: { sessionId: "session-1", harnessVersion: "1.2.3" },
    });
  });

  test("dynamic probe reports injected binary/auth/version readiness", async () => {
    for (const make of [makeClaudeCodeLauncher, makeCodexLauncher, makeHermesLauncher, makeCursorLauncher]) {
      const launcher = make({ probe: async () => ({ ready: true, detail: "binary 1.2.3; auth ready" }) });
      await expect(launcher.probe?.()).resolves.toEqual({ ready: true, detail: "binary 1.2.3; auth ready" });
    }
  });

  test("cursor fails closed rather than dropping an unsupported effort pin", () => {
    const inputs = makePinnedInputs("cursor");
    const view = { ...inputs.view, effectiveRequirements: { ...inputs.view.effectiveRequirements, effort: "high" } };
    expect(() => cursorLauncher.plan(view, inputs.paths, inputs.attempt)).toThrow(/effort pin is unsupported/u);
  });
});

function makePinnedInputs(harnessId: string) {
  const inputs = makeSampleLauncherInputs();
  return {
    ...inputs,
    view: {
      ...inputs.view,
      task: { ...inputs.view.task, outputs: [{ name: "result", mediaType: "application/json", required: true, schema: { type: "object" } }] },
      effectiveRequirements: {
        harness: { id: harnessId, version: "1.2.3" },
        model: { provider: "test", id: "model-1" },
        loadout: { name: "loadout", uri: "file:input/loadout", digest: { sha256: "a".repeat(64) }, kind: "jinn.skill.v1" },
        isolationPolicy: "unrestricted",
        ...(harnessId === "cursor" ? {} : { effort: "high" }),
      },
    },
  };
}
