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
  _runSessionStartHook?: boolean;
}

const DEFAULT_CODEX_MODEL = 'gpt-5.4-mini';
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

/**
 * Construct the initial task prompt for the Codex Code agent.
 *
 * The harness deliberately does NOT bake SolverNet-specific guidance into
 * this prompt. Per-SolverNet task patterns (repo setup, schema shape,
 * submission expectations) live in the SolverPlugin's SKILL.md files
 * (e.g. `swe-rebench-v2-runtime/skills/orient/SKILL.md` +
 * `plan/SKILL.md`). The adapter loads those skills via the projected
 * plugin root and the agent picks them up at runtime. Adding SolverNet
 * branching here would re-create the leak that retired the earlier
 * `sweRebenchV2Guidance()` helper — every new SolverNet would require a
 * code change in every adapter's prompt builder.
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
    this.storePath = config.storePath;
    this.daemonApiUrl = config.daemonApiUrl;
    this.daemonApiToken = config.daemonApiToken;
    this.corpusEnv = config.corpusEnv;
    this.clientRoot = config.clientRoot ?? defaultClientRoot();
    this.spawnFn = config._spawnFn ?? spawn;
    this.runSessionStartHook = config._runSessionStartHook ?? true;
  }

  async runTask(inputs: TaskSessionInputs, pluginRoot: string): Promise<void> {
    const prompt = buildInitialPrompt(inputs);
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
      ...(inputs.adapterEnv ?? {}),
    };
    const env = buildAgentEnv(baseEnv);

    if (this.runSessionStartHook) {
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
    for (const configArg of prepared.configArgs) {
      args.push('-c', configArg);
    }
    args.push(prompt);

    const spawnOpts: SpawnOptions = {
      stdio: ['ignore', 'pipe', 'pipe'],
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
