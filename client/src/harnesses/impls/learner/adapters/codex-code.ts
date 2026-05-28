import { spawn, spawnSync, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { accessSync, constants, createWriteStream, mkdirSync } from 'node:fs';
import { isIP } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { finished } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { prepareCodexPluginWorkspace } from './codex-workspace.js';
import type { HarnessAdapter, TaskSessionInputs } from '../types.js';

export interface CodexCodeHarnessAdapterConfig {
  codexPath?: string;
  codexModel?: string;
  codexBaseUrl?: string;
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
  _runSessionStartHook?: boolean;
}

const DEFAULT_CODEX_MODEL = 'gpt-5.4-mini';
const LOCAL_CODEX_PROVIDER = 'jinn-local';
const MACOS_CODEX_APP_BINARY = '/Applications/Codex.app/Contents/Resources/codex';

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

function codexConfigPath(parts: string[]): string {
  return parts.map((part) =>
    /^[A-Za-z0-9_-]+$/.test(part)
      ? part
      : `"${part.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
  ).join('.');
}

function codexConfigValue(value: string): string {
  return JSON.stringify(value);
}

export function isLocalCodexBaseUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    if (url.username || url.password) return false;
    const hostname = url.hostname.toLowerCase();
    if (hostname === 'localhost') return true;
    if (hostname === '[::1]' || hostname === '::1') return true;
    return isIP(hostname) === 4 && hostname.startsWith('127.');
  } catch {
    return false;
  }
}

function codexProviderConfigArgs(baseUrl: string | undefined): string[] {
  const normalizedBaseUrl = baseUrl?.trim();
  if (!normalizedBaseUrl) return [];
  if (normalizedBaseUrl && !isLocalCodexBaseUrl(normalizedBaseUrl)) {
    throw new Error('codex-code adapter: codexBaseUrl must be local; remote custom providers are not supported');
  }

  const args = [`model_provider=${codexConfigValue(LOCAL_CODEX_PROVIDER)}`];
  if (normalizedBaseUrl) {
    const prefix = ['model_providers', LOCAL_CODEX_PROVIDER];
    args.push(`${codexConfigPath([...prefix, 'name'])}=${codexConfigValue(LOCAL_CODEX_PROVIDER)}`);
    args.push(`${codexConfigPath([...prefix, 'base_url'])}=${codexConfigValue(normalizedBaseUrl)}`);
    args.push(`${codexConfigPath([...prefix, 'wire_api'])}=${codexConfigValue('responses')}`);
  }
  return args;
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
function buildInitialPrompt(inputs: TaskSessionInputs): string {
  return [
    'You are executing a Jinn task.',
    'Complete the task described by the task payload below.',
    'Use the available skills, plugins, tools, and runtime context exposed by this harness.',
    'Keep all task work inside `workingDir`.',
    'When the task requires a typed SolverNet payload, call submit_typed_payload. Do not write .execute/solution-payload.json directly unless submit_typed_payload is unavailable; if fallback is required, the file must match the exact SolverNet schema.',
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

function captureLogError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

export class CodexCodeHarnessAdapter implements HarnessAdapter {
  readonly name = 'codex-code';
  readonly allowsHarnessSelfModification = false;

  private readonly codexPath: string;
  private readonly codexModel: string;
  private readonly codexBaseUrl: string | undefined;
  private readonly storePath: string | undefined;
  private readonly daemonApiUrl: string | undefined;
  private readonly daemonApiToken: string | undefined;
  private readonly corpusEnv: CodexCodeHarnessAdapterConfig['corpusEnv'];
  private readonly clientRoot: string;
  private readonly spawnFn: typeof spawn;
  private readonly runSessionStartHook: boolean;

  constructor(config: CodexCodeHarnessAdapterConfig = {}) {
    this.codexPath = config.codexPath ?? defaultCodexPath();
    this.codexModel = config.codexModel ?? DEFAULT_CODEX_MODEL;
    this.codexBaseUrl = config.codexBaseUrl;
    this.storePath = config.storePath;
    this.daemonApiUrl = config.daemonApiUrl;
    this.daemonApiToken = config.daemonApiToken;
    this.corpusEnv = config.corpusEnv;
    this.clientRoot = config.clientRoot ?? defaultClientRoot();
    this.spawnFn = config._spawnFn ?? spawn;
    this.runSessionStartHook = config._runSessionStartHook ?? true;
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
    const prompt = buildInitialPrompt(inputs);
    const usingLocalProvider = this.codexBaseUrl !== undefined && isLocalCodexBaseUrl(this.codexBaseUrl);
    const baseEnv = {
      IMPL_STATE_DIR: inputs.implStateDir,
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
      ...(usingLocalProvider && !process.env['OPENAI_API_KEY'] ? { OPENAI_API_KEY: 'jinn-local' } : {}),
      ...(inputs.adapterEnv ?? {}),
    };
    const env = buildAgentEnv(baseEnv);

    if (this.runSessionStartHook) {
      // Sync spawnSync is acceptable here (#778, #398): this runs once per
      // claimed task during the synchronous `runTask` setup phase before the
      // long-running codex child is spawned. The hook is a well-known
      // session-start script (not an unbounded user diff), runs against the
      // task's working dir, and any hang would already trip the harness's
      // outer task-execution timeout. The wedge fixed in #778 was the
      // post-execution `git diff --binary` in harvest.ts, which ran on every
      // delivery on the main thread with no upstream timeout.
      const hook = spawnSync('bash', [join(pluginRoot, 'hooks', 'session-start')], {
        cwd: inputs.workingDir,
        env,
        encoding: 'utf8',
      });
      if (hook.status !== 0) {
        throw new Error(
          `codex-code adapter: session-start hook failed: ${(hook.stderr || hook.stdout || '').slice(0, 500)}`,
        );
      }
    }

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
    for (const configArg of codexProviderConfigArgs(this.codexBaseUrl)) {
      args.push('-c', configArg);
    }
    for (const configArg of prepared.configArgs) {
      args.push('-c', configArg);
    }

    const spawnOpts: SpawnOptions = {
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
      cwd: inputs.workingDir,
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

      if (inputs.abort.aborted) {
        if (!child.killed) child.kill('SIGTERM');
      }

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
