import { spawn, type ChildProcess } from 'node:child_process';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';

export interface AnvilForkHandle {
  rpcUrl: string;
  port: number;
  stop: () => Promise<void>;
}

async function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

async function waitForRpc(rpcUrl: string, timeoutMs = 10000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }),
      });
      if (res.ok) return;
    } catch {
      // not yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`anvil at ${rpcUrl} did not become reachable within ${timeoutMs}ms`);
}

export async function spawnAnvilFork(opts: { forkUrl?: string; forkBlock?: number } = {}): Promise<AnvilForkHandle> {
  const port = await pickFreePort();
  const args = ['--port', port.toString(), '--silent'];
  if (opts.forkUrl) {
    args.push('--fork-url', opts.forkUrl);
    if (opts.forkBlock !== undefined) {
      args.push('--fork-block-number', opts.forkBlock.toString());
    }
  }
  const foundryBin = path.join(os.homedir(), '.foundry', 'bin');
  const child: ChildProcess = spawn('anvil', args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      PATH: `${process.env.PATH ?? ''}:${foundryBin}`,
    },
  });
  const rpcUrl = `http://127.0.0.1:${port}`;
  try {
    await waitForRpc(rpcUrl);
  } catch (err) {
    child.kill('SIGTERM');
    throw err;
  }
  return {
    rpcUrl,
    port,
    stop: async () => {
      child.kill('SIGTERM');
      await new Promise((r) => setTimeout(r, 100));
      if (!child.killed) child.kill('SIGKILL');
    },
  };
}
