import { spawn, type ChildProcess } from 'node:child_process';
import * as path from 'node:path';
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
  readyTimeoutMs?: number;      // default 30s
  jinnBinPath?: string;         // default: resolve from cwd / dist/bin/jinn.js
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
  const jinnBin = opts.jinnBinPath ?? path.resolve(process.cwd(), 'dist', 'bin', 'jinn.js');

  const daemons: Record<string, DaemonHandle> = {};
  const processes: ChildProcess[] = [];

  async function killAll(): Promise<void> {
    for (const proc of processes) {
      if (!proc.killed && proc.pid) {
        try { proc.kill('SIGTERM'); } catch {}
      }
    }
    await new Promise((r) => setTimeout(r, 200));
    for (const proc of processes) {
      if (!proc.killed && proc.pid) {
        try { proc.kill('SIGKILL'); } catch {}
      }
    }
  }

  // When the test seed config has an unreachable rpcUrl (e.g. a dummy hostname
  // used in beforeAll setup), JINN_RPC_URL overrides config so the daemon's
  // RPC preflight can pass. config.ts gives JINN_RPC_URL unconditional precedence
  // over BASE_RPC_URL and BASE_SEPOLIA_RPC_URL, so the helper must consult any
  // RPC URL the caller put in extraEnv (e.g. an Anvil fork URL) and surface it
  // through JINN_RPC_URL — otherwise extraEnv.BASE_RPC_URL would be silently
  // overridden by the host fallback. Resolution order: extraEnv.JINN_RPC_URL,
  // extraEnv.BASE_RPC_URL, host JINN_RPC_URL, host BASE_SEPOLIA_RPC_URL, then
  // the public Tenderly gateway (matches config.ts:986).
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
      proc.stdout?.on('data', (chunk) => collector.feed(chunk.toString()));
      proc.stderr?.on('data', (chunk) => collector.feed(chunk.toString()));

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
