import type { LauncherContract } from "./contract.js";
import {
  baseEnv, capabilities, isolation, loadoutPath, modelId, probeFrom, requireHarness, requirementRecord,
  schema, type LauncherOptions,
} from "./planning.js";

export function makeCursorLauncher(options: LauncherOptions = {}): LauncherContract {
  return {
    id: "cursor",
    capabilities: () => capabilities([
      { key: "harness", inventory: ["cursor"] },
      { key: "isolationPolicy", inventory: ["unrestricted"] },
      { key: "loadout", inventory: ["jinn.skill.v1"] },
      { key: "model", inventory: ["pinned-id"] },
    ], false),
    probe: probeFrom(options, "cursor"),
    plan(view, paths, attempt) {
      const harness = requireHarness(view, "cursor"); isolation(view);
      if (requirementRecord(view).effort !== undefined) throw new Error("cursor: effort pin is unsupported");
      // Cursor's `agent -p` is its headless/print mode; flags mirror the existing Autopilot
      // dispatcher adapter rather than inventing Claude/Codex-shaped switches.
      const argv = ["agent", "-p", "--force", "--trust", "--sandbox", "disabled", "--approve-mcps", "--workspace", paths.work, "--output-format", "json"];
      const model = modelId(view); if (model) argv.push("--model", model);
      const outputSchema = schema(view); if (outputSchema !== undefined) argv.push("--output-schema", JSON.stringify(outputSchema));
      argv.push(view.task.instructions);
      const loadout = loadoutPath(view, paths);
      return {
        argv, cwd: paths.work,
        env: { ...baseEnv(paths, attempt), ...(loadout ? { JINN_LOADOUT_DIR: loadout } : {}), ...(harness.version ? { JINN_HARNESS_PIN_VERSION: harness.version } : {}), ...(harness.digest ? { JINN_HARNESS_PIN_DIGEST: harness.digest } : {}) },
        validExitCodes: [0],
        blameExitCodes: [{ match: { signal: "SIGKILL" }, blame: "infrastructure", reasonCode: "killed" }],
        resultContract: { envelopeFormat: "cursor-agent-json", outputSchemaFlag: "--output-schema", structuredOutputArtifact: "out/structured-output.json", correlationFields: ["harnessVersion", "capabilities", "sessionId"] },
        interruptionBehavior: "repeatable",
        secretForwards: [],
      };
    },
  };
}
export const cursorLauncher = makeCursorLauncher();
