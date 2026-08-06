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
 * container — the driver does." An untrusted grader image can ignore SIGTERM and run indefinitely;
 * the package cannot stop it. This driver enforces the settle bound: on `timeoutSignal` it SIGTERMs
 * the CLI, escalates to SIGKILL after a grace, reaps the container out of band (`docker kill
 * <name>`), and rejects within a hard bound EVEN IF the child never closes. The bound is a function
 * of `killGraceMs + settleGraceMs`, never of the container's cooperation.
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
 * STDERR (P0-4 N6, deliberate): `ContainerRunResult` carries only `{ exitCode, stdout }`. The
 * grader's decision comes from the report file it writes to disk (the package reads that, not this
 * driver) and its log is stdout. stderr is therefore diagnostic only: it is captured under a small
 * bound and surfaced solely in the message of a spawn/`error` rejection, never mixed into the
 * returned stdout.
 *
 * STDOUT/OOM (P0-4 N7): captured stdout is bounded to `maxStdoutBytes`; a container that floods
 * stdout cannot OOM the daemon — bytes past the cap are dropped. (The grader REPORT file read is
 * `readReport` inside the package's `containerGraderReportSource`, an unbounded `readFile`; bounding
 * that is a package concern, tracked as a finding, and out of this driver's reach.)
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
  /** Injected spawner (tests). Default launches the real docker CLI. */
  readonly spawn?: ContainerProcessSpawner;
}

const DEFAULT_KILL_GRACE_MS = 10_000;
const DEFAULT_SETTLE_GRACE_MS = 10_000;
const DEFAULT_MAX_STDOUT_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_STDERR_BYTES = 64 * 1024;

/**
 * Builds the shell-free `docker run` argv from a request. Exported so the argv shape is testable
 * directly. `--rm` so a terminated run leaves no container; `--name` so the run can be reaped out
 * of band on abort. The image is the final positional argument; every value the package already
 * validated (digest-pinned image, os/arch platform, absolute container paths) reaches docker as its
 * own argv element, never through a shell.
 */
export function buildDockerRunArgs(request: ContainerRunRequest, containerName: string): string[] {
  const args: string[] = ['run', '--rm', '--name', containerName];
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
  const spawn = options.spawn ?? ((command, args) => nodeSpawn(command, [...args]) as ContainerChildProcess);

  return {
    run(request: ContainerRunRequest): Promise<ContainerRunResult> {
      // An already-elapsed deadline never starts a container: settle immediately.
      if (request.timeoutSignal?.aborted === true) {
        return Promise.reject(
          new ContainerTerminatedError('the deadline had already elapsed before the container started'),
        );
      }

      const containerName = `jinn-grader-${randomUUID()}`;
      const args = buildDockerRunArgs(request, containerName);
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
          // whether or not the child ever reports `close`.
          kill('SIGTERM');
          try {
            const reaper = spawn(dockerPath, ['kill', containerName]);
            reaper.on('error', () => {});
            reaper.on('close', () => {});
          } catch {
            /* best-effort */
          }
          killTimer = setTimeout(() => kill('SIGKILL'), killGraceMs);
          killTimer.unref?.();
          settleTimer = setTimeout(
            () => settleReject(new ContainerTerminatedError(
              `did not exit within ${killGraceMs + settleGraceMs}ms of the deadline`,
            )),
            killGraceMs + settleGraceMs,
          );
          settleTimer.unref?.();
        }

        if (signal !== undefined) signal.addEventListener('abort', onAbort, { once: true });

        child.on('error', (error: Error) => {
          const detail = stderr.text().trim();
          settleReject(new Error(
            `docker run failed to spawn (${dockerPath}): ${error.message}`
            + (detail.length > 0 ? ` — ${detail.slice(-512)}` : ''),
          ));
        });
        child.on('close', (code: number | null) => {
          if (signal?.aborted === true) {
            settleReject(new ContainerTerminatedError('the deadline elapsed while the container ran'));
            return;
          }
          settleResolve({ exitCode: code ?? 1, stdout: stdout.text() });
        });
      });
    },
  };
}
