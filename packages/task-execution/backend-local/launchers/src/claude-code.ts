import type { LauncherContract } from "./contract.js";
import {
  baseEnv, capabilities, effort, isolation, loadoutPath, modelId, probeFrom, requireHarness,
  schema, type LauncherOptions,
} from "./planning.js";

export function makeClaudeCodeLauncher(options: LauncherOptions = {}): LauncherContract {
  return {
    id: "claude-code",
    capabilities: () => capabilities([
      { key: "effort", inventory: ["low", "medium", "high", "xhigh", "max"] },
      { key: "harness", inventory: ["claude-code"] },
      { key: "isolationPolicy", inventory: ["unrestricted"] },
      { key: "loadout", inventory: ["jinn.skill.v1"] },
      { key: "model", inventory: ["pinned-id"] },
    ], true),
    probe: probeFrom(options, "claude-code"),
    plan(view, paths, attempt) {
      const harness = requireHarness(view, "claude-code");
      isolation(view);
      const argv = ["claude", "--setting-sources", "project", "--permission-mode", "bypassPermissions", "--verbose", "--output-format", "stream-json", "--include-hook-events", "-p", view.task.instructions];
      const model = modelId(view); if (model) argv.push("--model", model);
      const loadout = loadoutPath(view, paths); if (loadout) argv.push("--plugin-dir", loadout);
      const tier = effort(view); if (tier) argv.push("--effort", tier);
      const outputSchema = schema(view); if (outputSchema !== undefined) argv.push("--json-schema", JSON.stringify(outputSchema));
      return {
        argv, cwd: paths.work,
        env: { ...baseEnv(paths, attempt), CLAUDE_CONFIG_DIR: paths.harnessState, ...(harness.version ? { JINN_HARNESS_PIN_VERSION: harness.version } : {}), ...(harness.digest ? { JINN_HARNESS_PIN_DIGEST: harness.digest } : {}) },
        validExitCodes: [0],
        blameExitCodes: [{ match: { signal: "SIGKILL" }, blame: "infrastructure", reasonCode: "killed" }],
        resultContract: { envelopeFormat: "claude-code-stream-json", outputSchemaFlag: "--json-schema", structuredOutputArtifact: "out/structured-output.json", correlationFields: ["harnessVersion", "capabilities", "sessionId"] },
        interruptionBehavior: "recoverable",
        secretForwards: [],
      };
    },
  };
}
export const claudeCodeLauncher = makeClaudeCodeLauncher();
