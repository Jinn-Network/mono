/**
 * Acceptance-tier Anvil spawn helper.
 *
 * Exposes `startAnvil()` which:
 *   - Allocates an ephemeral port via `node:net`
 *   - Spawns `anvil --port <port> --silent --chain-id 31337 --accounts 5 --balance 100`
 *   - Waits for the RPC to respond to `eth_chainId`
 *   - Returns { rpcUrl, chainId, accounts, stop }
 *
 * Uses the well-known Foundry deterministic accounts (private keys from
 * `anvil --mnemonic "test test test test test test test test test test test junk"`)
 * so tests can fund the builder EOA without parsing anvil stdout.
 *
 * Fails fast with a clear error if `anvil` is not in PATH.
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';

export interface AnvilAccount {
  address: `0x${string}`;
  privateKey: `0x${string}`;
}

export interface AnvilHandle {
  rpcUrl: string;
  chainId: number;
  accounts: AnvilAccount[];
  stop: () => Promise<void>;
}

/**
 * Well-known Foundry deterministic accounts (mnemonic: "test test test test
 * test test test test test test test junk"). The first 5 accounts.
 */
export const FOUNDRY_ACCOUNTS: AnvilAccount[] = [
  {
    address: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
    privateKey: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  },
  {
    address: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
    privateKey: '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  },
  {
    address: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC',
    privateKey: '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
  },
  {
    address: '0x90F79bf6EB2c4f870365E785982E1f101E93b906',
    privateKey: '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6',
  },
  {
    address: '0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65',
    privateKey: '0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a',
  },
];

function allocatePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (!addr || typeof addr === 'string') {
        srv.close();
        reject(new Error('could not resolve allocated port'));
        return;
      }
      const port = addr.port;
      srv.close(() => resolve(port));
    });
  });
}

async function rpcCall(url: string, method: string, params: unknown[] = []): Promise<unknown> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method, params, id: 1 }),
  });
  const body = (await res.json()) as { result?: unknown; error?: { message: string } };
  if (body.error) throw new Error(`RPC error (${method}): ${body.error.message}`);
  return body.result;
}

/**
 * Start a fresh Anvil instance on an ephemeral port.
 *
 * @throws if `anvil` is not in PATH — fails loud with a clear error.
 */
export async function startAnvil(): Promise<AnvilHandle> {
  // Fail loud if anvil is not in PATH.
  const check = spawnSync('anvil', ['--version'], { stdio: 'ignore' });
  if (check.status !== 0 || check.error) {
    throw new Error(
      [
        'anvil not found in PATH — the acceptance-tier tests require Foundry.',
        'Install via: curl -L https://foundry.paradigm.xyz | bash && foundryup',
      ].join('\n'),
    );
  }

  const port = await allocatePort();
  const rpcUrl = `http://127.0.0.1:${port}`;
  const chainId = 31337;

  const child: ChildProcess = spawn(
    'anvil',
    [
      '--port', String(port),
      '--silent',
      '--chain-id', String(chainId),
      '--accounts', '5',
      '--balance', '100',
    ],
    { stdio: 'ignore', detached: false },
  );

  const exitPromise = new Promise<never>((_, reject) => {
    child.once('error', (err) =>
      reject(new Error(`anvil failed to spawn: ${err.message}`)),
    );
    child.once('exit', (code, signal) =>
      reject(
        new Error(`anvil exited before becoming ready (code=${code}, signal=${signal})`),
      ),
    );
  });

  const readyPromise = (async () => {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      try {
        await rpcCall(rpcUrl, 'eth_chainId', []);
        return;
      } catch {
        await new Promise<void>((r) => setTimeout(r, 100));
      }
    }
    throw new Error(`anvil did not become ready within 15 s on port ${port}`);
  })();

  try {
    await Promise.race([readyPromise, exitPromise]);
  } catch (err) {
    if (!child.killed) child.kill('SIGKILL');
    throw err;
  }

  return {
    rpcUrl,
    chainId,
    accounts: FOUNDRY_ACCOUNTS,
    stop: async () => {
      if (!child.killed) child.kill('SIGKILL');
      // Give the OS a moment to release the port.
      await new Promise<void>((r) => setTimeout(r, 50));
    },
  };
}
