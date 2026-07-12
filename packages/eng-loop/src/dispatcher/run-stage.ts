import { spawn as nodeSpawn } from 'node:child_process';
import { headlessOverride } from '../headless.js';

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
  opts: { cwd: string; stdio: Array<'ignore' | 'pipe'> },
) => StageChild;

/** Result of a stage session — same shape as SkillRunResult. */
export interface StageRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface StageRunOpts {
  /** The stage's task, verbatim from the SKILL.md step. */
  stageTask: string;
  /** The issue body (context, impact, acceptance criteria, file hints). */
  issueBody: string;
  /** Absolute worktree path — becomes the session `cwd` (AC#5 isolation). */
  worktreePath: string;
  /** The branch name for this issue's worktree. */
  branch: string;
  /** Relevant prior-stage outputs (design note, plan, diff, etc.). */
  priorOutputs?: string;
  /** Optional model override for this stage session. */
  model?: string;
  /** Wall-clock ceiling; default 10 minutes (pressure-suite starting value). */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 600_000;

/**
 * Compose the stage prompt: the headless-override block (so the root-session
 * stage self-approves), then the curated stage context. Plain string join,
 * mirroring buildHeadlessPrompt.
 *
 * NOTE: this prepends `headlessOverride()`. Callers passing a pre-curated
 * prompt as `stageTask` (the CLI shim does this) must NOT include the override
 * block themselves — that would double-inject it.
 */
export function buildStagePrompt(
  opts: Pick<StageRunOpts, 'stageTask' | 'issueBody' | 'worktreePath' | 'branch' | 'priorOutputs'>,
): string {
  const parts = [
    headlessOverride(),
    '',
    opts.stageTask.trim(),
    '',
    `Worktree: ${opts.worktreePath} (branch ${opts.branch}). Do all work here.`,
  ];
  if (opts.issueBody.trim()) {
    parts.push('', '## Issue body', opts.issueBody.trim());
  }
  if (opts.priorOutputs && opts.priorOutputs.trim()) {
    parts.push('', '## Prior-stage outputs', opts.priorOutputs.trim());
  }
  return parts.join('\n');
}

/** Production spawn: real `claude -p` root session with captured stdout/stderr. */
const defaultStageSpawn: StageSpawnFn = (cmd, args, opts) =>
  nodeSpawn(cmd, args, opts) as unknown as StageChild;

/**
 * Run a pipeline stage as a fresh `claude -p` ROOT session in the issue
 * worktree. Depth-0, so the stage's composed skill can fan out sub-agents at
 * depth-1 (the whole point — an Agent-tool dispatch would sit at depth-1 and
 * its inner fan-out would silently no-op).
 */
export function runStageHeadless(
  opts: StageRunOpts,
  spawn: StageSpawnFn = defaultStageSpawn,
): Promise<StageRunResult> {
  const prompt = buildStagePrompt(opts);
  const args = ['-p', ...(opts.model ? ['--model', opts.model] : []), prompt];
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return new Promise((resolve) => {
    const proc = spawn('claude', args, {
      cwd: opts.worktreePath,
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
