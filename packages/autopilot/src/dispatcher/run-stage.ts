import { spawn as nodeSpawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  headlessOverrideFor,
} from '../headless.js';
import {
  AUTOPILOT_RUNTIME_ENV,
  parseAutopilotRuntime,
  type AutopilotRuntime,
} from '../autopilot-runtime.js';
import {
  isGitHubSecretEnvironmentKey,
} from '../lifecycle/credentials.js';
import { loadCanon } from './coordinator-session.js';
import {
  assertHermesBillingRoute,
  hermesChatArgs,
} from './hermes-runtime.js';
import {
  CURSOR_BIN_ENV,
  CURSOR_MODEL_ENV,
  cursorAgentArgs,
} from './cursor-runtime.js';

/**
 * A minimal child handle the stage runner needs: stdout/stderr streams to
 * capture, a `close` event to await, and `kill` for the timeout path.
 * (Richer than dispatch.ts's `{ pid }`-only `SpawnResult` — do not conflate;
 * dispatch.ts's `SpawnFn` is for the detached coordinator spawn, this one
 * captures output so the coordinator reads the stage report.)
 */
export interface StageChild {
  stdout: { on(event: 'data', cb: (chunk: Buffer) => void): void } | null;
  stderr: { on(event: 'data', cb: (chunk: Buffer) => void): void } | null;
  on(event: 'close', cb: (code: number | null) => void): void;
  kill(signal?: NodeJS.Signals): void;
}

/**
 * Injectable spawn for stage sessions. Production wraps `node:child_process`
 * `spawn` with captured stdio; tests inject a fake that records the call and
 * drives close/timeout deterministically.
 */
export type StageSpawnFn = (
  cmd: string,
  args: string[],
  opts: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    stdio: Array<'ignore' | 'pipe'>;
  },
) => StageChild;

/** Result of a stage session — same shape as SkillRunResult. */
export interface StageRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface StageRunOpts {
  /**
   * The fully-curated stage prompt (stage task + issue body/ACs + prior-stage
   * outputs) that the coordinator writes to the `--prompt-file`. This helper
   * does NOT assemble those pieces — the coordinator owns curation (SKILL.md
   * Step 4); the only things prepended here are canon (CLAUDE.md + handbook)
   * and the headless-override block.
   */
  stageTask: string;
  /** Absolute worktree path — becomes the session `cwd` (AC#5 isolation). */
  worktreePath: string;
  /** Optional model override for this stage session. */
  model?: string;
  /** Hermes venv Python interpreter. */
  hermesPythonPath?: string;
  /** Explicit Hermes provider (for example, the subscription-backed provider). */
  provider?: string;
  /** Cursor Agent CLI binary override. */
  cursorBin?: string;
  /** Wall-clock ceiling; default 10 minutes (pressure-suite starting value). */
  timeoutMs?: number;
  /** Coordinator environment to reduce to a non-authoritative stage view. */
  environment?: NodeJS.ProcessEnv;
}

const DEFAULT_TIMEOUT_MS = 600_000;

/**
 * Compose the stage prompt: canon (CLAUDE.md + handbook), then the
 * headless-override block (so the root-session stage self-approves), then the
 * coordinator's curated stage prompt. Plain string join, mirroring
 * dispatch.ts's coordinator prompt (canon first, then the headless part).
 *
 * Canon is prepended because each stage runs as its own runtime root session.
 * In particular, Claude `-p` mode does not auto-load CLAUDE.md. We reuse
 * dispatch.ts's `loadCanon` so all runtimes and both call sites stay in
 * lockstep (and the repo-root derivation lives in one place).
 *
 * NOTE: this prepends BOTH canon and the runtime-specific headless override.
 * The `stageTask` passed in is already curated (the CLI shim reads it from the
 * prompt-file), so it must NOT include canon OR the override block itself —
 * either would double-inject.
 */
export function buildStagePrompt(
  opts: Pick<StageRunOpts, 'stageTask' | 'worktreePath'>,
  runtime: AutopilotRuntime = parseAutopilotRuntime(
    process.env[AUTOPILOT_RUNTIME_ENV],
  ),
): string {
  return [
    loadCanon(),
    '',
    headlessOverrideFor(runtime),
    '',
    opts.stageTask.trim(),
    '',
    `Worktree: ${opts.worktreePath}. Do all work here.`,
  ].join('\n');
}

/** Production spawn with captured stdout/stderr for either runtime. */
const defaultStageSpawn: StageSpawnFn = (cmd, args, opts) =>
  nodeSpawn(cmd, args, opts) as unknown as StageChild;

function requireHermesValue(
  value: string | undefined,
  envName: string,
): string {
  if (value == null || value === '') {
    throw new Error(`[autopilot] Hermes runtime is missing ${envName}.`);
  }
  return value;
}

function requireCursorValue(
  value: string | undefined,
  envName: string,
): string {
  if (value == null || value === '') {
    throw new Error(`[autopilot] Cursor runtime is missing ${envName}.`);
  }
  return value;
}

function isGitConfigEnvironmentKey(key: string): boolean {
  return /^GIT_CONFIG(?:_|$)/i.test(key);
}

function isSshCredentialEnvironmentKey(key: string): boolean {
  return /^(?:SSH_AUTH_SOCK|SSH_AGENT_PID|GIT_SSH|GIT_SSH_COMMAND)$/i.test(key);
}

const STAGE_AUTHORITY_ENVIRONMENT_KEYS = new Set([
  'GH_CONFIG_DIR',
  'GIT_ASKPASS',
  'SSH_ASKPASS',
  'GIT_TERMINAL_PROMPT',
  'JINN_AUTOPILOT_SESSION_MANIFEST',
  'JINN_AUTOPILOT_CAPABILITY_ATTESTATION',
]);

/**
 * Stage roots need model/runtime configuration, but never the coordinator's
 * GitHub identity or manifest-bound lifecycle authority.
 */
export function buildUnprivilegedStageEnvironment(
  ambient: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(ambient)) {
    if (
      !isGitHubSecretEnvironmentKey(key)
      && !isGitConfigEnvironmentKey(key)
      && !isSshCredentialEnvironmentKey(key)
      && !STAGE_AUTHORITY_ENVIRONMENT_KEYS.has(key.toUpperCase())
    ) {
      environment[key] = value;
    }
  }
  return {
    ...environment,
    GH_CONFIG_DIR: join(
      tmpdir(),
      `jinn-autopilot-stage-no-auth-${process.pid}`,
    ),
    GIT_CONFIG_COUNT: '3',
    GIT_CONFIG_KEY_0: 'credential.helper',
    GIT_CONFIG_VALUE_0: '',
    GIT_CONFIG_KEY_1: 'credential.interactive',
    GIT_CONFIG_VALUE_1: 'never',
    GIT_CONFIG_KEY_2: 'core.askPass',
    GIT_CONFIG_VALUE_2: 'false',
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: 'false',
    SSH_ASKPASS: 'false',
    GIT_SSH_COMMAND: 'false',
  };
}

/**
 * Run a pipeline stage as a fresh root session in the issue worktree.
 * Depth-0 lets the stage's composed skill fan out sub-agents at depth-1.
 */
export function runStageHeadless(
  opts: StageRunOpts,
  spawn: StageSpawnFn = defaultStageSpawn,
): Promise<StageRunResult> {
  const ambient = opts.environment ?? process.env;
  const runtime = parseAutopilotRuntime(ambient[AUTOPILOT_RUNTIME_ENV]);
  const prompt = buildStagePrompt(opts, runtime);
  let cmd: string;
  let args: string[];
  if (runtime === 'hermes') {
    const pythonPath = requireHermesValue(
      opts.hermesPythonPath ?? ambient.JINN_DISPATCHER_HERMES_PYTHON,
      'JINN_DISPATCHER_HERMES_PYTHON',
    );
    const model = requireHermesValue(
      opts.model ?? ambient.JINN_DISPATCHER_HERMES_MODEL,
      'JINN_DISPATCHER_HERMES_MODEL',
    );
    const provider = requireHermesValue(
      opts.provider ?? ambient.JINN_DISPATCHER_HERMES_PROVIDER,
      'JINN_DISPATCHER_HERMES_PROVIDER',
    );
    assertHermesBillingRoute(model, provider);
    cmd = pythonPath;
    args = hermesChatArgs(prompt, { model, provider });
  } else if (runtime === 'cursor') {
    const binPath = requireCursorValue(
      opts.cursorBin ?? ambient[CURSOR_BIN_ENV],
      CURSOR_BIN_ENV,
    );
    const model = requireCursorValue(
      opts.model ?? ambient[CURSOR_MODEL_ENV],
      CURSOR_MODEL_ENV,
    );
    cmd = binPath;
    args = cursorAgentArgs(prompt, { model, workspace: opts.worktreePath });
  } else {
    cmd = 'claude';
    args = ['-p', ...(opts.model ? ['--model', opts.model] : []), prompt];
  }
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return new Promise((resolve) => {
    const proc = spawn(cmd, args, {
      cwd: opts.worktreePath,
      env: buildUnprivilegedStageEnvironment(ambient),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    proc.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
    proc.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
    const timer = setTimeout(() => { timedOut = true; proc.kill('SIGTERM'); }, timeoutMs);
    proc.on('close', (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code ?? -1, stdout, stderr, timedOut });
    });
  });
}
