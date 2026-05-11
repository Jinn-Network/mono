import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { createWriteStream, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { finished } from 'node:stream/promises';
import type { HarnessAdapter, TaskSessionInputs } from '../types.js';

export interface ClaudeCodeHarnessAdapterConfig {
  /** Path to the `claude` executable. Default: 'claude' (from PATH). */
  claudePath?: string;
  /** Optional model override (e.g. 'claude-sonnet-4-6'). */
  claudeModel?: string;
  /**
   * Local SQLite store path forwarded to the Jinn client MCP server exposed by
   * Network Tools. Without it, read-only record search degrades to an empty
   * no-store response.
   */
  storePath?: string;
  /** Daemon API URL used by explicit cost-mutating MCP tools such as acquire_artifact. */
  daemonApiUrl?: string;
  /** Bearer token for daemon API cost-mutating routes. */
  daemonApiToken?: string;
  /** Keyless corpus endpoints for read-only record search and inspection. */
  corpusEnv?: {
    subgraphUrl?: string;
    ipfsGatewayUrl?: string;
    rpcUrl?: string;
    chainId?: number;
    identityRegistryAddress?: string;
    fromBlock?: number;
  };
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

function stringField(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function taskContextJson(inputs: TaskSessionInputs): string {
  const context = inputs.taskBody?.context;
  if (!context || typeof context !== 'object') return '';
  try {
    return JSON.stringify(context);
  } catch {
    return '';
  }
}

function captureLogError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

/**
 * Construct the initial task prompt. Harness/plugin-specific operating details
 * live in the projected runtime instructions, not in this daemon handoff.
 */
function buildInitialPrompt(inputs: TaskSessionInputs): string {
  return [
    'You are executing a Jinn task.',
    'Complete the task described by the task payload below.',
    'Use the available skills, plugins, tools, and runtime context exposed by this harness.',
    'Keep all task work inside `workingDir`.',
    'When the task requires a typed SolverNet payload, submit it through an available submission tool or write the expected payload file for the harness harvester.',
    '',
    'Session inputs:',
    `- goal.id = ${inputs.taskId}`,
    inputs.taskCid ? `- goal.cid = ${inputs.taskCid}` : '',
    `- workingDir = ${inputs.workingDir}`,
    `- implStateDir = ${inputs.implStateDir}`,
    `- goal.deadline = ${inputs.windowEndTs} (ms since epoch)`,
    `- msUntilDeadline = ${inputs.msUntilEndTs}`,
    `- mode = ${inputs.mode}`,
    inputs.taskBody
      ? `\ngoal (full body):\n${JSON.stringify(inputs.taskBody, null, 2)}`
      : '',
  ]
    .filter((line) => line !== '')
    .join('\n');
}

/**
 * Real Claude Code adapter. Spawns the `claude` CLI with the plugin
 * loaded via Claude Code's plugin install directory, sets IMPL_STATE_DIR
 * so the session-start hook fires correctly, and hands the task context to
 * the session.
 *
 * Output collection is delegated to the shim's harvester — this adapter
 * only owns the spawn lifecycle.
 */
export class ClaudeCodeHarnessAdapter implements HarnessAdapter {
  readonly name = 'claude-code';
  readonly allowsHarnessSelfModification = false;

  private readonly claudePath: string;
  private readonly claudeModel: string | undefined;
  private readonly storePath: string | undefined;
  private readonly daemonApiUrl: string | undefined;
  private readonly daemonApiToken: string | undefined;
  private readonly corpusEnv: ClaudeCodeHarnessAdapterConfig['corpusEnv'];
  private readonly pluginInstallDir: string;
  private readonly spawnFn: typeof spawn;

  constructor(config: ClaudeCodeHarnessAdapterConfig = {}) {
    this.claudePath = config.claudePath ?? 'claude';
    this.claudeModel = config.claudeModel;
    this.storePath = config.storePath;
    this.daemonApiUrl = config.daemonApiUrl;
    this.daemonApiToken = config.daemonApiToken;
    this.corpusEnv = config.corpusEnv;
    this.pluginInstallDir = config.pluginInstallDir ?? join(homedir(), '.claude', 'plugins');
    this.spawnFn = config._spawnFn ?? spawn;
  }

  async runTask(inputs: TaskSessionInputs, pluginRoot: string): Promise<void> {
    // Ensure the plugin install directory exists. The adapter does NOT
    // copy the plugin — that's the operator's responsibility per the
    // README. If the operator has not installed it, Claude Code will
    // not find the learn skill and will fail; check for it here.
    mkdirSync(this.pluginInstallDir, { recursive: true });

    const prompt = buildInitialPrompt(inputs);
    const args: string[] = [
      '--setting-sources',
      'project',
      '--permission-mode',
      'bypassPermissions',
      '--verbose',
      '--output-format',
      'stream-json',
      '--include-hook-events',
      '-p',
      prompt,
    ];
    const claudeModel = inputs.model ?? inputs.claudeModel ?? this.claudeModel;
    if (claudeModel) args.push('--model', claudeModel);

    for (const dir of [pluginRoot, ...(inputs.pluginRoots ?? [])]) {
      args.push('--plugin-dir', dir);
    }

    const env = buildAgentEnv({
      IMPL_STATE_DIR: inputs.implStateDir,
      WORKING_DIR: inputs.workingDir,
      JINN_WORKING_DIR: inputs.workingDir,
      JINN_CLAUDE_CODE_LEARNER_PLUGIN_ROOT: pluginRoot,
      DESIRED_STATE_ID: inputs.taskId,
      DESIRED_STATE_DESCRIPTION: stringField(inputs.taskBody?.description),
      DESIRED_STATE_CONTEXT: taskContextJson(inputs),
      DESIRED_STATE_ROLE: stringField(inputs.taskBody?.role),
      DESIRED_STATE_SOLVER_TYPE: stringField(inputs.taskBody?.solverType ?? inputs.solverType),
      RESTORATION_REQUEST_ID: stringField(inputs.taskBody?.restorationRequestId),
      REQUEST_ID: inputs.requestId ?? inputs.taskId,
      STORE_PATH: this.storePath ?? '',
      DAEMON_API_URL: this.daemonApiUrl ?? '',
      DAEMON_API_TOKEN: this.daemonApiToken ?? '',
      JINN_CORPUS_SUBGRAPH_URL: this.corpusEnv?.subgraphUrl ?? '',
      JINN_CORPUS_IPFS_GATEWAY_URL: this.corpusEnv?.ipfsGatewayUrl ?? '',
      JINN_CORPUS_RPC_URL: this.corpusEnv?.rpcUrl ?? '',
      JINN_CORPUS_CHAIN_ID: this.corpusEnv?.chainId != null ? String(this.corpusEnv.chainId) : '',
      JINN_CORPUS_IDENTITY_REGISTRY_ADDRESS: this.corpusEnv?.identityRegistryAddress ?? '',
      JINN_CORPUS_FROM_BLOCK: this.corpusEnv?.fromBlock != null ? String(this.corpusEnv.fromBlock) : '',
      ...(inputs.adapterEnv ?? {}),
    });

    const spawnOpts: SpawnOptions = {
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
      cwd: inputs.workingDir,
    };

    return new Promise<void>((resolve, reject) => {
      const logDir = join(inputs.workingDir, '.claude-code');
      mkdirSync(logDir, { recursive: true });
      const stdoutLog = createWriteStream(join(logDir, 'stdout.jsonl'), { flags: 'a' });
      const stderrLog = createWriteStream(join(logDir, 'stderr.log'), { flags: 'a' });
      const stdoutDone = finished(stdoutLog).then(() => null, captureLogError);
      const stderrDone = finished(stderrLog).then(() => null, captureLogError);
      const closeLogs = async (): Promise<void> => {
        if (!stdoutLog.writableEnded) stdoutLog.end();
        if (!stderrLog.writableEnded) stderrLog.end();
        const [stdoutErr, stderrErr] = await Promise.all([stdoutDone, stderrDone]);
        if (stdoutErr) throw stdoutErr;
        if (stderrErr) throw stderrErr;
      };
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
      child.stdout?.on('data', (d: Buffer) => {
        stdoutLog.write(d);
      });
      child.stderr?.on('data', (d: Buffer) => {
        stderrLog.write(d);
        stderr += d.toString();
      });

      let settled = false;
      const settleAfterLogs = (
        complete: () => void,
        onLogError: (err: Error) => void = reject,
      ) => {
        if (settled) return;
        settled = true;
        inputs.abort.removeEventListener('abort', onAbort);
        closeLogs().then(complete, onLogError);
      };

      child.on('exit', (code, signal) => {
        settleAfterLogs(() => {
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
      });

      child.on('error', (err) => {
        settleAfterLogs(() => reject(err), () => reject(err));
      });
    });
  }
}
