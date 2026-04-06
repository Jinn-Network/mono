/**
 * Process orchestration for dev-vnet services
 *
 * Responsibilities:
 * - Start services with proper environment
 * - Stream output with prefixes
 * - Detect crashes and quota errors
 * - Graceful shutdown
 * - Persist output to log files (survives parent exit for detached processes)
 */

import { execa, type ResultPromise } from 'execa';
import fetch from 'cross-fetch';
import { scriptLogger } from 'jinn-node/logging/index.js';
import { join } from 'path';

export interface ServiceConfig {
  name: string;
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string | undefined>;
  logDir?: string;
}

export interface HealthCheckConfig {
  url: string;
  query: string;
  expectedResponse: (data: any) => boolean;
  timeoutMs: number;
  intervalMs: number;
}

export class ProcessManager {
  private processes = new Map<string, ResultPromise>();
  private logPaths = new Map<string, string>();
  private onCrash?: (serviceName: string, code: number) => void;
  private onQuotaError?: () => void;
  private isShuttingDown = false;

  constructor(options?: {
    onCrash?: (serviceName: string, code: number) => void;
    onQuotaError?: () => void;
  }) {
    this.onCrash = options?.onCrash;
    this.onQuotaError = options?.onQuotaError;
  }

  /**
   * Start a service with output streaming.
   *
   * When `logDir` is set, stdout/stderr are written directly to a log file via
   * inherited file descriptors. This survives parent exit — crash output is
   * captured even after the bootstrap process exits.
   */
  startService(config: ServiceConfig): ResultPromise {
    let proc: ResultPromise;

    if (config.logDir) {
      const logPath = join(config.logDir, `${config.name}.log`);
      this.logPaths.set(config.name, logPath);

      // Write stdout+stderr directly to a log file via execa's { file } option.
      // The child inherits the file descriptor, so output survives parent exit —
      // crash stack traces and errors are captured for post-mortem diagnosis.
      proc = execa(config.command, config.args, {
        cwd: config.cwd,
        env: { ...process.env, ...config.env },
        stdin: 'ignore',
        stdout: { file: logPath },
        stderr: { file: logPath },
        detached: true,
      });

      console.log(`[${config.name}] Logging to ${logPath}`);
    } else {
      // No log dir — use pipes directly (original behavior)
      proc = execa(config.command, config.args, {
        cwd: config.cwd,
        env: { ...process.env, ...config.env },
        stdio: 'pipe',
        detached: true,
      });

      if (proc.stdout) {
        proc.stdout.on('data', (data: Buffer) => {
          const lines = data.toString().split('\n');
          for (const line of lines) {
            if (line.trim()) {
              console.log(`[${config.name}] ${line}`);
              this.checkQuota(line);
            }
          }
        });
      }

      if (proc.stderr) {
        proc.stderr.on('data', (data: Buffer) => {
          const lines = data.toString().split('\n');
          for (const line of lines) {
            if (line.trim()) {
              console.error(`[${config.name}] ${line}`);
              this.checkQuota(line);
            }
          }
        });
      }
    }

    // Monitor crashes (but ignore exit events during shutdown)
    proc.on('exit', (code: number | null) => {
      if (code !== 0 && code !== null && this.onCrash && !this.isShuttingDown) {
        this.onCrash(config.name, code);
      }
    });

    this.processes.set(config.name, proc);
    return proc;
  }

  private checkQuota(line: string): void {
    if (this.onQuotaError &&
        (line.includes('429') ||
         line.includes('quota limit') ||
         line.includes('rate limit'))) {
      this.onQuotaError();
    }
  }

  /**
   * Wait for GraphQL endpoint to be healthy
   */
  async waitForGraphql(config: HealthCheckConfig): Promise<void> {
    const start = Date.now();
    let lastErr: any = null;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      try {
        const resp = await fetch(config.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ query: config.query }),
        });

        if (resp.ok) {
          const data = await resp.json();
          if (config.expectedResponse(data)) {
            return; // Success
          }
        }
        lastErr = new Error(`GraphQL HTTP ${resp.status}`);
      } catch (e: any) {
        lastErr = e;
      }

      if (Date.now() - start > config.timeoutMs) {
        throw lastErr || new Error(`Timed out waiting for ${config.url}`);
      }

      await new Promise(r => setTimeout(r, config.intervalMs));
    }
  }

  /**
   * Kill all processes gracefully
   */
  async killAll(): Promise<void> {
    this.isShuttingDown = true; // Set flag to prevent crash handler from triggering
    const killPromises: Promise<void>[] = [];

    Array.from(this.processes.entries()).forEach(([name, proc]) => {
      scriptLogger.info({ serviceName: name }, 'Stopping service');
      killPromises.push(
        new Promise<void>((resolve) => {
          try {
            // Kill the process group (negative PID) so grandchildren die too.
            // Detached processes run in their own group with pgid === pid.
            if (proc.pid) {
              process.kill(-proc.pid, 'SIGTERM');
            } else {
              proc.kill('SIGTERM');
            }
            // Force kill after timeout
            setTimeout(() => {
              try {
                if (proc.pid) {
                  process.kill(-proc.pid, 'SIGKILL');
                } else {
                  proc.kill('SIGKILL');
                }
              } catch (e) {
                // Already dead
              }
            }, 5000);
          } catch (e) {
            // Ignore errors
          }
          resolve();
        })
      );
    });

    await Promise.all(killPromises);
    this.processes.clear();
  }

  /**
   * Get process by name
   */
  getProcess(name: string): ResultPromise | undefined {
    return this.processes.get(name);
  }

  /**
   * Get all process PIDs
   */
  getPids(): Map<string, number> {
    const pids = new Map<string, number>();
    Array.from(this.processes.entries()).forEach(([name, proc]) => {
      if (proc.pid) {
        pids.set(name, proc.pid);
      }
    });
    return pids;
  }

  /**
   * Get log file paths for all services started with logDir
   */
  getLogPaths(): Map<string, string> {
    return new Map(this.logPaths);
  }
}
