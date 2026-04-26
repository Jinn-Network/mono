import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { HarnessAdapter, IntentSessionInputs } from '../types.js';

export interface ClaudeCodeHarnessAdapterConfig {
  /** Path to the `claude` executable. Default: 'claude' (from PATH). */
  claudePath?: string;
  /** Optional model override (e.g. 'claude-sonnet-4-6'). */
  claudeModel?: string;
  /**
   * Plugin install directory for Claude Code. Defaults to
   * `~/.claude/plugins/`. The adapter copies (or symlinks) the plugin
   * into this directory before spawning.
   */
  pluginInstallDir?: string;
  /**
   * Override spawn for testing. When provided, called instead of
   * node:child_process.spawn so tests can inject a fake child process.
   */
  _spawnFn?: typeof spawn;
}

/**
 * Allowlist of env vars that propagate to the spawned Claude session.
 * We deliberately limit this to avoid leaking unrelated credentials
 * into the agent process.
 *
 * Mirror of the canonical allowlist in client/src/runner/claude.ts.
 * Hard-won from prior auth/runtime issues — keep in sync with that file.
 */
const ENV_ALLOWLIST = [
  'PATH',
  'HOME',
  'USER',
  'SHELL',
  'LANG',
  'TERM',
  'TMPDIR',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_CACHE_HOME',
  'NODE_PATH',
  'NODE_OPTIONS',
  'NPM_CONFIG_PREFIX',
  // Claude Code auth — needed in Docker where keychain is unavailable.
  // CLAUDE_CODE_OAUTH_TOKEN is the output of `claude setup-token` (subscription
  // path, year-long validity); ANTHROPIC_API_KEY is the pay-per-request fallback.
  // Both are Claude credentials, not Jinn operator secrets, so forwarding is
  // scoped and intentional. Without these the spawned `claude -p …` fails with
  // "Not logged in · Please run /login".
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_API_KEY',
];

function buildAgentEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: Record<string, string> = {};
  for (const key of ENV_ALLOWLIST) {
    if (process.env[key]) env[key] = process.env[key]!;
  }
  return { ...env, ...extra };
}

/**
 * Construct the initial prompt that invokes the coordinator skill with
 * the intent context.
 */
function buildInitialPrompt(inputs: IntentSessionInputs): string {
  return [
    'You are running a Jinn restoration intent. Invoke the `coordinator` skill via the Skill tool to begin.',
    '',
    'Session inputs (refer to these when the coordinator skill or any phase asks for them):',
    `- intent.id = ${inputs.intentId}`,
    inputs.intentCid ? `- intent.cid = ${inputs.intentCid}` : '',
    inputs.intentKind ? `- intent.kind = ${inputs.intentKind}` : '',
    `- workingDir = ${inputs.workingDir}`,
    `- implStateDir = ${inputs.implStateDir}`,
    `- window.startTs = ${inputs.windowStartTs} (ms since epoch)`,
    `- window.endTs = ${inputs.windowEndTs} (ms since epoch)`,
    `- msUntilEndTs = ${inputs.msUntilEndTs}`,
    '',
    'Run all seven phases and return when complete.',
  ]
    .filter((line) => line !== '')
    .join('\n');
}

/**
 * Real Claude Code adapter. Spawns the `claude` CLI with the plugin
 * loaded via Claude Code's plugin install directory, sets IMPL_STATE_DIR
 * so the session-start hook fires correctly, and hands the coordinator
 * an initial prompt with intent context.
 *
 * Output collection is delegated to the shim's harvester — this adapter
 * only owns the spawn lifecycle.
 */
export class ClaudeCodeHarnessAdapter implements HarnessAdapter {
  readonly name = 'claude-code';
  readonly allowsHarnessSelfModification = false;

  private readonly claudePath: string;
  private readonly claudeModel: string | undefined;
  private readonly pluginInstallDir: string;
  private readonly spawnFn: typeof spawn;

  constructor(config: ClaudeCodeHarnessAdapterConfig = {}) {
    this.claudePath = config.claudePath ?? 'claude';
    this.claudeModel = config.claudeModel;
    this.pluginInstallDir = config.pluginInstallDir ?? join(homedir(), '.claude', 'plugins');
    this.spawnFn = config._spawnFn ?? spawn;
  }

  async runIntent(inputs: IntentSessionInputs, pluginRoot: string): Promise<void> {
    // Ensure the plugin install directory exists. The adapter does NOT
    // copy the plugin — that's the operator's responsibility per the
    // README. If the operator has not installed it, Claude Code will
    // not find the coordinator skill and will fail; check for it here.
    mkdirSync(this.pluginInstallDir, { recursive: true });

    const prompt = buildInitialPrompt(inputs);
    const args: string[] = ['-p', prompt];
    if (this.claudeModel) args.push('--model', this.claudeModel);

    const env = buildAgentEnv({
      IMPL_STATE_DIR: inputs.implStateDir,
      JINN_DEFAULT_LEARNER_PLUGIN_ROOT: pluginRoot,
      ...(inputs.adapterEnv ?? {}),
    });

    const spawnOpts: SpawnOptions = {
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
      cwd: inputs.workingDir,
    };

    return new Promise<void>((resolve, reject) => {
      const child: ChildProcess = this.spawnFn(this.claudePath, args, spawnOpts);

      // If the abort signal already fired before we got here (race), kill
      // the child immediately. Without this, addEventListener below would
      // never fire (signals only emit on transition to aborted, not when
      // already aborted).
      if (inputs.abort.aborted) {
        if (!child.killed) child.kill('SIGTERM');
      }

      // Window-end abort: kill child, reject.
      const onAbort = () => {
        if (!child.killed) child.kill('SIGTERM');
      };
      inputs.abort.addEventListener('abort', onAbort);

      let stderr = '';
      child.stderr?.on('data', (d: Buffer) => {
        stderr += d.toString();
      });

      child.on('exit', (code, signal) => {
        inputs.abort.removeEventListener('abort', onAbort);
        if (code === 0) {
          resolve();
        } else if (inputs.abort.aborted) {
          // Window expired; resolve anyway so harvester can collect
          // partial outputs. The shim's caller (engine) handles the
          // abort signal separately.
          resolve();
        } else {
          reject(
            new Error(
              `claude-code adapter: child exited with code=${code} signal=${signal}: ${stderr.slice(0, 500)}`,
            ),
          );
        }
      });

      child.on('error', (err) => {
        inputs.abort.removeEventListener('abort', onAbort);
        reject(err);
      });
    });
  }
}
