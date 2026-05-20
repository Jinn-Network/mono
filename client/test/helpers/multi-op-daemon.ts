import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeHandshakeCollector } from './handshake-url';

export interface OpSpec {
  name: string;
  home: string;                 // HOME directory containing .jinn-client/
  apiPort: number;
}

export interface DaemonHandle {
  name: string;
  pid: number;
  apiPort: number;
  handshakeUrl: string | null;  // null if not emitted within readyTimeoutMs
  process: ChildProcess;
}

export interface MultiOpHandle {
  daemons: Record<string, DaemonHandle>;
  teardown: () => Promise<void>;
}

export interface SpawnMultiOpOptions {
  ops: OpSpec[];
  /**
   * Per-daemon readiness timeout in milliseconds (default 30s). Applied
   * independently to each daemon in `ops` — the worst-case total wall time
   * for a group of N daemons is N × readyTimeoutMs, since daemons are spawned
   * and awaited sequentially.
   */
  readyTimeoutMs?: number;
  jinnBinPath?: string;         // default: dist/bin/jinn.js resolved relative to this module
  extraEnv?: NodeJS.ProcessEnv;
}

async function waitForBootstrap(apiPort: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${apiPort}/v1/bootstrap`, { method: 'GET' });
      if (res.status === 200 || res.status === 401) return;
    } catch {
      // not yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`daemon on port ${apiPort} did not become reachable within ${timeoutMs}ms`);
}

export async function spawnMultiOpDaemons(opts: SpawnMultiOpOptions): Promise<MultiOpHandle> {
  const readyTimeoutMs = opts.readyTimeoutMs ?? 30000;
  // Resolve the built binary relative to this module rather than process.cwd(),
  // which is unstable across test runners and invocation directories.
  const jinnBin =
    opts.jinnBinPath ?? fileURLToPath(new URL('../../dist/bin/jinn.js', import.meta.url));

  const daemons: Record<string, DaemonHandle> = {};
  const processes: ChildProcess[] = [];

  async function killAll(): Promise<void> {
    const signal = (sig: NodeJS.Signals) => {
      for (const proc of processes) {
        if (!proc.killed && proc.pid) {
          try { proc.kill(sig); } catch {}
        }
      }
    };
    signal('SIGTERM');
    await new Promise((r) => setTimeout(r, 200));
    signal('SIGKILL');
  }

  // config.ts gives JINN_RPC_URL unconditional precedence over BASE_RPC_URL,
  // so any RPC URL the caller passed in extraEnv must be surfaced through it.
  // Resolution order: extraEnv JINN/BASE RPC URL, host JINN/BASE_SEPOLIA RPC
  // URL, then the public Tenderly gateway (matches config.ts:986).
  const fallbackRpcUrl =
    opts.extraEnv?.['JINN_RPC_URL'] ??
    opts.extraEnv?.['BASE_RPC_URL'] ??
    process.env['JINN_RPC_URL'] ??
    process.env['BASE_SEPOLIA_RPC_URL'] ??
    'https://base-sepolia.gateway.tenderly.co/75tyLMQuD8EHpXxMwINIKu';

  try {
    for (const op of opts.ops) {
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        JINN_RPC_URL: fallbackRpcUrl,
        ...opts.extraEnv,
        HOME: op.home,
        JINN_API_PORT: op.apiPort.toString(),
      };
      const proc = spawn('node', [jinnBin, 'run', '--no-ui'], {
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      processes.push(proc);

      const collector = makeHandshakeCollector(readyTimeoutMs);
      const onStdout = (chunk: Buffer | string) => collector.feed(chunk.toString());
      const onStderr = (chunk: Buffer | string) => collector.feed(chunk.toString());
      proc.stdout?.on('data', onStdout);
      proc.stderr?.on('data', onStderr);
      // Detach the handshake listeners once the collector settles, so they do
      // not stay attached for the child's lifetime (MaxListenersExceededWarning
      // risk across many daemons + no-op feed() churn).
      const detachHandshakeListeners = () => {
        proc.stdout?.off('data', onStdout);
        proc.stderr?.off('data', onStderr);
      };
      collector.promise.then(detachHandshakeListeners, detachHandshakeListeners);

      // Wait for bootstrap to be reachable
      await waitForBootstrap(op.apiPort, readyTimeoutMs);

      // Best-effort handshake URL capture (may not emit if daemon is in non-running mode)
      let handshakeUrl: string | null = null;
      try {
        handshakeUrl = await Promise.race([
          collector.promise,
          new Promise<string>((_, rej) => setTimeout(() => rej(new Error('handshake not emitted')), 2000)),
        ]);
      } catch {
        handshakeUrl = null;
      } finally {
        // If the 2s race lost, collector.promise may still be pending; dispose
        // it so its timeout clears and detach the listeners now.
        collector.dispose();
        detachHandshakeListeners();
      }

      daemons[op.name] = {
        name: op.name,
        pid: proc.pid ?? -1,
        apiPort: op.apiPort,
        handshakeUrl,
        process: proc,
      };
    }
  } catch (err) {
    await killAll();
    throw err;
  }

  let torn = false;
  return {
    daemons,
    teardown: async () => {
      if (torn) return;
      torn = true;
      await killAll();
    },
  };
}
