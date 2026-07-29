import type { LauncherContract } from "./contract.js";

export function makeLauncher(id: string, argvPrefix: readonly string[], secret?: readonly [string, string]): LauncherContract {
  return {
    id,
    capabilities: () => ({ taskProfiles: ["https://jinn.network/task-profiles/repository-work/1.0"], inputMediaTypes: ["application/json"], outputMediaTypes: ["application/json"], structuredOutput: true, resume: id === "claude-code", interruptionBehaviorDefault: "repeatable", runPinning: { keys: [] } }),
    async probe() { return { ready: false, detail: `${id} probe requires host binary/auth integration` }; },
    plan(view, paths, attempt) {
      const schema = (view.task.outputs.find((output) => output.schema !== undefined)?.schema);
      const argv = [...argvPrefix, "--bare", "--prompt", view.task.instructions, "--attempt", attempt.attemptUri];
      if (schema !== undefined) argv.push(id === "claude-code" ? "--json-schema" : "--output-schema", JSON.stringify(schema));
      return { argv, env: { JINN_ATTEMPT_ID: attempt.attemptUri, JINN_ATTEMPT_INPUT: paths.input, JINN_ATTEMPT_OUT: paths.out, JINN_ATTEMPT_LOGS: paths.logs, ...(secret ? { [secret[0]]: secret[1] } : {}) }, cwd: paths.work, validExitCodes: [0], blameExitCodes: [{ match: { signal: "SIGTERM" }, blame: "infrastructure", reasonCode: "terminated" }], resultContract: { envelopeFormat: `${id}-json`, outputSchemaFlag: id === "claude-code" ? "--json-schema" : "--output-schema" }, interruptionBehavior: "repeatable" };
    },
  };
}
