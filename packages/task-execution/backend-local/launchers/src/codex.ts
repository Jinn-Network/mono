import type { LauncherContract } from "./contract.js";
import {
  baseEnv, capabilities, effort, isolation, loadoutPath, modelId, probeFrom, requireHarness,
  schema, type LauncherOptions,
} from "./planning.js";

export function makeCodexLauncher(options: LauncherOptions = {}): LauncherContract {
  return {
    id: "codex",
    capabilities: () => capabilities([
      { key: "effort", inventory: ["low", "medium", "high", "xhigh", "max"] },
      { key: "harness", inventory: ["codex"] },
      { key: "isolationPolicy", inventory: ["unrestricted"] },
      { key: "loadout", inventory: ["jinn.skill.v1"] },
      { key: "model", inventory: ["pinned-id"] },
    ], true),
    probe: probeFrom(options, "codex"),
    plan(view, paths, attempt) {
      const harness = requireHarness(view, "codex"); isolation(view);
      const argv = ["codex", "exec", "--json", "--ignore-user-config", "--disable", "plugins", "--sandbox", "danger-full-access", "--dangerously-bypass-approvals-and-sandbox", "-C", paths.work];
      const model = modelId(view); if (model) argv.push("-m", model);
      const tier = effort(view); if (tier) argv.push("-c", `model_reasoning_effort=\"${tier}\"`);
      const loadout = loadoutPath(view, paths); if (loadout) argv.push("-c", `jinn_loadout_path=\"${loadout}\"`);
      const outputSchema = schema(view); if (outputSchema !== undefined) argv.push("--output-schema", JSON.stringify(outputSchema));
      argv.push(view.task.instructions);
      return {
        argv, cwd: paths.work,
        env: { ...baseEnv(paths, attempt), CODEX_HOME: paths.harnessState, ...(harness.version ? { JINN_HARNESS_PIN_VERSION: harness.version } : {}), ...(harness.digest ? { JINN_HARNESS_PIN_DIGEST: harness.digest } : {}) },
        validExitCodes: [0],
        blameExitCodes: [{ match: { signal: "SIGKILL" }, blame: "infrastructure", reasonCode: "killed" }],
        resultContract: { envelopeFormat: "codex-exec-json", outputSchemaFlag: "--output-schema", structuredOutputArtifact: "out/structured-output.json", correlationFields: ["harnessVersion", "capabilities", "sessionId"] },
        interruptionBehavior: "recoverable",
        secretForwards: [],
      };
    },
  };
}
export const codexLauncher = makeCodexLauncher();
