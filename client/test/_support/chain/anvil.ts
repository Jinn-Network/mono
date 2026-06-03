import { spawn, type ChildProcess } from 'node:child_process';
import type { Address, Chain, Hex, WalletClient } from 'viem';
import { createWalletClient, http, numberToHex } from 'viem';
import { base } from 'viem/chains';
import type { ChainTestHarness } from './interface.js';
import { allocateAnvilPort } from './port-allocator.js';

export interface SpawnAnvilOpts {
  /** Fork source (default: BASE_RPC_URL env → mainnet.base.org). */
  forkUrl?: string;
  /** Pin fork at a specific block; defaults to tip. */
  forkBlock?: number;
  /** Suppress anvil stdout. Default: true. */
  silent?: boolean;
  /** How long to wait for anvil readiness, ms. Default: 15_000. */
  readyTimeoutMs?: number;
  /** Chain definition for the spawned wallet client (default: viem `base`). */
  chain?: Chain;
}

export interface SpawnAnvilFromStateOpts {
  /**
   * Path to the committed `anvil --dump-state` snapshot to load. May be the
   * state.json file itself or the directory containing it — anvil accepts
   * either via `--load-state`.
   */
  statePath: string;
  /** Suppress anvil stdout. Default: true. */
  silent?: boolean;
  /** How long to wait for anvil readiness, ms. Default: 15_000. */
  readyTimeoutMs?: number;
  /** Chain definition for the spawned wallet client (default: viem `base`). */
  chain?: Chain;
}

export interface AnvilHarness extends ChainTestHarness {
  port: number;
  pid: number;
}

/**
 * Shared anvil spawner. Replaces the copy-pasted `jsonRpc`, `spawn(anvilPath, …)`,
 * and hand-coded port constants duplicated across 6 legacy e2e scripts.
 */
export async function spawnAnvilFork(opts: SpawnAnvilOpts = {}): Promise<AnvilHarness> {
  const forkUrl = opts.forkUrl ?? process.env['BASE_RPC_URL'] ?? 'https://mainnet.base.org';
  const silent = opts.silent ?? true;
  const readyTimeoutMs = opts.readyTimeoutMs ?? 15_000;
  const chain = opts.chain ?? base;

  const args = ['--fork-url', forkUrl];
  if (silent) args.push('--silent');
  if (opts.forkBlock !== undefined) args.push('--fork-block-number', String(opts.forkBlock));

  return startAnvil({ extraArgs: args, silent, readyTimeoutMs, chain });
}

/**
 * Spawn anvil from a committed `--dump-state` snapshot (deterministic, no live
 * RPC). This is the hermetic-gate path (spec §4): the snapshot is built offline
 * by `contracts/scripts/build-anvil-snapshot.ts` and loaded here off local disk
 * so the per-PR gate cannot flake for infra reasons.
 *
 * Returns the same `AnvilHarness` shape as `spawnAnvilFork` (same port
 * allocation, readiness polling, and teardown) so callers are interchangeable.
 */
export async function spawnAnvilFromState(opts: SpawnAnvilFromStateOpts): Promise<AnvilHarness> {
  const silent = opts.silent ?? true;
  const readyTimeoutMs = opts.readyTimeoutMs ?? 15_000;
  const chain = opts.chain ?? base;

  // `--load-state` (with no `--fork-url`) resets the chain id to anvil's default
  // (31337). The snapshot is a Base fork, and chain-id-keyed lookups — notably
  // the Safe SDK's multiSend/proxyFactory resolution used by FleetBootstrapper —
  // must see the real chain id or fail with "Invalid multiSend contract address".
  // Pin it to the snapshot's chain so the loaded state is faithful.
  const args = ['--load-state', opts.statePath, '--chain-id', String(chain.id)];
  if (silent) args.push('--silent');

  return startAnvil({ extraArgs: args, silent, readyTimeoutMs, chain });
}

/**
 * Internal: allocate a port, spawn anvil with `--port <port> <extraArgs>`, race
 * readiness against early exit, and assemble the AnvilHarness. Shared by
 * `spawnAnvilFork` (fork mode) and `spawnAnvilFromState` (load-state mode).
 */
async function startAnvil(params: {
  extraArgs: string[];
  silent: boolean;
  readyTimeoutMs: number;
  chain: Chain;
}): Promise<AnvilHarness> {
  const { extraArgs, silent, readyTimeoutMs, chain } = params;
  const port = await allocateAnvilPort();
  const rpcUrl = `http://127.0.0.1:${port}`;

  const args = [...extraArgs, '--port', String(port)];

  // Even in silent mode, PIPE stderr (not 'ignore') so a crash-on-startup —
  // e.g. anvil rejecting a `--load-state` fixture whose dump-state schema was
  // written by a different anvil version — surfaces its real reason instead of
  // an opaque `code=2`. stdout stays suppressed (the banner is noise); stderr
  // is buffered and folded into the early-exit error below.
  const child: ChildProcess = spawn('anvil', args, {
    stdio: silent ? ['ignore', 'ignore', 'pipe'] : 'inherit',
    detached: false,
  });

  let stderrTail = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    // Keep only the last ~2KB so a chatty process can't grow this unbounded.
    stderrTail = (stderrTail + chunk.toString()).slice(-2048);
  });

  // Race readiness against early process exit. Without the exit watcher, a
  // crashing anvil (missing binary, bad fork url, missing snapshot) burns the
  // full timeout.
  const exitPromise = new Promise<never>((_, reject) => {
    child.once('error', (err) => reject(new Error(`anvil failed to spawn: ${err.message}`)));
    child.once('exit', (code, signal) => {
      const detail = stderrTail.trim() ? `: ${stderrTail.trim()}` : '';
      reject(new Error(`anvil exited before becoming ready (code=${code}, signal=${signal})${detail}`));
    });
  });
  const readyPromise = (async () => {
    const deadline = Date.now() + readyTimeoutMs;
    while (Date.now() < deadline) {
      try {
        await jsonRpc(rpcUrl, 'eth_chainId', []);
        return;
      } catch { await sleep(100); }
    }
    throw new Error(`anvil did not become ready within ${readyTimeoutMs}ms on port ${port}`);
  })();
  try {
    await Promise.race([readyPromise, exitPromise]);
  } catch (err) {
    if (!child.killed) child.kill('SIGKILL');
    throw err;
  }

  const harness: AnvilHarness = {
    rpcUrl,
    port,
    pid: child.pid ?? -1,

    async impersonate(addr, fn) {
      await jsonRpc(rpcUrl, 'anvil_impersonateAccount', [addr]);
      try {
        const client = createWalletClient({
          account: addr,
          chain,
          transport: http(rpcUrl),
        }) as WalletClient;
        return await fn(client);
      } finally {
        await jsonRpc(rpcUrl, 'anvil_stopImpersonatingAccount', [addr]);
      }
    },

    async setBalance(addr, wei) {
      await jsonRpc(rpcUrl, 'anvil_setBalance', [addr, numberToHex(wei)]);
    },

    async setStorageSlot(contract, slot, value) {
      await jsonRpc(rpcUrl, 'anvil_setStorageAt', [contract, slot, value]);
    },

    async mineBlocks(n) {
      await jsonRpc(rpcUrl, 'anvil_mine', [numberToHex(BigInt(n))]);
    },

    async now() {
      const head = (await jsonRpc(rpcUrl, 'eth_getBlockByNumber', ['latest', false])) as {
        timestamp: Hex;
      };
      return Number(BigInt(head.timestamp));
    },

    async advanceTime(seconds) {
      await jsonRpc(rpcUrl, 'evm_increaseTime', [seconds]);
      await jsonRpc(rpcUrl, 'anvil_mine', ['0x1']);
    },

    async teardown() {
      if (child.killed) return;
      child.kill('SIGKILL');
    },
  };

  return harness;
}

/** Raw JSON-RPC POST; exported only for tests that need to call unsupported methods. */
export async function jsonRpc(url: string, method: string, params: unknown[] = []): Promise<unknown> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method, params, id: 1 }),
  });
  const body = (await res.json()) as { result?: unknown; error?: { message: string } };
  if (body.error) throw new Error(`RPC error (${method}): ${body.error.message}`);
  return body.result;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
