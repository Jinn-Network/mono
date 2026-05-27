/**
 * Thin Python-subprocess wrapper around `scripts/eval.py` from the upstream
 * SWE-rebench/SWE-rebench-V2 repo (MIT). Operators install the upstream
 * harness as a Python dependency; this runner shells out and parses the
 * structured JSON report.
 *
 * The upstream report item (`report.json` → `items[]`) has two shapes:
 *  - success: `{ instance_id, from_fail_to_pass, failed_from_pass_to_pass,
 *               passed_match, exit_code, log_path, error: "" }`
 *  - setup error: `{ instance_id, from_fail_to_pass: [], failed_from_pass_to_pass:
 *               [...all PASS_TO_PASS...], error: "<message>" }` (no exit_code /
 *               passed_match / log_path)
 *
 * Two corrections this runner makes over the raw report:
 *  1. We re-derive the verdict with SWE-bench "resolved" semantics —
 *     `all FAIL_TO_PASS now pass AND no PASS_TO_PASS broke` — instead of
 *     trusting `passed_match`, which upstream computes as
 *     `{set of every test that passed} == {FAIL_TO_PASS ∪ PASS_TO_PASS}`.
 *     That exact-set comparison makes any instance whose `test_cmd` runs more
 *     (or fewer) than the named tests structurally unscorable, and penalises a
 *     solver for adding an extra passing test. (jinn-mono-uy6v.8)
 *  2. We refuse to return a verdict when the eval never actually graded the
 *     solution (Docker unreachable, image pull/IO failure, model patch failed
 *     to apply, install/test-setup failed, arch-incompatible image, upstream
 *     setup error) — those become `EvalCouldNotGradeError`, which the harness
 *     re-raises as `SkippableError` (no signed verdict).
 */

import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm, statfs } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import type { EvalRunner } from './index.js';
import {
  defaultCommandRunner,
  resolveImageDigest as resolveSubstrateImageDigest,
} from '../../../solver-types/_swe-rebench-v2-substrate.js';

/**
 * Thrown when the eval could not actually grade the solution. There is no
 * signal about the solver here, only about the operator's environment — the
 * caller MUST NOT turn this into a `passed_match: false` verdict.
 */
export class EvalCouldNotGradeError extends Error {
  readonly reason: string;
  /** A short, redacted excerpt of the eval output, for diagnostics. */
  readonly logExcerpt: string;

  constructor(reason: string, logExcerpt = '') {
    super(`swe-rebench-v2 eval could not grade the solution (${reason})`);
    this.name = 'EvalCouldNotGradeError';
    this.reason = reason;
    this.logExcerpt = logExcerpt.slice(0, 1000);
  }
}

/**
 * Thrown by `runEval` when the disk cannot be brought above the eval
 * disk-floor even after a broad prune. A clean abort — the caller stops
 * gracefully; no instance is graded, nothing is marked. Distinct from
 * `EvalCouldNotGradeError`: this is operator-environment, retryable, and must
 * never be turned into a `scorable: false` admission (#476).
 */
export class InsufficientDiskError extends Error {
  readonly freeBytes: number;
  readonly floorBytes: number;
  constructor(freeBytes: number, floorBytes: number) {
    const gb = (n: number): string => (n / 1_000_000_000).toFixed(1);
    super(
      `insufficient disk for swe-rebench eval: ${gb(freeBytes)} GB free, ` +
        `need ≥ ${gb(floorBytes)} GB`,
    );
    this.name = 'InsufficientDiskError';
    this.freeBytes = freeBytes;
    this.floorBytes = floorBytes;
  }
}

/**
 * Default free-disk floor required before an eval round: 20 GB. A single
 * SWE-rebench eval image was observed to peak transiently at ~12.6 GB, so the
 * floor clears the worst observed instance with real margin. Override with
 * `JINN_EVAL_DISK_FLOOR_GB` on constrained hosts.
 */
export const DEFAULT_EVAL_DISK_FLOOR_BYTES = 20_000_000_000;

/** Resolve the disk floor: explicit option > `JINN_EVAL_DISK_FLOOR_GB` env > default. */
export function resolveDiskFloorBytes(opt: number | undefined): number {
  if (typeof opt === 'number' && Number.isFinite(opt) && opt > 0) return Math.floor(opt);
  const envRaw = process.env['JINN_EVAL_DISK_FLOOR_GB'];
  if (envRaw !== undefined) {
    const parsed = Number(envRaw);
    if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed * 1_000_000_000);
    console.warn(
      `[swe-rebench-v2] JINN_EVAL_DISK_FLOOR_GB=${JSON.stringify(envRaw)} is not a positive ` +
        `number — using default ${DEFAULT_EVAL_DISK_FLOOR_BYTES / 1_000_000_000} GB`,
    );
  }
  return DEFAULT_EVAL_DISK_FLOOR_BYTES;
}

/**
 * Default wall-clock limit for one upstream eval.py invocation: 2 hours. Some
 * linux/amd64 SWE-rebench images can wedge indefinitely under Apple Silicon
 * emulation after a native crash, so the subprocess gets a hard guardrail.
 * Override with `JINN_SWE_REBENCH_EVAL_TIMEOUT_MS`; set `0` to disable.
 */
export const DEFAULT_EVAL_TIMEOUT_MS = 2 * 60 * 60 * 1000;

/** Resolve the eval timeout: explicit option > env > default. */
export function resolveEvalTimeoutMs(opt: number | undefined): number {
  if (typeof opt === 'number' && Number.isFinite(opt) && opt >= 0) return Math.floor(opt);
  const envRaw = process.env['JINN_SWE_REBENCH_EVAL_TIMEOUT_MS'];
  if (envRaw !== undefined) {
    const parsed = Number(envRaw);
    if (Number.isFinite(parsed) && parsed >= 0) return Math.floor(parsed);
    console.warn(
      `[swe-rebench-v2] JINN_SWE_REBENCH_EVAL_TIMEOUT_MS=${JSON.stringify(envRaw)} is not a ` +
        `non-negative number — using default ${DEFAULT_EVAL_TIMEOUT_MS} ms`,
    );
  }
  return DEFAULT_EVAL_TIMEOUT_MS;
}

/** Production disk probe: free bytes on the filesystem backing the temp dir. */
async function defaultFreeDiskBytes(): Promise<number> {
  const s = await statfs(tmpdir());
  return s.bavail * s.bsize;
}

export interface PythonEvalRunnerOptions {
  /** Path to the cloned SWE-rebench-V2 repo (cached locally). */
  upstreamRepoDir: string;
  /** Override Python executable. Defaults to `python3`. */
  pythonBin?: string;
  /** Workers for parallel eval (defaults to 1; we run one task at a time). */
  maxWorkers?: number;
  /**
   * Removes a completed round's entire Docker footprint — the round's image,
   * stopped containers, and build cache — so eval disk usage never
   * accumulates across instances (#476). Called once per `runEval`, in a
   * `finally`, even when the eval threw.
   *
   * Defaults to {@link defaultPruneRound}. Implementations MUST NOT throw —
   * `runEval` guards defensively, but cleanup failures should be swallowed
   * (logged elsewhere if desired) so a flaky `docker` never escapes `runEval`.
   */
  pruneRound?: (image: string) => Promise<void>;
  /**
   * Resolves the eval image digest while the image is still local, before
   * per-round pruning removes it. Defaults to `docker image inspect`.
   */
  resolveImageDigest?: (image: string) => Promise<string | null>;
  /**
   * Required free disk (bytes) before an eval round starts. Explicit value >
   * `JINN_EVAL_DISK_FLOOR_GB` env > {@link DEFAULT_EVAL_DISK_FLOOR_BYTES}.
   */
  diskFloorBytes?: number;
  /** Probe of free disk (bytes). Defaults to a `statfs` on the temp dir. */
  freeDiskBytes?: () => Promise<number>;
  /**
   * Broad reclaim invoked when free disk is below the floor. Defaults to
   * `docker system prune -f`. MUST NOT throw.
   */
  systemPrune?: () => Promise<void>;
  /**
   * Wall-clock timeout (ms) for one upstream eval.py invocation. Explicit value
   * > `JINN_SWE_REBENCH_EVAL_TIMEOUT_MS` env > {@link DEFAULT_EVAL_TIMEOUT_MS}.
   * Set to 0 to disable.
   */
  evalTimeoutMs?: number;
}

/**
 * Spawn `docker <args>`, resolving regardless of outcome — a failed cleanup
 * command is logged, never thrown (#476: cleanup must not break the eval loop).
 */
function runDocker(args: string[]): Promise<void> {
  return defaultCommandRunner('docker', args)
    .then((res) => {
      if (res.exitCode !== 0) {
        const detail = (res.stderr || res.stdout).trim();
        console.warn(
          `[swe-rebench-v2] docker ${args.join(' ')} exited ${res.exitCode}` +
            `${detail ? `: ${detail.slice(-500)}` : ''}`,
        );
      }
    })
    .catch((err: unknown) => {
      const reason = err instanceof Error ? err.message : String(err);
      console.warn(`[swe-rebench-v2] docker ${args.join(' ')} failed to spawn: ${reason}`);
    });
}

/**
 * Production `pruneRound`: remove the round's image, then prune stopped
 * containers and build cache. Each step is best-effort.
 */
async function defaultPruneRound(image: string): Promise<void> {
  if (image) await runDocker(['rmi', '-f', image]);
  await runDocker(['container', 'prune', '-f']);
  await runDocker(['builder', 'prune', '-f']);
}

async function defaultResolveImageDigest(imageName: string): Promise<string | null> {
  return resolveSubstrateImageDigest(imageName, defaultCommandRunner);
}

/**
 * Container-output signatures that mean the eval aborted before producing a
 * usable result — i.e. the operator's environment is the problem, not the
 * solver. Used both to classify (`reason`) and as the load-bearing gate:
 * a "zero tests passed, non-zero exit" report is only treated as ungradeable
 * when one of these is present; otherwise it's a (degenerate) real failure.
 */
const INFRA_SIGNATURES: Array<{ rx: RegExp; reason: string }> = [
  { rx: /Cannot connect to the Docker daemon/i, reason: 'docker_unavailable' },
  { rx: /input\/output error/i, reason: 'docker_storage_io_error' },
  { rx: /No such image|manifest unknown|pull access denied/i, reason: 'image_pull_failed' },
  { rx: /error: corrupt patch at line|patch fragment without header/i, reason: 'patch_corrupt' },
  { rx: /patch does not apply|error: patch failed:/i, reason: 'patch_does_not_apply' },
  { rx: /Applied patch to .+ with conflicts|^U \S/m, reason: 'patch_merge_conflict' },
  { rx: /: command not found/i, reason: 'test_command_not_found' },
  { rx: /Failed building editable|Failed to build installable wheels/i, reason: 'install_build_failed' },
  { rx: /No virtual environment found/i, reason: 'venv_missing' },
  { rx: /exec format error|the requested image's platform .* does not match/i, reason: 'image_arch_mismatch' },
  { rx: /Fatal Python error:\s*Illegal instruction|Illegal instruction(?:\s+\(core dumped\))?/i, reason: 'image_arch_mismatch' },
  // 2026-05-14 triage (jinn-mono-fufn) — failure fingerprints from real verdicts:
  { rx: /A virtual environment already exists at \S+\.venv\b/i, reason: 'venv_collision' },
  { rx: /No module named pytest\b/i, reason: 'pytest_missing' },
  { rx: /RequestsDependencyWarning/i, reason: 'requests_dep_mismatch' },
  { rx: /ImportError while loading conftest/i, reason: 'conftest_import_error' },
];

export function matchInfraSignature(log: string): string | null {
  for (const { rx, reason } of INFRA_SIGNATURES) {
    if (rx.test(log)) return reason;
  }
  return null;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

/** The pinned `test_log` size cap (the tail is what matters — pytest's
 *  summary + last failures live there). */
const MAX_LOG_SIZE = 1024 * 1024;
function capLogTail(log: string): string {
  if (log.length <= MAX_LOG_SIZE) return log;
  return `[… ${log.length - MAX_LOG_SIZE} bytes truncated …]\n${log.slice(-MAX_LOG_SIZE)}`;
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * The `install_config.test_cmd` array handed to `eval.py` (run line-by-line
 * under `set -e` after the patch + gold test_patch are applied).
 *
 * For pytest instances we *override* the dataset's `test_cmd` with one that
 * runs exactly the FAIL_TO_PASS ∪ PASS_TO_PASS node ids in the `-rA` summary
 * format `parse_log_pytest` understands. Many dataset rows scope `test_cmd`
 * to a whole file or the whole repo, or use `-v` — both make instances
 * structurally unscorable (extra passing tests, or a parser-format mismatch)
 * even when the fix is correct. Running exactly the named tests is the
 * standard SWE-bench evaluation shape.
 *
 * For non-pytest log parsers (go / cargo / …) node-id semantics differ, so we
 * fall back to the dataset's `test_cmd` verbatim and accept the limitation.
 */
function buildTestCommands(args: Parameters<EvalRunner['runEval']>[0]): string[] {
  const install = normalizeCommands(args.install);
  if (args.log_parser === 'parse_log_pytest') {
    const nodeIds = [...args.fail_to_pass, ...args.pass_to_pass];
    if (nodeIds.length > 0) {
      // Why: many SWE-rebench rows ship a base image lacking pytest, which
      // aborts the eval as `ungradeable:pytest_missing` (#493). Prepend a
      // best-effort install unless the dataset's install already does it.
      const guarded = installsPytest(install)
        ? install
        : [PYTEST_INSTALL_GUARD, ...install];
      const cmd = [
        'python -m pytest --no-header -rA --tb=no -p no:cacheprovider',
        ...nodeIds.map(shellQuote),
      ].join(' ');
      return [...guarded, cmd];
    }
  }
  return [...install, ...normalizeCommands(args.test_cmd)];
}

// Why: hyphen is excluded from the boundary class so `pytest-cov` alone
// does not satisfy the check (only an explicit `pytest` install counts).
function installsPytest(install: string[]): boolean {
  return install.some((line) => /(?:^|[^A-Za-z0-9_-])pytest(?:$|[^A-Za-z0-9_-])/.test(line));
}

const PYTEST_INSTALL_GUARD =
  'python3 -m ensurepip --upgrade >/dev/null 2>&1 || true && ' +
  'python3 -m pip install --disable-pip-version-check --quiet pytest';

export class PythonEvalRunner implements EvalRunner {
  private readonly pruneRound: (image: string) => Promise<void>;
  private readonly diskFloorBytes: number;
  private readonly freeDiskBytes: () => Promise<number>;
  private readonly systemPrune: () => Promise<void>;
  private readonly resolveImageDigest: (image: string) => Promise<string | null>;
  private readonly evalTimeoutMs: number;

  constructor(private readonly opts: PythonEvalRunnerOptions) {
    this.pruneRound = opts.pruneRound ?? defaultPruneRound;
    this.diskFloorBytes = resolveDiskFloorBytes(opts.diskFloorBytes);
    this.freeDiskBytes = opts.freeDiskBytes ?? defaultFreeDiskBytes;
    this.systemPrune = opts.systemPrune ?? (() => runDocker(['system', 'prune', '-f']));
    this.resolveImageDigest = opts.resolveImageDigest ?? defaultResolveImageDigest;
    this.evalTimeoutMs = resolveEvalTimeoutMs(opts.evalTimeoutMs);
  }

  /**
   * Ensure enough free disk for an eval round. Below the floor → broad prune →
   * re-probe; still below → `InsufficientDiskError` (clean abort). (#476)
   */
  private async ensureDiskHeadroom(): Promise<void> {
    const free = await this.freeDiskBytes();
    if (free >= this.diskFloorBytes) return;
    console.warn(
      `[swe-rebench-v2] low disk (${(free / 1e9).toFixed(1)} GB) — running docker system prune`,
    );
    await this.systemPrune();
    const afterPrune = await this.freeDiskBytes();
    if (afterPrune < this.diskFloorBytes) {
      throw new InsufficientDiskError(afterPrune, this.diskFloorBytes);
    }
  }

  async runEval(args: Parameters<EvalRunner['runEval']>[0]): ReturnType<EvalRunner['runEval']> {
    await this.ensureDiskHeadroom();
    try {
      const result = await this.runEvalImpl(args);
      let imageDigest: string | null = null;
      try {
        imageDigest = await this.resolveImageDigest(args.image);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        console.warn(`[swe-rebench-v2] resolveImageDigest failed for ${args.image}: ${reason}`);
      }
      return {
        ...result,
        ...(imageDigest ? { imageDigest } : {}),
      };
    } finally {
      // Prune this round's full Docker footprint — even when the eval threw,
      // a pull-and-crash still left an image on disk (#476).
      try {
        await this.pruneRound(args.image);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        console.warn(`[swe-rebench-v2] pruneRound failed for ${args.image}: ${reason}`);
      }
    }
  }

  private async runEvalImpl(args: Parameters<EvalRunner['runEval']>[0]): ReturnType<EvalRunner['runEval']> {
    const tmp = await mkdtemp(join(tmpdir(), 'swerebench-eval-'));
    // Single-task runner: eval.py matches the patch override by instance_id.
    const INSTANCE_ID = args.instance_id;
    const taskJson = [{
      instance_id: INSTANCE_ID,
      // SWE-rebench Docker images place the checked-out repository at
      // /testbed. The upstream eval.py derives its docker workdir from the
      // repo slug, so use a synthetic slug that resolves to /testbed while
      // preserving the real repo separately in the Jinn task/HF row.
      repo: 'jinn/testbed',
      image_name: args.image,
      FAIL_TO_PASS: args.fail_to_pass,
      PASS_TO_PASS: args.pass_to_pass,
      test_patch: args.test_patch,
      install_config: {
        test_cmd: buildTestCommands(args),
        log_parser: args.log_parser,
      },
    }];
    // Upstream eval.py expects --patches to be a JSON list of
    // `{instance_id, patch, test_patch?}` overrides keyed by instance_id.
    // jinn-mono-c52e: defensive newline-terminate before `git apply` —
    // mid-line diffs error as "corrupt patch at line N".
    const normalizedPatch = args.patch.endsWith('\n') ? args.patch : `${args.patch}\n`;
    const patchesJson = [{ instance_id: INSTANCE_ID, patch: normalizedPatch }];
    const taskJsonPath = join(tmp, 'task.json');
    const patchesJsonPath = join(tmp, 'patches.json');
    const reportPath = join(tmp, 'report.json');
    await writeFile(taskJsonPath, JSON.stringify(taskJson));
    await writeFile(patchesJsonPath, JSON.stringify(patchesJson));

    const pyArgs = [
      '-m', 'scripts.eval',
      '--json', taskJsonPath,
      '--patches', patchesJsonPath,
      '--max-workers', String(this.opts.maxWorkers ?? 1),
      '--report-json', reportPath,
    ];
    const child = spawn(this.opts.pythonBin ?? 'python3', pyArgs, {
      cwd: this.opts.upstreamRepoDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      // SWE-rebench eval images are published for linux/amd64. Pin the platform
      // so the upstream `docker run` is consistent on amd64 hosts and does not
      // silently crash under arm64 emulation on dev machines.
      env: { ...process.env, DOCKER_DEFAULT_PLATFORM: 'linux/amd64' },
    });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    let stdout = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    let timedOut = false;
    let closed = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const killChild = (signal: NodeJS.Signals): void => {
      const pid = child.pid;
      if (!pid) return;
      try {
        if (process.platform === 'win32') {
          child.kill(signal);
        } else {
          process.kill(-pid, signal);
        }
      } catch {
        try { child.kill(signal); } catch {}
      }
    };
    const timeoutTimer = this.evalTimeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          killChild('SIGTERM');
          killTimer = setTimeout(() => {
            if (!closed) killChild('SIGKILL');
          }, 10_000);
          killTimer.unref?.();
        }, this.evalTimeoutMs)
      : undefined;
    timeoutTimer?.unref?.();

    const exitCode = await new Promise<number>((resolve, reject) => {
      child.on('close', (code) => resolve(code ?? 1));
      child.on('error', reject);
    }).finally(() => {
      closed = true;
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
    });

    if (timedOut) {
      await rm(tmp, { recursive: true, force: true });
      throw new EvalCouldNotGradeError(
        'eval_timeout',
        `python eval timed out after ${this.evalTimeoutMs}ms; ${(stderr || stdout).slice(-800)}`,
      );
    }

    let report: { items?: Array<Record<string, unknown>> };
    try {
      report = JSON.parse(await readFile(reportPath, 'utf8')) as typeof report;
    } catch {
      await rm(tmp, { recursive: true, force: true });
      // The upstream harness never produced a report — it crashed before it
      // could grade anything.
      throw new EvalCouldNotGradeError(
        matchInfraSignature(stderr + stdout) ?? 'eval_no_report',
        `python exitCode=${exitCode}; ${(stderr || stdout).slice(-800)}`,
      );
    }

    const items = Array.isArray(report.items) ? report.items : [];
    const item = items.find((i) => i['instance_id'] === INSTANCE_ID) ?? items[0] ?? {};

    // Setup-error shape: eval.py caught an exception (missing image_name,
    // missing config, unknown log parser, …). No exit_code / passed_match.
    const reportError = typeof item['error'] === 'string' ? (item['error'] as string).trim() : '';
    if (reportError) {
      await rm(tmp, { recursive: true, force: true });
      throw new EvalCouldNotGradeError('eval_setup_error', reportError);
    }
    if (typeof item['exit_code'] !== 'number') {
      await rm(tmp, { recursive: true, force: true });
      throw new EvalCouldNotGradeError(
        'eval_report_malformed',
        `report item lacked exit_code: ${JSON.stringify(item).slice(0, 500)}`,
      );
    }

    const containerExit = item['exit_code'] as number;
    // `from_fail_to_pass`: FAIL_TO_PASS tests that now pass.
    // `failed_from_pass_to_pass`: PASS_TO_PASS tests that no longer pass.
    const fromFailToPass = asStringArray(item['from_fail_to_pass']);
    const failedFromPassToPass = asStringArray(item['failed_from_pass_to_pass']);

    // The upstream eval.py writes the full container log to
    // <upstreamRepoDir>/logs/<instance>_log.txt and records `log_path` —
    // sometimes relative to its own cwd. Resolve it so the test-log artifact
    // carries the real pytest/container output rather than just the progress bar.
    let logBody = '';
    const logPath = item['log_path'];
    if (typeof logPath === 'string' && logPath.length > 0) {
      const resolved = isAbsolute(logPath) ? logPath : join(this.opts.upstreamRepoDir, logPath);
      try {
        logBody = await readFile(resolved, 'utf8');
      } catch {
        logBody = '';
      }
    }
    // Cap the log we hand back. The harness pins this verbatim to IPFS as the
    // verdict's `test_log_cid` — a long pytest run can produce 10s of MB, and
    // we only need the tail (pytest summary + last failures) to be useful.
    const fullLog = capLogTail(stdout + logBody);

    await rm(tmp, { recursive: true, force: true });

    // Ungradeable iff: the container aborted (non-zero exit) AND no expected
    // test of either kind was observed to pass (`from_fail_to_pass` empty and
    // *every* PASS_TO_PASS landed in `failed_from_pass_to_pass`) AND the output
    // matches a known infra-abort signature. A genuine wrong-answer run still
    // shows the FAIL_TO_PASS test failing inside a normal pytest report (no
    // infra signature), and a partially-passing run is clearly a real result —
    // both go through as verdicts.
    const noTestPassed =
      fromFailToPass.length === 0 && failedFromPassToPass.length >= args.pass_to_pass.length;
    if (containerExit !== 0 && noTestPassed) {
      const infraReason = matchInfraSignature(fullLog || stderr);
      if (infraReason) {
        throw new EvalCouldNotGradeError(infraReason, (fullLog || stderr).slice(-800));
      }
    }

    // SWE-bench "resolved" semantics: all FAIL_TO_PASS now pass and no
    // PASS_TO_PASS broke. (`from_fail_to_pass` is an intersection with the
    // expected FAIL_TO_PASS set, so length equality means full coverage.)
    const resolved =
      fromFailToPass.length === args.fail_to_pass.length && failedFromPassToPass.length === 0;

    return {
      passed_match: resolved,
      passed: fromFailToPass,
      failed: failedFromPassToPass,
      log: fullLog,
      exitCode: containerExit,
    };
  }
}

function normalizeCommands(value: string | string[] | undefined): string[] {
  if (typeof value === 'string') {
    return value.trim() ? [value] : [];
  }
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
}
