import { spawn, spawnSync, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { accessSync, constants, createWriteStream, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { finished } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { prepareCodexPluginWorkspace } from './codex-workspace.js';
import type { HarnessAdapter, TaskSessionInputs } from '../types.js';

export interface CodexCodeHarnessAdapterConfig {
  codexPath?: string;
  codexModel?: string;
  storePath?: string;
  daemonApiUrl?: string;
  daemonApiToken?: string;
  corpusEnv?: {
    /** Discovery indexer URL (Ponder). Sets JINN_DISCOVERY_URL on the MCP subprocess. */
    discoveryUrl?: string;
    ipfsGatewayUrl?: string;
    rpcUrl?: string;
    chainId?: number;
    identityRegistryAddress?: string;
    fromBlock?: number;
  };
  clientRoot?: string;
  _spawnFn?: typeof spawn;
  _spawnSyncFn?: typeof spawnSync;
  _runSessionStartHook?: boolean;
  /**
   * Override the process-group kill for testing (#895, mirrors #883). Called
   * as `(childPid, signal)` and expected to signal the child's whole process
   * group (`process.kill(-childPid, signal)`) so leaked grandchildren are
   * reaped. Injected by tests so they never fire a real signal.
   */
  _killProcessGroup?: (childPid: number, signal: NodeJS.Signals) => void;
}

const DEFAULT_CODEX_MODEL = 'gpt-5.4-mini';
const MACOS_CODEX_APP_BINARY = '/Applications/Codex.app/Contents/Resources/codex';
const SESSION_START_SHELL = '/bin/bash';

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
  'OPENAI_API_KEY',
  'CODEX_HOME',
  'JINN_CODEX_PATH',
];

function defaultClientRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, '..', '..', '..', '..', '..');
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function defaultCodexPath(): string {
  const explicit = process.env['JINN_CODEX_PATH']?.trim();
  if (explicit) return explicit;
  if (isExecutable(MACOS_CODEX_APP_BINARY)) return MACOS_CODEX_APP_BINARY;
  return 'codex';
}

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
 * Construct the initial task prompt for the Codex Code agent.
 *
 * The harness deliberately does NOT bake SolverNet-specific guidance into
 * this prompt. Per-SolverNet task patterns (repo setup, schema shape,
 * submission expectations) live in the SolverPlugin's SKILL.md files
 * (e.g. `swe-rebench-v2-runtime/skills/task/SKILL.md`). The adapter loads
 * those skills via the projected plugin root and the agent picks them up
 * at runtime. Adding SolverNet branching here would re-create the leak
 * that retired the earlier `sweRebenchV2Guidance()` helper — every new
 * SolverNet would require a code change in every adapter's prompt
 * builder.
 */
function buildInitialPrompt(inputs: TaskSessionInputs, sessionStartContext = ''): string {
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
    sessionStartContext.trim()
      ? `\nSession start context:\n${sessionStartContext.trim()}`
      : '',
    inputs.taskBody
      ? `\ngoal (full body):\n${JSON.stringify(inputs.taskBody, null, 2)}`
      : '',
  ]
    .filter((line) => line !== '')
    .join('\n');
}

function captureLogError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

function sessionStartContextFromHookStdout(stdout: string): string {
  for (const line of stdout.split(/\r?\n/).map((item) => item.trim()).filter(Boolean)) {
    try {
      const parsed = JSON.parse(line) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
      const hookSpecificOutput = (parsed as Record<string, unknown>)['hookSpecificOutput'];
      if (!hookSpecificOutput || typeof hookSpecificOutput !== 'object' || Array.isArray(hookSpecificOutput)) {
        continue;
      }
      const record = hookSpecificOutput as Record<string, unknown>;
      if (record['hookEventName'] !== 'SessionStart') continue;
      const additionalContext = record['additionalContext'];
      if (typeof additionalContext === 'string' && additionalContext.trim()) {
        return additionalContext.trim();
      }
    } catch {
      // Codex runs hooks manually, so ignore non-JSON operational stdout. Hook
      // failure is still fail-closed via the process exit status.
    }
  }
  return '';
}

export class CodexCodeHarnessAdapter implements HarnessAdapter {
  readonly name = 'codex-code';
  readonly allowsHarnessSelfModification = false;

  private readonly codexPath: string;
  private readonly codexModel: string;
  private readonly storePath: string | undefined;
  private readonly daemonApiUrl: string | undefined;
  private readonly daemonApiToken: string | undefined;
  private readonly corpusEnv: CodexCodeHarnessAdapterConfig['corpusEnv'];
  private readonly clientRoot: string;
  private readonly spawnFn: typeof spawn;
  private readonly spawnSyncFn: typeof spawnSync;
  private readonly runSessionStartHook: boolean;
  private readonly killProcessGroup: (childPid: number, signal: NodeJS.Signals) => void;

  constructor(config: CodexCodeHarnessAdapterConfig = {}) {
    this.codexPath = config.codexPath ?? defaultCodexPath();
    this.codexModel = config.codexModel ?? DEFAULT_CODEX_MODEL;
    this.storePath = config.storePath;
    this.daemonApiUrl = config.daemonApiUrl;
    this.daemonApiToken = config.daemonApiToken;
    this.corpusEnv = config.corpusEnv;
    this.clientRoot = config.clientRoot ?? defaultClientRoot();
    this.spawnFn = config._spawnFn ?? spawn;
    this.spawnSyncFn = config._spawnSyncFn ?? spawnSync;
    this.runSessionStartHook = config._runSessionStartHook ?? true;
    this.killProcessGroup =
      config._killProcessGroup ?? ((childPid, signal) => { process.kill(-childPid, signal); });
  }

  /**
   * Spawn `codex exec` and stream the prompt to its stdin.
   *
   * Stdin contract (#675): codex >=0.133.0 detects a non-TTY-with-no-data
   * stdin as a fatal config error ("Reading additional input from stdin") and
   * exits with code 1 before reading the positional [PROMPT]. The daemon
   * therefore pipes the prompt through `child.stdin` and closes the stream;
   * the positional-arg invocation used pre-0.133 is no longer supported.
   */
  async runTask(inputs: TaskSessionInputs, pluginRoot: string): Promise<void> {
    const baseEnv = {
      IMPL_STATE_DIR: inputs.implStateDir,
      JINN_HARNESS_MODE: inputs.mode ?? 'train',
      WORKING_DIR: inputs.workingDir,
      JINN_WORKING_DIR: inputs.workingDir,
      PLUGIN_ROOT: pluginRoot,
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
      JINN_DISCOVERY_URL: this.corpusEnv?.discoveryUrl ?? '',
      JINN_DISCOVERY_MODE: this.corpusEnv?.discoveryUrl ? 'http' : 'onchain',
      JINN_CORPUS_IPFS_GATEWAY_URL: this.corpusEnv?.ipfsGatewayUrl ?? '',
      JINN_CORPUS_RPC_URL: this.corpusEnv?.rpcUrl ?? '',
      JINN_CORPUS_CHAIN_ID: this.corpusEnv?.chainId != null ? String(this.corpusEnv.chainId) : '',
      JINN_CORPUS_IDENTITY_REGISTRY_ADDRESS: this.corpusEnv?.identityRegistryAddress ?? '',
      JINN_CORPUS_FROM_BLOCK: this.corpusEnv?.fromBlock != null ? String(this.corpusEnv.fromBlock) : '',
      ...(inputs.adapterEnv ?? {}),
    };
    const env = buildAgentEnv(baseEnv);

    let sessionStartContext = '';
    if (this.runSessionStartHook) {
      // Sync spawnSync is acceptable here (#778, #398): this runs once per
      // claimed task during the synchronous `runTask` setup phase before the
      // long-running codex child is spawned. The hook is a well-known
      // session-start script (not an unbounded user diff), runs against the
      // task's working dir, and any hang would already trip the harness's
      // outer task-execution timeout. The wedge fixed in #778 was the
      // post-execution `git diff --binary` in harvest.ts, which ran on every
      // delivery on the main thread with no upstream timeout.
      const hook = this.spawnSyncFn(SESSION_START_SHELL, [join(pluginRoot, 'hooks', 'session-start')], {
        cwd: inputs.workingDir,
        env,
        encoding: 'utf8',
      });
      if (hook.status !== 0) {
        const detail = hook.stderr || hook.stdout || hook.error?.message || '';
        throw new Error(
          `codex-code adapter: session-start hook failed: ${detail.slice(0, 500)}`,
        );
      }
      sessionStartContext = sessionStartContextFromHookStdout(hook.stdout?.toString() ?? '');
    }
    const prompt = buildInitialPrompt(inputs, sessionStartContext);

    const prepared = prepareCodexPluginWorkspace({
      workingDir: inputs.workingDir,
      pluginRoots: [pluginRoot, ...(inputs.pluginRoots ?? [])],
      clientRoot: this.clientRoot,
      mcpEnv: baseEnv,
    });

    const args: string[] = [
      'exec',
      '--json',
      '--ignore-user-config',
      '--disable',
      'plugins',
      '--sandbox',
      'danger-full-access',
      '--dangerously-bypass-approvals-and-sandbox',
      '-C',
      inputs.workingDir,
      '-m',
      inputs.model ?? inputs.claudeModel ?? this.codexModel,
    ];
    for (const configArg of prepared.configArgs) {
      args.push('-c', configArg);
    }

    const spawnOpts: SpawnOptions = {
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
      cwd: inputs.workingDir,
      // #895 (mirrors #883): run codex as its own process-group leader so we
      // can reap the WHOLE group (codex + any tool subprocesses it leaks, e.g.
      // an unbounded `while …; do sleep; done` shell). Killing just the codex
      // pid would orphan those grandchildren. detached:true only changes
      // process-group leadership; the ['pipe','pipe','pipe'] stdin contract
      // (#675) is unaffected.
      detached: process.platform !== 'win32',
    };

    return new Promise<void>((resolvePromise, reject) => {
      const logDir = join(inputs.workingDir, '.codex-code');
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
      const child: ChildProcess = this.spawnFn(this.codexPath, args, spawnOpts);

      if (child.stdin) {
        // codex may close stdin early; let the exit-code branch report the
        // real failure rather than crashing this promise on EPIPE.
        child.stdin.on('error', () => {});
        child.stdin.end(prompt);
      }

      // #895 (mirrors #883): reap the child AND its process group, so a tool
      // subprocess the model leaked (e.g. an unbounded `while …; do sleep; done`
      // shell) dies too. Killing only the codex pid would orphan such a
      // grandchild — and because that live grandchild keeps codex's event loop
      // alive, codex itself would never exit (the observed hang). SIGKILL
      // backstops SIGTERM.
      const reap = (signal: NodeJS.Signals): void => {
        if (typeof child.pid === 'number') {
          try { this.killProcessGroup(child.pid, signal); } catch { /* group already gone */ }
        }
        try { if (!child.killed) child.kill(signal); } catch { /* already dead */ }
      };

      if (inputs.abort.aborted) {
        reap('SIGTERM');
      }

      const onAbort = () => {
        reap('SIGTERM');
      };
      inputs.abort.addEventListener('abort', onAbort);

      let stderr = '';
      let stdoutBuf = '';

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

      // #895 (mirrors #883): complete on codex's terminal turn marker, not
      // solely on process exit. `codex exec --json` streams
      // {"type":"turn.completed",...} when the turn ends (success) or
      // {"type":"turn.failed","error":{...}} (failure); it may then fail to
      // exit (a leaked tool subprocess holds the event loop open). Settling on
      // the marker — and reaping the group — means the task never strands in
      // RUNNING waiting for an exit that never comes. The `child.on('exit')`
      // handler below still covers crashes that emit no marker; the `settled`
      // guard makes whichever fires first win.
      const onTerminal = (type: 'turn.completed' | 'turn.failed', obj: Record<string, unknown>): void => {
        if (settled) return;
        reap('SIGTERM');
        const killTimer = setTimeout(() => reap('SIGKILL'), 2000);
        if (typeof killTimer.unref === 'function') killTimer.unref();
        settleAfterLogs(() => {
          if (type === 'turn.completed') {
            resolvePromise();
          } else {
            const errObj = obj['error'] as Record<string, unknown> | undefined;
            const errMessage = errObj?.['message'];
            const msg =
              typeof errMessage === 'string'
                ? errMessage
                : JSON.stringify(errObj ?? {});
            reject(new Error(`codex-code adapter: turn.failed: ${msg.slice(0, 500)}`));
          }
        });
      };

      child.stdout?.on('data', (d: Buffer) => {
        stdoutLog.write(d);
        if (settled) return;
        stdoutBuf += d.toString();
        let nl: number;
        while ((nl = stdoutBuf.indexOf('\n')) >= 0) {
          const line = stdoutBuf.slice(0, nl).trim();
          stdoutBuf = stdoutBuf.slice(nl + 1);
          if (!line.includes('"type":"turn.completed"') && !line.includes('"type":"turn.failed"')) continue;
          try {
            const obj = JSON.parse(line) as { type?: unknown };
            if (obj && obj.type === 'turn.completed') {
              onTerminal('turn.completed', obj as Record<string, unknown>);
              return;
            }
            if (obj && obj.type === 'turn.failed') {
              onTerminal('turn.failed', obj as Record<string, unknown>);
              return;
            }
          } catch { /* partial or non-JSON line; keep scanning */ }
        }
      });
      child.stderr?.on('data', (d: Buffer) => {
        stderrLog.write(d);
        stderr += d.toString();
      });

      child.on('exit', (code, signal) => {
        settleAfterLogs(() => {
          if (code === 0) {
            resolvePromise();
          } else if (inputs.abort.aborted) {
            resolvePromise();
          } else {
            reject(
              new Error(
                `codex-code adapter: child exited with code=${code} signal=${signal}: ${stderr.slice(0, 500)}`,
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
