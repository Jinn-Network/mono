import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';

export interface AnvilHandle {
  rpcUrl: string;
  port: number;
  proc: ChildProcess;
  kill: () => Promise<void>;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (addr === null || typeof addr === 'string') {
        srv.close();
        reject(new Error('no port'));
        return;
      }
      const port = addr.port;
      srv.close(() => resolve(port));
    });
  });
}

export async function spawnAnvil(opts: { forkUrl?: string; forkBlock?: number; chainId?: number; logPath?: string }): Promise<AnvilHandle> {
  const port = await freePort();
  const args = ['--port', String(port), '--host', '127.0.0.1', '--silent'];
  if (opts.forkUrl) {
    args.push('--fork-url', opts.forkUrl);
    // Generous upstream timeout + retries: the pinned block needs archive reads.
    args.push('--timeout', '45000', '--retries', '5');
  }
  if (opts.forkBlock) args.push('--fork-block-number', String(opts.forkBlock));
  if (opts.chainId) args.push('--chain-id', String(opts.chainId));
  const proc = spawn('anvil', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  const rpcUrl = `http://127.0.0.1:${port}`;

  let stderr = '';
  proc.stderr?.on('data', (d) => { stderr += String(d); });

  // Wait for readiness: poll eth_chainId until it answers or the process dies.
  const deadline = Date.now() + 120_000;
  let exited = false;
  proc.on('exit', () => { exited = true; });
  for (;;) {
    if (exited) throw new Error(`anvil exited before ready: ${stderr.slice(-2000)}`);
    if (Date.now() > deadline) {
      proc.kill('SIGKILL');
      throw new Error(`anvil not ready within 120s: ${stderr.slice(-2000)}`);
    }
    try {
      const res = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
      });
      const body = (await res.json()) as { result?: string };
      if (body.result) break;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }

  return {
    rpcUrl,
    port,
    proc,
    kill: async () => {
      proc.kill('SIGTERM');
      await new Promise((r) => setTimeout(r, 500));
      if (proc.exitCode === null) proc.kill('SIGKILL');
    },
  };
}

export async function rpc(rpcUrl: string, method: string, params: unknown[] = []): Promise<unknown> {
  const res = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const body = (await res.json()) as { result?: unknown; error?: { message: string } };
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}
