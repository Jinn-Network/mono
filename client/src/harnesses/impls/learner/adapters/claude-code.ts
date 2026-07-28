import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { createWriteStream, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { finished } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { inspectLearnerTerminalEvidence } from '../lifecycle-artifacts.js';
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
    /** Discovery indexer URL (Ponder). Sets JINN_DISCOVERY_URL on the MCP subprocess. */
    discoveryUrl?: string;
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
   * Root of the Jinn client install (the dir containing `dist/`/`src/`).
   * Forwarded to the Network Tools MCP launcher as
   * `JINN_NETWORK_TOOLS_CLIENT_ROOT` so it can resolve the real Jinn MCP
   * server. Defaults to {@link defaultClientRoot} (derived from this
   * module's location). Tests override it.
   */
  clientRoot?: string;
  /**
   * Override spawn for testing. When provided, called instead of
   * node:child_process.spawn so tests can inject a fake child process.
   */
  _spawnFn?: typeof spawn;
  /**
   * Override the process-group kill for testing (#883). Called as
   * `(childPid, signal)` and expected to signal the child's whole process
   * group (`process.kill(-childPid, signal)`) so leaked grandchildren are
   * reaped. Injected by tests so they never fire a real signal.
   */
  _killProcessGroup?: (childPid: number, signal: NodeJS.Signals) => void;
}

/**
 * Resolve the Jinn client install root from this module's runtime location.
 *
 * The Network Tools plugin (`bundled:network-tools`) is materialized into the
 * operator vendor root (`~/.jinn-client/solver-plugins/network-tools`), so the
 * plugin's own MCP launcher cannot find the client tree via `../..` — that
 * resolves to `~/.jinn-client`, which has no `dist/mcp/server.js` or
 * `src/mcp/server.ts`, and the server process exits non-zero (`status:failed`
 * in the agent's MCP server list). This adapter runs *inside* the client
 * process, so it can hand the launcher the real client root via
 * `JINN_NETWORK_TOOLS_CLIENT_ROOT`.
 *
 * Layout (mirrors `defaultClientRoot` in `codex-code.ts`):
 *   - source: `<client>/src/harnesses/impls/learner/adapters/claude-code.ts`
 *   - compiled: `<client>/dist/harnesses/impls/learner/adapters/claude-code.js`
 * Five levels up reaches `<client>` in both layouts. The launcher's
 * `firstExistingServer(<client>)` then finds `<client>/dist/mcp/server.js`
 * (built/published) or `<client>/src/mcp/server.ts` (source checkout).
 */
function defaultClientRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, '..', '..', '..', '..', '..');
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

type ClaudeResult = {
  subtype: unknown;
};

function workspaceGuidance(inputs: TaskSessionInputs): string[] {
  if (!inputs.taskWorkspaceDir) {
    return ['Keep all task work inside `workingDir`.'];
  }
  return [
    '`workingDir` is the episode root, not the task repository.',
    'Task inspection, mutation, and verification must happen only in `taskWorkspaceDir`.',
    'Learner telemetry and harness artifacts must remain under `workingDir`.',
    'Do not create task repository files directly under `workingDir` outside `taskWorkspaceDir`.',
  ];
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
    ...workspaceGuidance(inputs),
    'When the task requires a typed SolverNet payload, call submit_typed_payload. Do not write .execute/solution-payload.json directly unless submit_typed_payload is unavailable; if fallback is required, the file must match the exact SolverNet schema.',
    '',
    'Session inputs:',
    `- goal.id = ${inputs.taskId}`,
    inputs.taskCid ? `- goal.cid = ${inputs.taskCid}` : '',
    `- workingDir = ${inputs.workingDir}`,
    inputs.taskWorkspaceDir
      ? `- taskWorkspaceDir = ${inputs.taskWorkspaceDir}`
      : '',
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
  private readonly clientRoot: string;
  private readonly spawnFn: typeof spawn;
  private readonly killProcessGroup: (childPid: number, signal: NodeJS.Signals) => void;

  constructor(config: ClaudeCodeHarnessAdapterConfig = {}) {
    this.claudePath = config.claudePath ?? 'claude';
    this.claudeModel = config.claudeModel;
    this.storePath = config.storePath;
    this.daemonApiUrl = config.daemonApiUrl;
    this.daemonApiToken = config.daemonApiToken;
    this.corpusEnv = config.corpusEnv;
    this.pluginInstallDir = config.pluginInstallDir ?? join(homedir(), '.claude', 'plugins');
    this.clientRoot = config.clientRoot ?? defaultClientRoot();
    this.spawnFn = config._spawnFn ?? spawn;
    this.killProcessGroup =
      config._killProcessGroup ?? ((childPid, signal) => { process.kill(-childPid, signal); });
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
      // Mode reaches the SessionStart hook so its steer is mode-aware: in `train`
      // it steers the full learn loop (persist lessons); in `frozen` it must NOT
      // (any implStateDir write trips the freeze-fence → the held-out eval aborts).
      // Default 'train' (the daemon's normal restoration path).
      JINN_HARNESS_MODE: inputs.mode ?? 'train',
      WORKING_DIR: inputs.workingDir,
      JINN_WORKING_DIR: inputs.workingDir,
      JINN_CLAUDE_CODE_LEARNER_PLUGIN_ROOT: pluginRoot,
      // Network Tools' MCP launcher reads this to locate the real Jinn MCP
      // server. The `bundled:network-tools` plugin is materialized into the
      // operator vendor root, detached from the client tree, so its own
      // `../..` resolution fails — without this the jinn-client MCP server
      // exits non-zero and the agent never gets submit_typed_payload.
      // Honor an operator-supplied value if present (e.g. custom install).
      JINN_NETWORK_TOOLS_CLIENT_ROOT:
        process.env.JINN_NETWORK_TOOLS_CLIENT_ROOT?.trim() || this.clientRoot,
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
      JINN_DISCOVERY_URL: this.corpusEnv?.discoveryUrl ?? '',
      JINN_DISCOVERY_MODE: this.corpusEnv?.discoveryUrl ? 'http' : 'onchain',
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
      // #883: run claude as its own process-group leader so we can reap the
      // WHOLE group (claude + any tool subprocesses it leaks, e.g. a `while …;
      // do sleep; done` shell). Killing just the claude pid would orphan
      // those grandchildren.
      detached: process.platform !== 'win32',
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

      // #883: reap the child AND its process group, so a tool subprocess the
      // model leaked (e.g. an unbounded `while …; do sleep; done` shell) dies
      // too. Killing only the claude pid would orphan such a grandchild — and
      // because that live grandchild keeps claude's event loop alive, claude
      // itself would never exit (the observed hang). SIGKILL backstops SIGTERM.
      const reap = (signal: NodeJS.Signals): void => {
        if (typeof child.pid === 'number') {
          try { this.killProcessGroup(child.pid, signal); } catch { /* group already gone */ }
        }
        try { if (!child.killed) child.kill(signal); } catch { /* already dead */ }
      };

      // If the abort signal already fired before we got here (race), kill
      // the child immediately. Without this, addEventListener below would
      // never fire (signals only emit on transition to aborted, not when
      // already aborted).
      if (inputs.abort.aborted) {
        reap('SIGTERM');
      }

      // Window-end abort: kill the child group; the exit/result path resolves.
      const onAbort = () => {
        reap('SIGTERM');
      };
      inputs.abort.addEventListener('abort', onAbort);

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

      // #883: once learner artifacts prove the session is terminal, reap the
      // process group on claude's result instead of waiting for an exit that a
      // leaked tool subprocess may prevent. Claude can also emit `result` at
      // intermediate wakeup boundaries, so the stream marker alone is not
      // terminal evidence.
      let stdoutBuf = '';
      let latestResult: ClaudeResult | undefined;
      const reapTerminalProcess = (): void => {
        reap('SIGTERM');
        const killTimer = setTimeout(() => reap('SIGKILL'), 2000);
        if (typeof killTimer.unref === 'function') killTimer.unref();
      };
      const settleSuccessfulOrFailedResult = (result: ClaudeResult): void => {
        if (result.subtype === undefined || result.subtype === 'success') {
          resolve();
        } else {
          reject(
            new Error(
              `claude-code adapter: session ended with result subtype=${String(result.subtype)}`,
            ),
          );
        }
      };
      const learnerFailureError = (errorArtifact: string): Error => {
        const artifact = relative(inputs.workingDir, errorArtifact) || errorArtifact;
        return new Error(
          `claude-code adapter: learner reported terminal failure artifact ${artifact}`,
        );
      };
      const onResult = (result: ClaudeResult): boolean => {
        if (settled) return true;
        latestResult = result;
        const evidence = inspectLearnerTerminalEvidence({
          workingDir: inputs.workingDir,
          mode: inputs.mode,
          phaseRange: inputs.adapterEnv?.LEARNER_PHASE_RANGE,
        });
        if (evidence.kind === 'incomplete') return false;

        reapTerminalProcess();
        if (evidence.kind === 'failure') {
          settleAfterLogs(() => reject(learnerFailureError(evidence.errorArtifact)));
        } else {
          settleAfterLogs(() => settleSuccessfulOrFailedResult(result));
        }
        return true;
      };

      const incompleteExitError = (missingArtifacts: readonly string[]): Error => {
        const missing = missingArtifacts
          .slice(0, 3)
          .map((path) => relative(inputs.workingDir, path) || path)
          .join(', ');
        return new Error(
          `claude-code adapter: child exited before learner terminal evidence${missing ? `: ${missing}` : ''}`,
        );
      };

      let stderr = '';
      child.stdout?.on('data', (d: Buffer) => {
        // Guard against ERR_STREAM_WRITE_AFTER_END: once the session settles,
        // closeLogs() ends these streams, but the reaped child (SIGTERM, not
        // instant) can still emit bytes. An unguarded write here throws
        // "write after end", which surfaces as an engine tick failure.
        if (!stdoutLog.writableEnded) stdoutLog.write(d);
        if (settled) return;
        stdoutBuf += d.toString();
        let nl: number;
        while ((nl = stdoutBuf.indexOf('\n')) >= 0) {
          const line = stdoutBuf.slice(0, nl).trim();
          stdoutBuf = stdoutBuf.slice(nl + 1);
          if (!line.includes('"type":"result"')) continue;
          try {
            const obj = JSON.parse(line) as { type?: unknown; subtype?: unknown };
            if (obj && obj.type === 'result') {
              if (onResult({ subtype: obj.subtype })) return;
            }
          } catch { /* partial or non-JSON line; keep scanning */ }
        }
      });
      child.stderr?.on('data', (d: Buffer) => {
        if (!stderrLog.writableEnded) stderrLog.write(d);
        stderr += d.toString();
      });

      child.on('exit', (code, signal) => {
        const evidence = inspectLearnerTerminalEvidence({
          workingDir: inputs.workingDir,
          mode: inputs.mode,
          phaseRange: inputs.adapterEnv?.LEARNER_PHASE_RANGE,
        });
        settleAfterLogs(() => {
          if (inputs.abort.aborted) {
            // Window expired; resolve anyway so harvester can collect
            // partial outputs. The shim's caller (engine) handles the
            // abort signal separately.
            resolve();
          } else if (code !== 0) {
            reject(
              new Error(
                `claude-code adapter: child exited with code=${code} signal=${signal}: ${stderr.slice(0, 500)}`,
              ),
            );
          } else if (evidence.kind === 'failure') {
            reject(learnerFailureError(evidence.errorArtifact));
          } else if (evidence.kind === 'incomplete') {
            reject(incompleteExitError(evidence.missingArtifacts));
          } else if (latestResult) {
            settleSuccessfulOrFailedResult(latestResult);
          } else {
            resolve();
          }
        });
      });

      child.on('error', (err) => {
        settleAfterLogs(() => reject(err), () => reject(err));
      });
    });
  }
}
