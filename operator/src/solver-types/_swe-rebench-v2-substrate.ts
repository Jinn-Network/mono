/**
 * Pure helpers for the swe-rebench-v2 admission record's substrate-identity
 * fields (`rowHash`, `imageDigest`, `upstreamEvalCommit`). v3 of
 * EVAL_SEMANTICS_VERSION (see _swe-rebench-v2-validated-pool.ts).
 *
 * These are extracted from `validatePoolInstances` so they can be unit-tested
 * independently and reused by the verdict-time substrate recheck in the
 * evaluator harness.
 */

import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';

export interface RowHashInput {
  hf_dataset: string;
  hf_split: string;
  instance_id: string;
  repo: string;
  base_commit: string;
  image_name: string;
  patch: string;
  test_patch: string;
  install_config: {
    install: string[] | string;
    test_cmd: string[] | string;
    log_parser: string;
  };
  FAIL_TO_PASS: string[];
  PASS_TO_PASS: string[];
}

/**
 * Canonical-JSON SHA-256 over the HF row fields that affect grading.
 * Keys are sorted recursively so field-reorder produces the same hash.
 * Output is `sha256:<lowercase-hex>` (RFC 8785 JCS-compatible for these
 * primitive types — no float / Date / BigInt in the row).
 */
export function computeRowHash(row: RowHashInput): string {
  const canonical = JSON.stringify(row, sortedKeys);
  const hex = createHash('sha256').update(canonical).digest('hex');
  return `sha256:${hex}`;
}

function sortedKeys(_key: string, value: unknown): unknown {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(obj).sort()) sorted[k] = obj[k];
    return sorted;
  }
  return value;
}

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}
export type CommandRunner = (
  bin: string,
  args: string[],
  opts?: { cwd?: string; timeoutMs?: number },
) => Promise<CommandResult>;

/**
 * Thrown when a shelled-out command exceeded its wall-clock bound and was
 * killed. Deliberately distinct from a non-zero exit: the command produced no
 * observation about its subject at all, only about the operator's
 * environment. A wedged Docker daemon is the motivating case — `docker image
 * inspect` never returns, and before this bound existed it hung the whole run
 * indefinitely (observed: a `run-pilot` stuck >10h behind a wedged daemon).
 */
export class CommandTimeoutError extends Error {
  readonly bin: string;
  readonly args: string[];
  readonly timeoutMs: number;

  constructor(bin: string, args: string[], timeoutMs: number) {
    super(`\`${bin} ${args.join(' ')}\` exceeded its ${timeoutMs}ms timeout and was killed`);
    this.name = 'CommandTimeoutError';
    this.bin = bin;
    this.args = args;
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Default wall-clock bound for the short-lived CLI commands this module shells
 * out to (`docker image inspect`, `docker rmi`, the `docker … prune` family,
 * `git rev-parse`): 5 minutes. Long enough for a `docker builder prune` over a
 * large cache on a healthy daemon, short enough that a wedged one cannot hang
 * a run. Override with `JINN_SWE_REBENCH_COMMAND_TIMEOUT_MS`; set `0` to
 * disable.
 */
export const DEFAULT_COMMAND_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Default wall-clock bound for `docker pull`: 30 minutes. Multi-GB
 * SWE-rebench eval images legitimately take many minutes on a cold cache, so
 * the pull gets its own, far larger bound rather than sharing the one above.
 * Override with `JINN_SWE_REBENCH_DOCKER_PULL_TIMEOUT_MS`; set `0` to disable.
 */
export const DEFAULT_DOCKER_PULL_TIMEOUT_MS = 30 * 60 * 1000;

/** Grace between SIGTERM and SIGKILL when a command overruns its bound. */
const KILL_GRACE_MS = 10_000;

function resolveTimeoutMs(opt: number | undefined, envKey: string, fallbackMs: number): number {
  if (typeof opt === 'number' && Number.isFinite(opt) && opt >= 0) return Math.floor(opt);
  const envRaw = process.env[envKey];
  // An empty value means "unset", never "disabled" — disabling is an explicit `0`.
  if (envRaw !== undefined && envRaw.trim() !== '') {
    const parsed = Number(envRaw);
    if (Number.isFinite(parsed) && parsed >= 0) return Math.floor(parsed);
    console.warn(
      `[swe-rebench-v2] ${envKey}=${JSON.stringify(envRaw)} is not a non-negative number — ` +
        `using default ${fallbackMs} ms`,
    );
  }
  return fallbackMs;
}

/** Resolve the per-command timeout: explicit option > env > default. `0` disables. */
export function resolveCommandTimeoutMs(opt?: number): number {
  return resolveTimeoutMs(opt, 'JINN_SWE_REBENCH_COMMAND_TIMEOUT_MS', DEFAULT_COMMAND_TIMEOUT_MS);
}

/** Resolve the `docker pull` timeout: explicit option > env > default. `0` disables. */
export function resolveDockerPullTimeoutMs(opt?: number): number {
  return resolveTimeoutMs(
    opt,
    'JINN_SWE_REBENCH_DOCKER_PULL_TIMEOUT_MS',
    DEFAULT_DOCKER_PULL_TIMEOUT_MS,
  );
}

export const defaultCommandRunner: CommandRunner = (bin, args, opts) => {
  const { timeoutMs: timeoutOpt, ...spawnOpts } = opts ?? {};
  const timeoutMs = resolveCommandTimeoutMs(timeoutOpt);
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { ...spawnOpts, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const kill = (signal: NodeJS.Signals): void => {
      try { child.kill(signal); } catch { /* already gone */ }
    };
    const timer = timeoutMs > 0
      ? setTimeout(() => {
          if (settled) return;
          settled = true;
          kill('SIGTERM');
          // A `docker` CLI blocked on a wedged daemon ignores SIGTERM, so
          // escalate. Deliberately NOT unref'd: an unref'd escalation is
          // skipped entirely when the parent exits inside the grace, which
          // leaks exactly the wedged process this bound exists to reap. The
          // `close` handler clears it, so the grace is only ever paid by a
          // child that is genuinely refusing to die.
          killTimer = setTimeout(() => kill('SIGKILL'), KILL_GRACE_MS);
          reject(new CommandTimeoutError(bin, args, timeoutMs));
        }, timeoutMs)
      : undefined;
    timer?.unref?.();
    child.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      if (settled) return;
      settled = true;
      reject(err);
    });
    child.on('close', (code: number | null) => {
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (settled) return;
      settled = true;
      resolve({ exitCode: code ?? 1, stdout, stderr });
    });
  });
};

/**
 * Run `runner` under a hard wall-clock bound, rejecting with
 * {@link CommandTimeoutError} on overrun.
 *
 * The bound is enforced here, at the call site, and *not only* inside
 * {@link defaultCommandRunner}: the evaluator harness injects its own runner,
 * which would otherwise stay unbounded. `timeoutMs` is forwarded too, so when
 * the runner is `defaultCommandRunner` it also kills the child — this race is
 * the promise-level backstop, that is the process-level one. `0` disables.
 */
export async function runCommandWithTimeout(
  runner: CommandRunner,
  bin: string,
  args: string[],
  timeoutMs: number,
  opts?: { cwd?: string },
): Promise<CommandResult> {
  const call = runner(bin, args, { ...(opts ?? {}), timeoutMs });
  if (timeoutMs <= 0) return call;
  // Whichever side loses the race below must not surface as an unhandled rejection.
  call.catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      call,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new CommandTimeoutError(bin, args, timeoutMs)), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Resolve the digest of a local Docker image via `docker image inspect`.
 * Returns null when docker fails or the image has no RepoDigests entry
 * (e.g. local-only images that haven't been pulled from a registry).
 */
export async function resolveImageDigest(
  imageName: string,
  runner: CommandRunner,
  timeoutMs?: number,
): Promise<string | null> {
  const res = await runCommandWithTimeout(runner, 'docker', [
    'image', 'inspect', imageName, '--format', '{{json .RepoDigests}}',
  ], resolveCommandTimeoutMs(timeoutMs));
  if (res.exitCode !== 0) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(res.stdout.trim()); } catch { return null; }
  if (!Array.isArray(parsed) || parsed.length === 0) return null;
  const first = parsed[0];
  if (typeof first !== 'string') return null;
  // `RepoDigests` entries are `<name>@sha256:<hex>`; strip the name.
  const at = first.indexOf('@');
  if (at === -1) return null;
  const digest = first.slice(at + 1);
  // Docker `RepoDigests` entries are `<name>@sha256:<hex>`. Refuse to accept
  // a malformed digest (e.g. `<name>@` or a non-sha256 algorithm); the call
  // site relies on the digest being a comparable `sha256:` value.
  return /^sha256:[0-9a-f]{64}$/.test(digest) ? digest : null;
}

/** Pull only a digest-qualified OCI reference before explicit-environment
 * rechecks. Callers already bind the digest in a signed public artifact; this
 * guard prevents the runner from treating arbitrary mutable image names as a
 * pre-grade fetch target. */
export async function pullDigestQualifiedImage(
  imageName: string,
  runner: CommandRunner,
  timeoutMs?: number,
): Promise<boolean> {
  if (!/^.+@sha256:[0-9a-f]{64}$/u.test(imageName)) return false;
  const res = await runCommandWithTimeout(
    runner, 'docker', ['pull', imageName], resolveDockerPullTimeoutMs(timeoutMs),
  );
  return res.exitCode === 0;
}

/**
 * Resolve the OS/architecture of a local Docker image. Unlike the legacy
 * benchmark recheck, explicit-environment v2 rows fail closed when this is not
 * observable: their artifact promises a Linux/amd64 evaluator environment.
 */
export async function resolveImagePlatform(
  imageName: string,
  runner: CommandRunner,
  timeoutMs?: number,
): Promise<'linux/amd64' | null> {
  const res = await runCommandWithTimeout(runner, 'docker', [
    'image', 'inspect', imageName, '--format', '{{.Os}}/{{.Architecture}}',
  ], resolveCommandTimeoutMs(timeoutMs));
  if (res.exitCode !== 0) return null;
  const platform = res.stdout.trim();
  return platform === 'linux/amd64' ? platform : null;
}

/**
 * Resolve the upstream SWE-rebench-V2 repo's HEAD commit via `git rev-parse`.
 * Returns null when git fails (not a repo, missing, etc.).
 */
export async function resolveUpstreamEvalCommit(
  upstreamRepoDir: string,
  runner: CommandRunner,
  timeoutMs?: number,
): Promise<string | null> {
  const res = await runCommandWithTimeout(
    runner, 'git', ['rev-parse', 'HEAD'], resolveCommandTimeoutMs(timeoutMs), { cwd: upstreamRepoDir },
  );
  if (res.exitCode !== 0) return null;
  const sha = res.stdout.trim();
  return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
}
