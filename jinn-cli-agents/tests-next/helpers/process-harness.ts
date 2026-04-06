import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { execa } from 'execa';
import fetch from 'cross-fetch';
import { findAvailablePort } from './port-utils.js';

interface SpawnOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  stdio?: 'inherit' | 'pipe';
}

type SpawnedProcess = ReturnType<typeof execa>;

interface HarnessProcess {
  name: string;
  handle: SpawnedProcess;
}

export interface HarnessOptions {
  rpcUrl: string;
  suiteId?: string;
  startWorker?: boolean;
  workerArgs?: string[];
  env?: Record<string, string>;
  logDir?: string;
  /**
   * When true (or when KEEP_DEBUG_PROCESSES=1), the harness processes will remain
   * running if the wrapped test fails so we can inspect state manually.
   */
  keepAliveOnFailure?: boolean;
}

export interface HarnessContext {
  suiteId: string;
  ponderPort: number;
  controlPort: number;
  gqlUrl: string;
  controlUrl: string;
  logDir: string;
}

const ansiRegex = /\u001b\[[0-9;]*[A-Za-z]/g;

async function waitForGraphql(url: string, timeoutMs = 60_000): Promise<void> {
  const start = Date.now();
  let lastErr: Error | null = null;
  while (Date.now() - start < timeoutMs) {
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: '{ requests(limit: 1) { items { id } } }' }),
      });
      if (resp.ok) return;
      lastErr = new Error(`GraphQL HTTP ${resp.status}`);
    } catch (err) {
      lastErr = err as Error;
    }
    await sleep(1000);
  }
  throw lastErr ?? new Error(`Timed out waiting for GraphQL at ${url}`);
}

async function calculateStartBlock(rpcUrl: string): Promise<number | undefined> {
  try {
    const resp = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'eth_blockNumber', params: [], id: 1 }),
    });
    const data = await resp.json();
    const currentBlock = parseInt(data.result, 16);
    return Math.max(0, currentBlock - 100);
  } catch (err) {
    console.warn('[process-harness] Failed to calculate start block:', (err as Error).message);
    return undefined;
  }
}

export class ProcessHarness {
  private readonly logDir: string;
  private readonly suiteId: string;
  private processes: HarnessProcess[] = [];
  private context: HarnessContext | null = null;
  private baseEnv: Record<string, string> = {};
  private previousLogDirEnv: string | undefined;
  private cleanupRegistered = false;
  private keepAliveMode = false;

  constructor(logDir?: string) {
    this.logDir = logDir ?? path.join(process.cwd(), 'logs', 'test-run', `${Date.now()}-${randomUUID()}`);
    fs.mkdirSync(this.logDir, { recursive: true });
    this.suiteId = `tests-next-${Date.now()}-${process.pid}`;
    this.registerCleanupHandlers();
  }

  private registerCleanupHandlers(): void {
    if (this.cleanupRegistered) return;
    this.cleanupRegistered = true;

    const cleanup = () => {
      // Synchronous cleanup for exit handler
      const procs = [...this.processes].reverse();
      for (const proc of procs) {
        const handle = proc.handle;
        if (handle.pid) {
          try {
            handle.kill('SIGKILL');
          } catch {
            // Ignore errors
          }
        }
      }
    };

    const asyncCleanup = async () => {
      await this.stop().catch(() => {
        // Ignore errors during cleanup
      });
    };

    // Register cleanup on process exit (synchronous only)
    process.once('exit', cleanup);
    process.once('SIGINT', async () => {
      await asyncCleanup();
      process.exit(1);
    });
    process.once('SIGTERM', async () => {
      await asyncCleanup();
      process.exit(1);
    });

    // Also handle uncaught exceptions
    process.once('uncaughtException', async (err) => {
      console.error('[process-harness] Uncaught exception, cleaning up:', err);
      await asyncCleanup();
      throw err;
    });
  }

  getContext(): HarnessContext {
    if (!this.context) {
      throw new Error('Process harness has not been started yet.');
    }
    return this.context;
  }

  private spawn(
    name: string,
    command: string,
    args: string[],
    options?: SpawnOptions
  ): SpawnedProcess {
    const logPath = path.join(this.logDir, `${name}.log`);
    const logStream = fs.createWriteStream(logPath, { flags: 'a' });
    logStream.write(`[${new Date().toISOString()}] ${command} ${args.join(' ')}\n`);

    const detach = this.keepAliveMode;
    const handle = execa(command, args, {
      cwd: options?.cwd ?? process.cwd(),
      env: { ...process.env, ...this.baseEnv, ...options?.env },
      stdio: options?.stdio ?? 'pipe',
      cleanup: !detach,
      detached: detach,
      forceKillAfterTimeout: 2000,
    });

    const writeChunk = (chunk: Buffer) => {
      const sanitized = chunk.toString().replace(ansiRegex, '').replace(/\r/g, '\n');
      logStream.write(sanitized);
    };

    handle.stdout?.on('data', writeChunk);
    handle.stderr?.on('data', writeChunk);

    handle.finally(() => {
      logStream.end(`[${new Date().toISOString()}] ${name} exited\n`);
    }).catch(() => {
      // Swallow errors; they will propagate when awaited explicitly.
    });

    if (detach) {
      handle.unref();
    }

    this.processes.push({ name, handle });
    return handle;
  }

  async start(options: HarnessOptions): Promise<HarnessContext> {
    if (this.context) return this.context;

    this.baseEnv = options.env ?? {};
    this.keepAliveMode =
      options.keepAliveOnFailure ?? process.env.KEEP_DEBUG_PROCESSES === '1';

    const ponderCacheDir =
      process.env.PONDER_DATABASE_DIR ??
      path.join(process.cwd(), `.ponder-${this.suiteId}`);
    fs.mkdirSync(ponderCacheDir, { recursive: true });

    const ponderBase = Number(process.env.PONDER_PORT_BASE) || 42070;
    const controlBase = Number(process.env.CONTROL_API_PORT_BASE) || 4001;

    const ponderPort = this.baseEnv.PONDER_PORT
      ? Number(this.baseEnv.PONDER_PORT)
      : await findAvailablePort(ponderBase);
    const controlPort = this.baseEnv.CONTROL_API_PORT
      ? Number(this.baseEnv.CONTROL_API_PORT)
      : await findAvailablePort(controlBase);

    const gqlUrl = `http://127.0.0.1:${ponderPort}/graphql`;
    const controlUrl = `http://127.0.0.1:${controlPort}/graphql`;

    await this.startPonder(ponderPort, options.rpcUrl, ponderCacheDir);
    await this.startControlApi(controlPort, gqlUrl);

    if (options.startWorker !== false) {
      this.startWorker(controlUrl, gqlUrl, options.workerArgs);
    }

    this.context = {
      suiteId: options.suiteId ?? this.suiteId,
      ponderPort,
      controlPort,
      gqlUrl,
      controlUrl,
      logDir: this.logDir,
    };

    process.env.PONDER_PORT = String(ponderPort);
    process.env.PONDER_GRAPHQL_URL = gqlUrl;
    process.env.CONTROL_API_PORT = String(controlPort);
    process.env.CONTROL_API_URL = controlUrl;
    process.env.PONDER_DATABASE_DIR = ponderCacheDir;
    this.previousLogDirEnv = process.env.TESTS_NEXT_LOG_DIR;
    process.env.TESTS_NEXT_LOG_DIR = this.logDir;

    return this.context;
  }

  private async startPonder(port: number, rpcUrl: string, cacheDir: string): Promise<void> {
    // Use Supabase Postgres for tests so embeddings are accessible to recognition search
    // Both Ponder and recognition search use the same node_embeddings_test table
    if (!process.env.SUPABASE_POSTGRES_URL) {
      throw new Error(
        'SUPABASE_POSTGRES_URL must be set for system tests that use recognition/embeddings. ' +
        'Set it in .env to your Supabase Postgres connection string.'
      );
    }

    await execa('yarn', ['ponder:predev'], {
      stdio: 'inherit',
      env: { ...process.env, ...this.baseEnv },
    });
    const startBlock = await calculateStartBlock(rpcUrl);
    const ponderEnv: Record<string, string> = {
      ...process.env,
      ...this.baseEnv,
      RPC_URL: rpcUrl,
      PORT: String(port),
      PONDER_DATABASE_URL: process.env.SUPABASE_POSTGRES_URL,
      SUPABASE_POSTGRES_URL: process.env.SUPABASE_POSTGRES_URL,
      VITEST: 'true',
      // Set factory start block to 0 for test environments to scan entire VNet history
      // This allows Ponder to discover CreateMech events in Tenderly VNets which don't
      // contain mainnet blocks before the fork point
      PONDER_FACTORY_START_BLOCK: '0',
    };

    if (typeof startBlock === 'number') {
      ponderEnv.PONDER_START_BLOCK = String(startBlock);
    }

    const ponderBin = path.join(
      process.cwd(),
      'node_modules',
      '.bin',
      process.platform === 'win32' ? 'ponder.cmd' : 'ponder'
    );
    this.spawn('ponder', ponderBin, ['dev', '--port', String(port)], {
      cwd: path.join(process.cwd(), 'ponder'),
      env: ponderEnv,
    });
    await waitForGraphql(`http://127.0.0.1:${port}/graphql`, 120_000);
  }

  private async startControlApi(port: number, gqlUrl: string): Promise<void> {
    const tsxBin = path.join(
      process.cwd(),
      'node_modules',
      '.bin',
      process.platform === 'win32' ? 'tsx.cmd' : 'tsx'
    );

    this.spawn('control-api', tsxBin, ['control-api/server.ts'], {
      env: {
        CONTROL_API_PORT: String(port),
        PONDER_GRAPHQL_URL: gqlUrl,
      },
      stdio: 'inherit',
    });

    await this.waitForControlApi(port);
  }

  private async waitForControlApi(port: number): Promise<void> {
    const controlUrl = `http://127.0.0.1:${port}/graphql`;
    const start = Date.now();
    let lastErr: Error | null = null;
    while (Date.now() - start < 60_000) {
      try {
        const resp = await fetch(controlUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ query: '{ _health }' }),
        });
        const data = await resp.json();
        if (data?.data?._health === 'ok') return;
        lastErr = new Error('Health check failed');
      } catch (err) {
        lastErr = err as Error;
      }
      await sleep(1000);
    }
    throw lastErr ?? new Error('Timed out waiting for Control API');
  }

  private startWorker(controlUrl: string, gqlUrl: string, workerArgs?: string[]): void {
    const args = ['dev:mech:raw'];
    if (workerArgs && workerArgs.length > 0) {
      args.push('--', ...workerArgs);
    }
    this.spawn('worker', 'yarn', args, {
      env: {
        CONTROL_API_URL: controlUrl,
        PONDER_GRAPHQL_URL: gqlUrl,
        USE_CONTROL_API: 'true',
      },
      stdio: 'inherit',
    });
  }

  async stop(): Promise<void> {
    const procs = [...this.processes].reverse();
    this.processes = [];
    
    // Kill all processes with timeout
    const killPromises = procs.map(async (proc) => {
      const handle = proc.handle;
      if (!handle.pid) return;
      
      try {
        // Try graceful shutdown first
        handle.kill('SIGTERM');
        // Wait up to 3 seconds for graceful shutdown
        await Promise.race([
          handle,
          sleep(3000),
        ]);
      } catch {
        // Process may have exited already
      }
      
      // Force kill if still running
      try {
        if (handle.pid && !handle.killed) {
          handle.kill('SIGKILL');
          // Give it a moment to die
          await sleep(500);
        }
      } catch {
        // Process already gone
      }
    });
    
    await Promise.allSettled(killPromises);
    
    // Defensive check: verify ports are actually freed
    if (this.context) {
      const { ponderPort, controlPort } = this.context;
      // Small delay to let OS release ports
      await sleep(500);
    }
    
    this.context = null;
    this.baseEnv = {};
    if (this.previousLogDirEnv === undefined) {
      delete process.env.TESTS_NEXT_LOG_DIR;
    } else {
      process.env.TESTS_NEXT_LOG_DIR = this.previousLogDirEnv;
    }
  }
}

export async function withProcessHarness<T>(
  options: HarnessOptions,
  fn: (ctx: HarnessContext, harness: ProcessHarness) => Promise<T>
): Promise<T> {
  const harness = new ProcessHarness(options.logDir);
  let failed = false;
  try {
    const ctx = await harness.start(options);
    return await fn(ctx, harness);
  } catch (err) {
    failed = true;
    throw err;
  } finally {
    const keepAliveEnv = process.env.KEEP_DEBUG_PROCESSES === '1';
    const keepAliveRequested = options.keepAliveOnFailure ?? keepAliveEnv;
    if (failed && keepAliveRequested) {
      console.warn(
        '[process-harness] KEEP_DEBUG_PROCESSES active - leaving harness running for manual inspection.'
      );
      let ctx: HarnessContext | null = null;
      try {
        ctx = harness.getContext();
      } catch {
        ctx = null;
      }
      if (ctx) {
        console.warn(
          `[process-harness] Ponder GraphQL: ${ctx.gqlUrl} | Control API: ${ctx.controlUrl} | Logs: ${ctx.logDir}`
        );
      }
    } else {
      await harness.stop();
    }
  }
}
