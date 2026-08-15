import type { LauncherContract } from "./contract.js";
import { credentialExecArgv } from "@jinn-network/task-execution-supervisor";
import {
  baseEnv, capabilities, effort, isolation, loadoutPath, modelId, probeFrom, requireHarness,
  credentialForwards, credentialReference, executablePath, schema, type HarnessCredentialMode,
  hostCredentialForwards, type HarnessHostCredential, type LauncherOptions,
} from "./planning.js";

export interface ClaudeCodeLauncherOptions extends LauncherOptions {
  /** Opt-in platform credential.  Leaving this absent preserves the zero-forward default. */
  readonly credential?: HarnessCredentialMode;
  readonly hostCredential?: HarnessHostCredential;
}

export function makeClaudeCodeLauncher(options: ClaudeCodeLauncherOptions = {}): LauncherContract {
  const secretForwards = credentialForwards(options.credential);
  const hostSecretForwards = hostCredentialForwards(options.hostCredential);
  if (options.credential !== undefined && options.hostCredential !== undefined) throw new Error("choose requester or host credential, not both");
  return {
    id: "claude-code",
    capabilities: () => capabilities([
      { key: "effort", inventory: ["low", "medium", "high", "xhigh", "max"] },
      { key: "harness", inventory: ["claude-code"] },
      { key: "isolationPolicy", inventory: ["unrestricted"] },
      { key: "loadout", inventory: ["jinn.skill.v1", "jinn.harness-state.v1"] },
      { key: "model", inventory: ["pinned-id"] },
    ], true, secretForwards, undefined, hostSecretForwards),
    probe: probeFrom(options, "claude-code"),
    plan(view, paths, attempt) {
      const harness = requireHarness(view, "claude-code");
      const credential = options.hostCredential ?? options.credential;
      isolation(view);
      const argv = [executablePath(options, "claude"), "--setting-sources", "project", "--permission-mode", "bypassPermissions", "--verbose", "--output-format", "stream-json", "--include-hook-events", "-p", view.task.instructions];
      const model = modelId(view); if (model) argv.push("--model", model);
      const loadout = loadoutPath(view, paths); if (loadout) argv.push("--plugin-dir", loadout);
      const tier = effort(view); if (tier) argv.push("--effort", tier);
      const outputSchema = schema(view); if (outputSchema !== undefined) argv.push("--json-schema", JSON.stringify(outputSchema));
      // Qualification disables the documented configuration/session surfaces.  `--bare` cannot
      // be used with OAuth (Claude documents it as API-key-only), so the local-login form uses
      // Claude's documented safe mode instead.  Unsupported update/telemetry controls are not
      // guessed here: a deployment must qualify those outside the launcher rather than claiming
      // an undocumented environment switch gives isolation.
      if (credential?.kind === "api-key") argv.push("--bare", "--no-session-persistence", "--disable-slash-commands", "--strict-mcp-config");
      if (credential?.kind === "credential-artifact") argv.push("--safe-mode", "--no-session-persistence", "--disable-slash-commands", "--strict-mcp-config");
      const credentialEnv: Record<string, string> = credential === undefined ? {} : credential.kind === "api-key"
        ? { ANTHROPIC_API_KEY: credentialReference(credential.secretBasename) }
        : { CLAUDE_CODE_OAUTH_TOKEN: credentialReference(credential.secretBasename) };
      return {
        argv: credential === undefined ? argv : credentialExecArgv(argv), cwd: paths.work,
        env: { ...baseEnv(paths, attempt), CLAUDE_CONFIG_DIR: paths.harnessState, ...(credential === undefined ? {} : { JINN_ATTEMPT_SECRETS: paths.secrets }), ...credentialEnv, ...(harness.version ? { JINN_HARNESS_PIN_VERSION: harness.version } : {}), ...(harness.digest ? { JINN_HARNESS_PIN_DIGEST: harness.digest } : {}) },
        validExitCodes: [0],
        blameExitCodes: [{ match: { signal: "SIGKILL" }, blame: "infrastructure", reasonCode: "killed" }],
        resultContract: { envelopeFormat: "claude-code-stream-json", outputSchemaFlag: "--json-schema", structuredOutputArtifact: "out/structured-output.json", correlationFields: ["harnessVersion", "capabilities", "sessionId"] },
        interruptionBehavior: "recoverable",
        secretForwards,
        ...(hostSecretForwards.length === 0 ? {} : { hostSecretForwards }),
      };
    },
  };
}
export const claudeCodeLauncher = makeClaudeCodeLauncher();
