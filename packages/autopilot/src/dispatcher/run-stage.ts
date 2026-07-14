import { spawn as nodeSpawn } from 'node:child_process';
import { headlessOverride } from '../headless.js';
import { loadCanon } from './dispatch.js';

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
  /** Wall-clock ceiling; default 10 minutes (pressure-suite starting value). */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 600_000;

/**
 * Compose the stage prompt: canon (CLAUDE.md + handbook), then the
 * headless-override block (so the root-session stage self-approves), then the
 * coordinator's curated stage prompt. Plain string join, mirroring
 * dispatch.ts's coordinator prompt (canon first, then the headless part).
 *
 * Canon is prepended because a stage runs as its own `claude -p` root session,
 * and `-p` mode does not auto-load CLAUDE.md — same reason dispatch.ts prepends
 * it for the coordinator. We reuse dispatch.ts's `loadCanon` so both call sites
 * stay in lockstep (and the repo-root derivation lives in one place).
 *
 * NOTE: this prepends BOTH canon and `headlessOverride()`. The `stageTask`
 * passed in is already curated (the CLI shim reads it from the prompt-file), so
 * it must NOT include canon OR the override block itself — either would
 * double-inject.
 */
export function buildStagePrompt(
  opts: Pick<StageRunOpts, 'stageTask' | 'worktreePath'>,
): string {
  return [
    loadCanon(),
    '',
    headlessOverride(),
    '',
    opts.stageTask.trim(),
    '',
    `Worktree: ${opts.worktreePath}. Do all work here.`,
  ].join('\n');
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
