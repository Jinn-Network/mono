import type { LauncherContract } from "./contract.js";
import {
  baseEnv, capabilities, effort, isolation, loadoutPath, modelId, probeFrom, requireHarness,
  schema, type LauncherOptions,
} from "./planning.js";

const ITERATIONS: Record<string, string> = { low: "16", medium: "32", high: "64", xhigh: "96", max: "128" };
const SECRET_FORWARDS = [{ grantKey: "openrouter-api-key", target: "openrouter-api-key" }] as const;
export function makeHermesLauncher(options: LauncherOptions = {}): LauncherContract {
  return {
    id: "hermes",
    capabilities: () => capabilities([
      { key: "effort", inventory: Object.keys(ITERATIONS) },
      { key: "harness", inventory: ["hermes"] },
      { key: "isolationPolicy", inventory: ["unrestricted"] },
      { key: "loadout", inventory: ["jinn.skill.v1"] },
      { key: "model", inventory: ["pinned-id"] },
    ], true, SECRET_FORWARDS),
    probe: probeFrom(options, "hermes"),
    plan(view, paths, attempt) {
      const harness = requireHarness(view, "hermes"); isolation(view);
      const argv = ["hermes", "chat", "-q", view.task.instructions, "-Q", "--yolo", "--accept-hooks"];
      const model = modelId(view); if (model) argv.push("--model", model);
      const tier = effort(view); if (tier) argv.push("--max-iterations", ITERATIONS[tier]);
      const outputSchema = schema(view); if (outputSchema !== undefined) argv.push("--json-schema", JSON.stringify(outputSchema));
      const loadout = loadoutPath(view, paths);
      return {
        argv, cwd: paths.work,
        env: { ...baseEnv(paths, attempt), HERMES_HOME: paths.harnessState, OPENROUTER_API_KEY: "secrets/openrouter-api-key", ...(loadout ? { JINN_LOADOUT_DIR: loadout } : {}), ...(harness.version ? { JINN_HARNESS_PIN_VERSION: harness.version } : {}), ...(harness.digest ? { JINN_HARNESS_PIN_DIGEST: harness.digest } : {}) },
        validExitCodes: [0],
        blameExitCodes: [{ match: { signal: "SIGKILL" }, blame: "infrastructure", reasonCode: "killed" }],
        resultContract: { envelopeFormat: "hermes-json", outputSchemaFlag: "--json-schema", structuredOutputArtifact: "out/structured-output.json", correlationFields: ["harnessVersion", "capabilities", "sessionId"] },
        interruptionBehavior: "recoverable",
        secretForwards: SECRET_FORWARDS,
      };
    },
  };
}
export const hermesLauncher = makeHermesLauncher();
