import type { LauncherContract } from "./contract.js";
import {
  baseEnv, capabilities, effort, isolation, loadoutPath, modelId, probeFrom, requireHarness,
  credentialExecArgv, credentialForwards, credentialReference, executablePath, schema, type HarnessCredentialMode,
  hostCredentialForwards, type HarnessHostCredential, type LauncherOptions,
} from "./planning.js";

export interface CodexLauncherOptions extends LauncherOptions {
  /** Opt-in platform credential. A local login is a portable `auth.json` artifact. */
  readonly credential?: HarnessCredentialMode;
  readonly hostCredential?: HarnessHostCredential;
}

export function makeCodexLauncher(options: CodexLauncherOptions = {}): LauncherContract {
  const secretForwards = credentialForwards(options.credential);
  const hostSecretForwards = hostCredentialForwards(options.hostCredential);
  if (options.credential !== undefined && options.hostCredential !== undefined) throw new Error("choose requester or host credential, not both");
  return {
    id: "codex",
    capabilities: () => capabilities([
      { key: "effort", inventory: ["low", "medium", "high", "xhigh", "max"] },
      { key: "harness", inventory: ["codex"] },
      { key: "isolationPolicy", inventory: ["unrestricted"] },
      { key: "loadout", inventory: ["jinn.skill.v1", "jinn.harness-state.v1"] },
      { key: "model", inventory: ["pinned-id"] },
    ], true, secretForwards, undefined, hostSecretForwards),
    probe: probeFrom(options, "codex"),
    plan(view, paths, attempt) {
      const harness = requireHarness(view, "codex"); isolation(view);
      const credential = options.hostCredential ?? options.credential;
      const argv = [executablePath(options, "codex"), "exec", "--json", "--ignore-user-config", "--disable", "plugins", "--sandbox", "danger-full-access", "--dangerously-bypass-approvals-and-sandbox", "-C", paths.work];
      const model = modelId(view); if (model) argv.push("-m", model);
      const tier = effort(view); if (tier) argv.push("-c", `model_reasoning_effort=\"${tier}\"`);
      const loadout = loadoutPath(view, paths); if (loadout) argv.push("-c", `jinn_loadout_path=\"${loadout}\"`);
      const outputSchema = schema(view); if (outputSchema !== undefined) argv.push("--output-schema", JSON.stringify(outputSchema));
      if (credential !== undefined) argv.push("--ephemeral", "--ignore-rules");
      argv.push(view.task.instructions);
      if (credential?.kind === "credential-artifact") {
        // A local login has no supported noninteractive token environment for Codex.  The bridge
        // places this artifact at TMPDIR/jinn-codex-local-login/auth.json at exec time instead.
      }
      const credentialEnv: Record<string, string> = credential === undefined ? {} : credential.kind === "api-key"
        ? { OPENAI_API_KEY: credentialReference(credential.secretBasename) }
        : { JINN_CODEX_AUTH_JSON: credentialReference(credential.secretBasename) };
      return {
        argv: credential === undefined ? argv : credentialExecArgv(argv), cwd: paths.work,
        env: { ...baseEnv(paths, attempt), CODEX_HOME: paths.harnessState, ...(credential === undefined ? {} : { JINN_ATTEMPT_SECRETS: paths.secrets }), ...credentialEnv, ...(harness.version ? { JINN_HARNESS_PIN_VERSION: harness.version } : {}), ...(harness.digest ? { JINN_HARNESS_PIN_DIGEST: harness.digest } : {}) },
        validExitCodes: [0],
        blameExitCodes: [{ match: { signal: "SIGKILL" }, blame: "infrastructure", reasonCode: "killed" }],
        resultContract: { envelopeFormat: "codex-exec-json", outputSchemaFlag: "--output-schema", structuredOutputArtifact: "out/structured-output.json", correlationFields: ["harnessVersion", "capabilities", "sessionId"] },
        interruptionBehavior: "recoverable",
        secretForwards,
        ...(hostSecretForwards.length === 0 ? {} : { hostSecretForwards }),
      };
    },
  };
}
export const codexLauncher = makeCodexLauncher();
