import {
  spawn,
  type ChildProcess,
  type SpawnOptions,
} from 'node:child_process';

const DEFAULT_TERMINATION_GRACE_MS = 2_000;
const DEFAULT_REAP_TIMEOUT_MS = 2_000;

export class SupervisedProcessUnreapedError extends Error {
  readonly cleanupUnsafe = true;

  constructor(command: string) {
    super(`Process group did not close after SIGKILL: ${command}`);
    this.name = 'SupervisedProcessUnreapedError';
  }
}

export interface SupervisedProcessOptions {
  cwd?: string;
  env: NodeJS.ProcessEnv;
  /** Optional stdin payload, used to keep large trusted prompts out of argv. */
  input?: string;
  abort?: AbortSignal;
  maxOutputBytes: number;
  terminationGraceMs?: number;
  reapTimeoutMs?: number;
  spawn?: typeof spawn;
  killProcessGroup?: (pid: number, signal: NodeJS.Signals) => void;
}

export interface SupervisedProcessResult {
  stdout: string;
  stderr: string;
}

function abortError(): Error {
  const error = new Error('Process aborted');
  error.name = 'AbortError';
  return error;
}

/**
 * Runs one detached process group and does not settle cancellation until the
 * direct child closes. A bounded SIGTERM -> SIGKILL sequence prevents leaked
 * descendants from retaining the evaluator checkout or isolated HOME.
 */
export async function runSupervisedProcess(
  command: string,
  args: string[],
  options: SupervisedProcessOptions,
): Promise<SupervisedProcessResult> {
  if (options.abort?.aborted) throw abortError();

  const spawnFn = options.spawn ?? spawn;
  const killProcessGroup = options.killProcessGroup
    ?? ((pid: number, signal: NodeJS.Signals) => process.kill(-pid, signal));
  const spawnOptions: SpawnOptions = {
    ...(options.cwd ? { cwd: options.cwd } : {}),
    env: options.env,
    detached: process.platform !== 'win32',
    stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
  };
  const child: ChildProcess = spawnFn(command, args, spawnOptions);
  const terminationGraceMs =
    options.terminationGraceMs ?? DEFAULT_TERMINATION_GRACE_MS;
  const reapTimeoutMs = options.reapTimeoutMs ?? DEFAULT_REAP_TIMEOUT_MS;

  return await new Promise<SupervisedProcessResult>((resolve, reject) => {
    let settled = false;
    let stoppingError: Error | undefined;
    let stdout = '';
    let stderr = '';
    let terminationTimer: ReturnType<typeof setTimeout> | undefined;
    let reapTimer: ReturnType<typeof setTimeout> | undefined;

    const clearTimers = (): void => {
      if (terminationTimer) clearTimeout(terminationTimer);
      if (reapTimer) clearTimeout(reapTimer);
    };
    const finish = (
      result: SupervisedProcessResult | undefined,
      error: Error | undefined,
    ): void => {
      if (settled) return;
      settled = true;
      clearTimers();
      options.abort?.removeEventListener('abort', onAbort);
      if (error) reject(error);
      else resolve(result!);
    };
    const signal = (value: NodeJS.Signals): void => {
      const pid = child.pid;
      if (typeof pid === 'number') {
        if (process.platform !== 'win32') {
          try {
            killProcessGroup(pid, value);
          } catch {
            // The direct child signal below is the fallback when the process
            // group no longer exists or the platform refuses negative PIDs.
          }
        }
        try {
          child.kill(value);
        } catch {
          // Close/reap timeout remains authoritative.
        }
      }
    };
    const beginTermination = (error: Error): void => {
      if (stoppingError || settled) return;
      stoppingError = error;
      signal('SIGTERM');
      terminationTimer = setTimeout(() => {
        signal('SIGKILL');
        reapTimer = setTimeout(() => {
          finish(undefined, new SupervisedProcessUnreapedError(command));
        }, reapTimeoutMs);
        reapTimer.unref?.();
      }, terminationGraceMs);
      terminationTimer.unref?.();
    };
    const onAbort = (): void => beginTermination(abortError());

    const appendOutput = (
      current: string,
      chunk: Buffer | string,
    ): string => {
      const next = current + chunk.toString();
      if (Buffer.byteLength(next) > options.maxOutputBytes) {
        beginTermination(new Error(
          `Process output exceeded ${options.maxOutputBytes} bytes: ${command}`,
        ));
        return next.slice(0, options.maxOutputBytes);
      }
      return next;
    };

    child.stdout?.on('data', (chunk: Buffer | string) => {
      stdout = appendOutput(stdout, chunk);
    });
    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderr = appendOutput(stderr, chunk);
    });
    const onProcessError = (error: Error): void => {
      if (child.pid === undefined) {
        finish(undefined, error);
        return;
      }
      beginTermination(error);
    };
    child.once('error', onProcessError);
    child.stdin?.once('error', onProcessError);
    child.once('close', (code, signalValue) => {
      if (stoppingError) {
        finish(undefined, stoppingError);
        return;
      }
      if (code === 0) {
        finish({ stdout, stderr }, undefined);
        return;
      }
      finish(undefined, new Error(
        `${command} exited with code ${String(code)}`
        + `${signalValue ? ` (${signalValue})` : ''}: ${stderr.slice(0, 4000)}`,
      ));
    });

    options.abort?.addEventListener('abort', onAbort, { once: true });
    if (options.abort?.aborted) onAbort();
    if (options.input !== undefined && !stoppingError) {
      if (!child.stdin) {
        beginTermination(new Error(`Process stdin is unavailable: ${command}`));
      } else {
        child.stdin.end(options.input);
      }
    }
  });
}
