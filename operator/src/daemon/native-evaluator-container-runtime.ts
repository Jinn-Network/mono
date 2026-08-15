/**
 * Docker `ContainerRuntime` driver for the native evaluator's container-graded methods (one-swap
 * C / #2467, umbrella #2461).
 *
 * `@jinn-network/task-execution-evaluator-adapters`'s `containerGraderReportSource` composes a run
 * request and reads what the container leaves on disk; it deliberately never shells out. The
 * concrete runtime is host work, injected as the `ContainerRuntime` port — this module is that
 * host driver for Docker.
 *
 * WHAT THIS DRIVER OWNS (the P0-4 review's finding): "nothing in the package bounds an untrusted
 * container — the driver does." An untrusted grader image can ignore SIGTERM and run indefinitely,
 * fork-bomb, or balloon memory; the package cannot stop it. This driver enforces BOTH bounds:
 *   1. the settle bound — on `timeoutSignal` it SIGTERMs the CLI, reaps the container out of band
 *      (`docker kill <name>`), escalates to SIGKILL after a grace, and rejects within a hard bound
 *      EVEN IF the child never closes, then `docker rm -f <name>` to close the orphan race; and
 *   2. the resource + isolation bound — see CONTAINER ISOLATION below.
 *
 * TRUST BOUNDARY (recorded per the M4 ruling on #2461, matching M2's deploymentModule/moduleDigest
 * discipline). This driver is DAEMON code, not deployment-module code. It is pinned by whatever
 * pins the installed daemon (release/canary build integrity), NOT by the evaluator deployment's
 * `moduleDigest`. `moduleDigest` exists to pin a deployment module's DECLARED IDENTITY — its
 * registration set and evaluation-method identity, the things a wrong or malicious deployment
 * module would lie about (P0-5-A). Execution substrate is a different thing: an attacker who can
 * swap this driver can already swap the installed daemon, which is a strictly LARGER capability
 * than swapping a deployment module — so the driver being trusted daemon code adds no attack
 * surface, it sits correctly inside the "you already own the daemon" boundary. A digest-pinned
 * `.mjs` deployment module that wires container grading imports this driver by a specifier the
 * daemon dist resolves; both are covered by the one daemon-integrity mechanism. Do not try to pin
 * the driver through `moduleDigest` — that would require inlining the security-critical driver into
 * the `.mjs` bytes, defeating the point and making it un-reviewable in place.
 *
 * STDERR (P0-4 N6): `ContainerRunResult` carries only `{ exitCode, stdout }`, and that stdout is the
 * grader's LOG channel (`RawGraderReport.log`), not its report — the report is a file the package
 * reads off disk, untouched here. So stderr, captured under a small bound, is surfaced two ways
 * without ever touching the report: it is appended (clearly delimited) to the returned stdout ONLY
 * on a nonzero container exit — so a grader that crashes to stderr and writes no report keeps its
 * diagnostic in claim evidence instead of losing it — and it is in the message of a spawn/`error`
 * rejection. On a clean (zero) exit stdout stays exactly what the container printed.
 *
 * STDOUT/OOM (P0-4 N7): captured stdout is bounded to `maxStdoutBytes`; a container that floods
 * stdout cannot OOM the daemon — bytes past the cap are dropped. (The grader REPORT file read is
 * `readReport` inside the package's `containerGraderReportSource`, an unbounded `readFile`; bounding
 * that is a package concern, filed as #2477 against the evaluator-adapters package, out of reach here.)
 *
 * CONTAINER ISOLATION + RESOURCE BOUNDS (the driver's charter — "nothing in the package bounds an
 * untrusted container, the driver does"): a grader image is untrusted code, so the run is capped and
 * confined on the HOST the same way the in-repo precedents do it
 * (`operator/src/harnesses/impls/jinn-repo-evaluator/docker-immutable-verifier.ts` and
 * `packages/autopilot/src/lifecycle/marketplace-mutation-adoption-production.ts`): `--memory`,
 * `--cpus`, `--pids-limit` (default 8g / 4 / 512, matching the verifier) bound host resources so a
 * fork-bomb or memory balloon cannot take the daemon host down without any escape vuln; `--network`
 * defaults to `none` (a deterministic grader has no business phoning home — egress would be
 * subject-material exfil / SSRF); `--cap-drop ALL` + `--security-opt no-new-privileges:true` +
 * `--read-only` rootfs + a `noexec,nosuid` `/tmp` tmpfs confine it. Graders must confine their
 * writes to the writable bind-mounted workdir (where they leave `grader-output.json`) and `/tmp`.
 * Every one of these is configurable through the options object with a safe default; `--user` is
 * off by default (many grader images legitimately need root — e.g. swe-rebench eval images that
 * install deps and run test harnesses) and pinned non-root only when an operator's image supports it.
 *
 * DEADLINE SIGNAL ORIGIN (P0-4 N2): this driver does NOT originate a deadline — it faithfully
 * honors whatever `timeoutSignal` it is handed. Today that signal is composed inside
 * `containerGraderReportSource` as `AbortSignal.any([request.deadlineSignal, AbortSignal.timeout(
 * block.timeout * 1000)])`. The harness still passes a never-aborting `deadlineSignal`
 * (`packages/task-execution/evaluation-harness/src/runtime.ts` ~L770), so the ONLY currently
 * effective abort is the specification's own `block.timeout`. Wiring a real evaluation deadline is
 * the harness/evaluator-loop's job (M4 A), not this driver's; this driver already terminates
 * promptly for whichever signal fires first.
 */
import { spawn as nodeSpawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type {
  ContainerRunRequest,
  ContainerRunResult,
  ContainerRuntime,
} from '@jinn-network/task-execution-evaluator-adapters';

/** Raised when a run was terminated by its `timeoutSignal` rather than exiting on its own. */
export class ContainerTerminatedError extends Error {
  override readonly name = 'ContainerTerminatedError';
  constructor(detail: string) {
    super(`grader container terminated: ${detail}`);
  }
}

/** Delimiter that separates the container's stdout from an appended stderr tail (N6). */
export const STDERR_LOG_DELIMITER = '\n[grader stderr]\n';

/**
 * The minimal live-child surface this driver drives. `node:child_process`'s `ChildProcess`
 * satisfies it structurally; a test supplies a fake so the abort→terminate→settle bound is proved
 * without a real container that could ignore signals for real.
 */
export interface ContainerChildProcess {
  readonly pid?: number;
  readonly stdout: Pick<import('node:stream').Readable, 'on'>;
  readonly stderr: Pick<import('node:stream').Readable, 'on'>;
  on(event: 'close', listener: (code: number | null) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  kill(signal: NodeJS.Signals): boolean;
}

/** Injected process launcher. Default spawns the real `docker` CLI, shell-free. */
export type ContainerProcessSpawner = (
  command: string,
  args: readonly string[],
) => ContainerChildProcess;

/**
 * Host resource + isolation caps applied to every untrusted grader run. Resolved from the options
 * object over {@link DEFAULT_ISOLATION}; defaults mirror the in-repo docker-immutable-verifier.
 */
export interface ContainerIsolation {
  /** `--network`. `"none"` by default; set to e.g. `"bridge"` only for a method that needs egress. */
  readonly network: string;
  /** `--memory`. Hard memory cap; a balloon past it is OOM-killed by the kernel, not the host. */
  readonly memory: string;
  /** `--cpus`. CPU quota. */
  readonly cpus: string;
  /** `--pids-limit`. Fork-bomb bound. */
  readonly pidsLimit: number;
  /** Size (bytes) of the `noexec,nosuid` `/tmp` tmpfs that backs scratch under a read-only rootfs. */
  readonly tmpfsBytes: number;
  /** `--read-only` rootfs. Default true; the writable bind-mounted workdir stays writable. */
  readonly readOnlyRootfs: boolean;
  /** `--user`, when set. Default unset — see the header on why root is the documented default. */
  readonly user?: string;
}

export const DEFAULT_ISOLATION: ContainerIsolation = {
  network: 'none',
  memory: '8g',
  cpus: '4',
  pidsLimit: 512,
  tmpfsBytes: 64 * 1024 * 1024,
  readOnlyRootfs: true,
};

export interface DockerContainerRuntimeOptions {
  /** The docker binary. Default `"docker"`. */
  readonly dockerPath?: string;
  /** Grace between SIGTERM and the SIGKILL escalation. Default 10s. */
  readonly killGraceMs?: number;
  /**
   * Extra grace after SIGKILL before the run is force-settled regardless of whether the child ever
   * reported `close`. This is the backstop that makes "settle within a bound" true even for an
   * unkillable child. Default 10s.
   */
  readonly settleGraceMs?: number;
  /** OOM bound on captured stdout (N7). Default 4 MiB. */
  readonly maxStdoutBytes?: number;
  /** OOM bound on captured (diagnostic-only) stderr. Default 64 KiB. */
  readonly maxStderrBytes?: number;
  /** `--network`. Default `"none"`. */
  readonly network?: string;
  /** `--memory`. Default `"8g"`. */
  readonly memory?: string;
  /** `--cpus`. Default `"4"`. */
  readonly cpus?: string;
  /** `--pids-limit`. Default 512. */
  readonly pidsLimit?: number;
  /** `/tmp` tmpfs size in bytes. Default 64 MiB. */
  readonly tmpfsBytes?: number;
  /** `--read-only` rootfs. Default true. */
  readonly readOnlyRootfs?: boolean;
  /** `--user`. Default unset (image's own user). */
  readonly user?: string;
  /** Injected spawner (tests). Default launches the real docker CLI. */
  readonly spawn?: ContainerProcessSpawner;
}

const DEFAULT_KILL_GRACE_MS = 10_000;
const DEFAULT_SETTLE_GRACE_MS = 10_000;
const DEFAULT_MAX_STDOUT_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_STDERR_BYTES = 64 * 1024;

/** Resolve the host resource + isolation caps from options over {@link DEFAULT_ISOLATION}. */
export function resolveIsolation(options: DockerContainerRuntimeOptions = {}): ContainerIsolation {
  return {
    network: options.network ?? DEFAULT_ISOLATION.network,
    memory: options.memory ?? DEFAULT_ISOLATION.memory,
    cpus: options.cpus ?? DEFAULT_ISOLATION.cpus,
    pidsLimit: options.pidsLimit ?? DEFAULT_ISOLATION.pidsLimit,
    tmpfsBytes: options.tmpfsBytes ?? DEFAULT_ISOLATION.tmpfsBytes,
    readOnlyRootfs: options.readOnlyRootfs ?? DEFAULT_ISOLATION.readOnlyRootfs,
    ...(options.user === undefined ? {} : { user: options.user }),
  };
}

/**
 * Builds the shell-free `docker run` argv from a request. Exported so the argv shape is testable
 * directly. `--rm` so a terminated run leaves no container; `--name` so the run can be reaped out
 * of band on abort. Every untrusted grader run is resource-capped and isolated (see the header /
 * {@link ContainerIsolation}). The image is the final positional argument; every value the package
 * already validated (digest-pinned image, os/arch platform, absolute container paths) reaches
 * docker as its own argv element, never through a shell.
 */
export function buildDockerRunArgs(
  request: ContainerRunRequest,
  containerName: string,
  isolation: ContainerIsolation = DEFAULT_ISOLATION,
): string[] {
  const args: string[] = [
    'run',
    '--rm',
    '--name', containerName,
    // Resource + isolation caps on untrusted grader code (matches docker-immutable-verifier).
    '--network', isolation.network,
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges:true',
    '--pids-limit', String(isolation.pidsLimit),
    '--memory', isolation.memory,
    '--cpus', isolation.cpus,
    '--tmpfs', `/tmp:rw,noexec,nosuid,size=${isolation.tmpfsBytes}`,
  ];
  if (isolation.readOnlyRootfs) args.push('--read-only');
  if (isolation.user !== undefined) args.push('--user', isolation.user);
  if (request.platform !== undefined) args.push('--platform', request.platform);
  args.push('--workdir', request.workdir);
  for (const mount of request.mounts ?? []) {
    const spec = `type=bind,source=${mount.source},target=${mount.target}`;
    args.push('--mount', mount.readOnly === true ? `${spec},readonly` : spec);
  }
  for (const [key, value] of Object.entries(request.env ?? {})) {
    args.push('--env', `${key}=${value}`);
  }
  args.push(request.image);
  return args;
}

/** A byte-bounded, drop-on-overflow capture of a child stream. */
function boundedCapture(maxBytes: number): {
  readonly onData: (chunk: Buffer) => void;
  text(): string;
} {
  const chunks: Buffer[] = [];
  let size = 0;
  return {
    onData(chunk: Buffer): void {
      if (size >= maxBytes) return;
      const room = maxBytes - size;
      const slice = chunk.byteLength > room ? chunk.subarray(0, room) : chunk;
      chunks.push(slice);
      size += slice.byteLength;
    },
    text(): string {
      return Buffer.concat(chunks).toString('utf-8');
    },
  };
}

export function createDockerContainerRuntime(
  options: DockerContainerRuntimeOptions = {},
): ContainerRuntime {
  const dockerPath = options.dockerPath ?? 'docker';
  const killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
  const settleGraceMs = options.settleGraceMs ?? DEFAULT_SETTLE_GRACE_MS;
  const maxStdoutBytes = options.maxStdoutBytes ?? DEFAULT_MAX_STDOUT_BYTES;
  const maxStderrBytes = options.maxStderrBytes ?? DEFAULT_MAX_STDERR_BYTES;
  const isolation = resolveIsolation(options);
  const spawn = options.spawn ?? ((command, args) => nodeSpawn(command, [...args]) as ContainerChildProcess);

  /** Fire-and-forget container reaper; never blocks settlement or throws. */
  const reap = (reaperArgs: readonly string[]): void => {
    try {
      const reaper = spawn(dockerPath, reaperArgs);
      reaper.on('error', () => {});
      reaper.on('close', () => {});
    } catch {
      /* best-effort */
    }
  };

  return {
    run(request: ContainerRunRequest): Promise<ContainerRunResult> {
      // An already-elapsed deadline never starts a container: settle immediately.
      if (request.timeoutSignal?.aborted === true) {
        return Promise.reject(
          new ContainerTerminatedError('the deadline had already elapsed before the container started'),
        );
      }

      const containerName = `jinn-grader-${randomUUID()}`;
      const args = buildDockerRunArgs(request, containerName, isolation);
      const child = spawn(dockerPath, args);
      const stdout = boundedCapture(maxStdoutBytes);
      const stderr = boundedCapture(maxStderrBytes);
      child.stdout.on('data', (chunk: Buffer) => stdout.onData(chunk));
      child.stderr.on('data', (chunk: Buffer) => stderr.onData(chunk));

      return new Promise<ContainerRunResult>((resolve, reject) => {
        let settled = false;
        let killTimer: ReturnType<typeof setTimeout> | undefined;
        let settleTimer: ReturnType<typeof setTimeout> | undefined;
        const signal = request.timeoutSignal;

        const cleanup = (): void => {
          if (killTimer !== undefined) clearTimeout(killTimer);
          if (settleTimer !== undefined) clearTimeout(settleTimer);
          if (signal !== undefined) signal.removeEventListener('abort', onAbort);
        };
        const settleReject = (error: Error): void => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(error);
        };
        const settleResolve = (result: ContainerRunResult): void => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve(result);
        };

        const kill = (sig: NodeJS.Signals): void => {
          try {
            child.kill(sig);
          } catch {
            /* already gone */
          }
        };

        function onAbort(): void {
          // Terminate: SIGTERM the CLI, reap the container out of band so it dies even if the CLI
          // does not, escalate to SIGKILL after the grace, and force-settle after a further grace
          // whether or not the child ever reports `close` — then `docker rm -f` to close the
          // orphaned-container race (the CLI may have been SIGKILLed before `--rm` could fire).
          kill('SIGTERM');
          reap(['kill', containerName]);
          killTimer = setTimeout(() => kill('SIGKILL'), killGraceMs);
          killTimer.unref?.();
          settleTimer = setTimeout(() => {
            reap(['rm', '-f', containerName]);
            settleReject(new ContainerTerminatedError(
              `did not exit within ${killGraceMs + settleGraceMs}ms of the deadline`,
            ));
          }, killGraceMs + settleGraceMs);
          settleTimer.unref?.();
        }

        if (signal !== undefined) signal.addEventListener('abort', onAbort, { once: true });

        child.on('error', (error: Error) => {
          const detail = stderr.text().trim();
          const code = (error as NodeJS.ErrnoException).code;
          // ENOENT here means the OS could not find `dockerPath` at all (as opposed to `docker`
          // rejecting the argv) -- the common case is a daemon whose inherited PATH does not
          // contain the docker binary (e.g. macOS Docker Desktop, commonly /usr/local/bin/docker,
          // not /usr/bin/docker). Name the exact path that was tried and point at the fix: an
          // absolute `dockerPath` in the evaluator deployment's per-operator sidecar file (#2542).
          const remedy = code === 'ENOENT'
            ? ` — no "${dockerPath}" binary found; if this host's docker CLI is not on the daemon's `
              + 'PATH (e.g. Docker Desktop), set an absolute "dockerPath" in the evaluator deployment '
              + 'module\'s per-operator sidecar file'
            : '';
          settleReject(new Error(
            `docker run failed to spawn (${dockerPath}): ${error.message}${remedy}`
            + (detail.length > 0 ? ` — ${detail.slice(-512)}` : ''),
          ));
        });
        child.on('close', (code: number | null) => {
          if (signal?.aborted === true) {
            settleReject(new ContainerTerminatedError('the deadline elapsed while the container ran'));
            return;
          }
          const exitCode = code ?? 1;
          const out = stdout.text();
          if (exitCode !== 0) {
            // Preserve a crash-to-stderr diagnostic that would otherwise be lost when the grader
            // wrote no report (N6). The report file is untouched; this is the log channel only.
            const detail = stderr.text().trim();
            settleResolve({
              exitCode,
              stdout: detail.length > 0 ? `${out}${STDERR_LOG_DELIMITER}${detail}` : out,
            });
            return;
          }
          settleResolve({ exitCode, stdout: out });
        });
      });
    },
  };
}
