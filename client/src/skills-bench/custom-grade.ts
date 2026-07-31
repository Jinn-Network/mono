/**
 * Custom pytest-verifier grading for authored skill task sets
 * (`SkillTaskSetV1`, task-set.ts). Distinct from the swe-rebench-v2 grade
 * path (eval-runner.ts): there is no upstream `eval.py` and no
 * FAIL_TO_PASS/PASS_TO_PASS log-parsing — the task author supplies the
 * verifier files directly, and grading is "run pytest on exactly those
 * files inside the task's container, and read its exit code".
 *
 * All docker/git-in-container calls go through an injectable `CmdRunner`
 * (client/src/pilot/repo.ts's type) so unit tests never touch a real daemon
 * — see custom-grade.test.ts.
 *
 * Reused from eval-runner.ts: disk-floor resolution (`resolveDiskFloorBytes`,
 * `InsufficientDiskError`) and the infra-signature matcher
 * (`matchInfraSignature`) — a Docker-storage or credential-helper failure
 * looks identical whether the grader is upstream eval.py or ours. Everything
 * log-parser/FAIL_TO_PASS-shaped in eval-runner.ts is swe-rebench-specific
 * and deliberately NOT reused (plan §Work item 2 of the v0.2 pivot).
 */
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm, statfs } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { CmdRunner } from '../pilot/repo.js';
import type { SkillTaskV1 } from './task-set.js';
import {
  resolveDiskFloorBytes,
  InsufficientDiskError,
  matchInfraSignature,
} from '../harnesses/impls/swe-rebench-v2-evaluator/eval-runner.js';

/** Thrown when the grade path could not actually reach a pass/fail verdict —
 *  container start, checkout, patch-apply, or verifier-collection failure,
 *  or a wall-clock timeout. The caller MUST NOT turn this into
 *  `passed: false` — mirrors `EvalCouldNotGradeError`'s distinction. */
export class CustomGradeError extends Error {
  readonly reason: string;
  readonly logExcerpt: string;
  constructor(reason: string, logExcerpt = '') {
    super(`custom grade could not grade the solution (${reason})`);
    this.name = 'CustomGradeError';
    this.reason = reason;
    this.logExcerpt = logExcerpt.slice(0, 1000);
  }
}

export interface CustomGradeArgs {
  task: SkillTaskV1;
  /** Directory the task set was loaded from — `verifierFiles` are read
   *  relative to this directory. */
  taskSetDir: string;
  /** The patch to apply, or `''` for the empty-patch (must-fail) direction. */
  patch: string;
}

export interface CustomGradeOptions {
  /** Docker/git-in-container command runner. Defaults to a real `spawn`. */
  run?: CmdRunner;
  diskFloorBytes?: number;
  freeDiskBytes?: () => Promise<number>;
  systemPrune?: () => Promise<void>;
  /** Wall-clock cap for the whole grade (container start through pytest).
   *  `task.timeoutMs` wins when set; falls back to this option, then the
   *  default. */
  timeoutMs?: number;
  /** Wall-clock cap for the final `docker rm -f` teardown, independent of
   *  `timeoutMs` — a wedged Docker daemon must not hang the caller forever
   *  waiting on cleanup after a grade has already succeeded, failed, or
   *  timed out. Best-effort: on expiry this logs and returns, it never
   *  throws. Defaults to {@link DEFAULT_CLEANUP_TIMEOUT_MS}. */
  cleanupTimeoutMs?: number;
}

export interface CustomGradeResult {
  passed: boolean;
  log: string;
  exitCode: number;
}

/** Default wall-clock cap for one custom grade: 10 minutes. Authored tasks
 *  are small pinned repos with a handful of pytest verifiers — nowhere near
 *  swe-rebench-v2's multi-hour worst case. Override per-task via
 *  `task.timeoutMs`. */
export const DEFAULT_CUSTOM_GRADE_TIMEOUT_MS = 10 * 60 * 1000;

/** Default wall-clock cap for the `docker rm -f` teardown: 30 seconds. */
export const DEFAULT_CLEANUP_TIMEOUT_MS = 30_000;

const CONTAINER_WORKDIR = '/workspace';

/** Production `CmdRunner`: spawn and collect stdout/stderr/exitCode. Mirrors
 *  the same shape used elsewhere (pilot/repo.ts callers, `defaultCommandRunner`
 *  in _swe-rebench-v2-substrate.ts). */
export const defaultCmdRunner: CmdRunner = (cmd, args, opts) => new Promise((resolvePromise, reject) => {
  const child = spawn(cmd, args, { cwd: opts?.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { stdout += d.toString(); });
  child.stderr.on('data', (d) => { stderr += d.toString(); });
  child.on('error', reject);
  child.on('close', (code) => resolvePromise({ stdout, stderr, exitCode: code ?? 1 }));
});

async function defaultFreeDiskBytes(): Promise<number> {
  const s = await statfs(tmpdir());
  return s.bavail * s.bsize;
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Container paths are always POSIX regardless of host OS. */
function posixJoin(...parts: string[]): string {
  return parts.join('/').replace(/\/{2,}/g, '/');
}

function execIn(
  run: CmdRunner,
  container: string,
  shellCmd: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return run('docker', ['exec', container, 'bash', '-lc', shellCmd]);
}

async function ensureDiskHeadroom(run: CmdRunner, opts: CustomGradeOptions): Promise<void> {
  const floor = resolveDiskFloorBytes(opts.diskFloorBytes);
  const freeDiskBytes = opts.freeDiskBytes ?? defaultFreeDiskBytes;
  const free = await freeDiskBytes();
  if (free >= floor) return;
  console.warn(`[custom-grade] low disk (${(free / 1e9).toFixed(1)} GB) — running docker system prune`);
  const systemPrune = opts.systemPrune ?? (async () => { await run('docker', ['system', 'prune', '-f']); });
  await systemPrune();
  const after = await freeDiskBytes();
  if (after < floor) throw new InsufficientDiskError(after, floor);
}

/**
 * Reconcile the container's `/workspace` to `task.repo`@`task.commit`. If
 * `/workspace/.git` already exists (the image bakes a checkout, the
 * swe-rebench-style convention), a `git fetch` + `git checkout` reaches the
 * exact pinned commit — a no-op when it's already there. If there is no git
 * dir at all, clone fresh. Either way the code path is identical: "checkout
 * inside" and "use the image's baked checkout" (deliverable 2's two
 * described modes) collapse into one idempotent reconciliation.
 */
async function reconcileCheckout(run: CmdRunner, container: string, task: SkillTaskV1): Promise<void> {
  const hasGit = await execIn(run, container, `test -d ${CONTAINER_WORKDIR}/.git`);
  if (hasGit.exitCode !== 0) {
    const clone = await execIn(run, container, `git clone https://github.com/${task.repo}.git ${CONTAINER_WORKDIR}`);
    if (clone.exitCode !== 0) {
      throw new CustomGradeError('checkout_failed', clone.stderr || clone.stdout);
    }
  }
  const head = await execIn(run, container, `git -C ${CONTAINER_WORKDIR} rev-parse HEAD`);
  const current = head.stdout.trim();
  if (head.exitCode === 0 && current && task.commit && current.startsWith(task.commit)) return;
  await execIn(run, container, `git -C ${CONTAINER_WORKDIR} fetch origin ${task.commit}`);
  const checkout = await execIn(run, container, `git -C ${CONTAINER_WORKDIR} checkout ${task.commit}`);
  if (checkout.exitCode !== 0) {
    throw new CustomGradeError('checkout_failed', checkout.stderr || checkout.stdout);
  }
}

async function applyPatch(run: CmdRunner, container: string, patch: string): Promise<void> {
  if (!patch.trim()) return; // empty patch — grade the base checkout as-is
  const tmpDir = await mkdtemp(join(tmpdir(), 'jinn-cg-patch-'));
  try {
    const localPath = join(tmpDir, 'patch.diff');
    await writeFile(localPath, patch.endsWith('\n') ? patch : `${patch}\n`);
    const copy = await run('docker', ['cp', localPath, `${container}:/tmp/jinn-patch.diff`]);
    if (copy.exitCode !== 0) throw new CustomGradeError('patch_copy_failed', copy.stderr || copy.stdout);
    const apply = await execIn(
      run, container, `cd ${CONTAINER_WORKDIR} && git apply --whitespace=nowarn /tmp/jinn-patch.diff`,
    );
    if (apply.exitCode !== 0) throw new CustomGradeError('patch_apply_failed', apply.stderr || apply.stdout);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

async function copyVerifierFiles(
  run: CmdRunner, container: string, taskSetDir: string, verifierFiles: string[],
): Promise<void> {
  for (const vf of verifierFiles) {
    const localPath = join(taskSetDir, vf);
    const containerPath = posixJoin(CONTAINER_WORKDIR, vf);
    const mk = await execIn(run, container, `mkdir -p "$(dirname ${shellQuote(containerPath)})"`);
    if (mk.exitCode !== 0) throw new CustomGradeError('verifier_copy_failed', mk.stderr || mk.stdout);
    const copy = await run('docker', ['cp', localPath, `${container}:${containerPath}`]);
    if (copy.exitCode !== 0) throw new CustomGradeError('verifier_copy_failed', copy.stderr || copy.stdout);
  }
}

/** pytest exit codes: 0 = all collected tests passed, 1 = some failed (a
 *  genuine, gradeable result), 2 = interrupted, 3 = internal error, 4 = usage
 *  error, 5 = no tests collected. 2-5 mean the run never reached a real
 *  pass/fail verdict — never coerce those into `passed: false`. */
async function runPytest(run: CmdRunner, container: string, verifierFiles: string[]): Promise<CustomGradeResult> {
  const cmd = ['python -m pytest --no-header -rA --tb=short -p no:cacheprovider', ...verifierFiles.map(shellQuote)]
    .join(' ');
  const result = await execIn(run, container, `cd ${CONTAINER_WORKDIR} && ${cmd}`);
  const log = `${result.stdout}${result.stderr}`;
  if (result.exitCode === 0) return { passed: true, log, exitCode: 0 };
  if (result.exitCode === 1) return { passed: false, log, exitCode: 1 };
  const infra = matchInfraSignature(log);
  throw new CustomGradeError(infra ?? `pytest_exit_${result.exitCode}`, log);
}

async function gradeInContainer(run: CmdRunner, container: string, args: CustomGradeArgs): Promise<CustomGradeResult> {
  const start = await run('docker', ['run', '-d', '--name', container, args.task.image, 'tail', '-f', '/dev/null']);
  if (start.exitCode !== 0) throw new CustomGradeError('container_start_failed', start.stderr || start.stdout);

  await reconcileCheckout(run, container, args.task);
  await applyPatch(run, container, args.patch);
  await copyVerifierFiles(run, container, args.taskSetDir, args.task.verifierFiles);
  return runPytest(run, container, args.task.verifierFiles);
}

/** Best-effort container teardown — never throws (mirrors `defaultPruneRound`
 *  in eval-runner.ts: cleanup failures are logged, not propagated) — AND
 *  never blocks longer than `cleanupTimeoutMs`. Without its own bound, a
 *  wedged Docker daemon would hang cleanup (and therefore the whole caller)
 *  indefinitely even after a grade already succeeded, failed, or itself
 *  timed out via `withDeadline`. */
async function cleanupContainer(run: CmdRunner, container: string, cleanupTimeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout>;
  const timedOut = new Promise<'timed-out'>((resolve) => {
    timer = setTimeout(() => resolve('timed-out'), cleanupTimeoutMs);
  });
  timer!.unref?.();
  try {
    const outcome = await Promise.race([
      run('docker', ['rm', '-f', container]).catch((err: unknown) => ({ error: err }) as const),
      timedOut,
    ]);
    if (outcome === 'timed-out') {
      console.warn(`[custom-grade] docker rm -f ${container} did not respond within ${cleanupTimeoutMs}ms — may need manual cleanup`);
      return;
    }
    if ('error' in outcome) {
      console.warn(`[custom-grade] docker rm -f ${container} failed to spawn: ${(outcome.error as Error).message}`);
      return;
    }
    if (outcome.exitCode !== 0) {
      console.warn(`[custom-grade] docker rm -f ${container} exited ${outcome.exitCode}: ${(outcome.stderr || outcome.stdout).slice(-300)}`);
    }
  } finally {
    clearTimeout(timer!);
  }
}

async function withDeadline<T>(work: () => Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new CustomGradeError('grade_timeout', `custom grade exceeded ${ms}ms`)), ms);
  });
  timer!.unref?.();
  try {
    return await Promise.race([work(), timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

/**
 * Grade one patch (or `''` for the empty-patch direction) against one
 * authored task: start a container from `task.image`, reconcile it to
 * `task.repo`@`task.commit`, apply the patch, overlay the verifier files,
 * run pytest on exactly those files, and return a deterministic verdict.
 * Throws {@link CustomGradeError} — never a verdict — when the eval itself
 * could not run to completion.
 */
export async function runCustomGrade(args: CustomGradeArgs, opts: CustomGradeOptions = {}): Promise<CustomGradeResult> {
  const run = opts.run ?? defaultCmdRunner;
  await ensureDiskHeadroom(run, opts);
  const container = `jinn-cg-${randomBytes(6).toString('hex')}`;
  const timeoutMs = args.task.timeoutMs ?? opts.timeoutMs ?? DEFAULT_CUSTOM_GRADE_TIMEOUT_MS;
  const cleanupTimeoutMs = opts.cleanupTimeoutMs ?? DEFAULT_CLEANUP_TIMEOUT_MS;
  try {
    return await withDeadline(() => gradeInContainer(run, container, args), timeoutMs);
  } finally {
    await cleanupContainer(run, container, cleanupTimeoutMs);
  }
}
