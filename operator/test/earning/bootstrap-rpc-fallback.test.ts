/**
 * Regression coverage for issue #4826: the #592 RPC fallback chain never
 * reached the fleet bootstrap. `FleetBootstrapper` collapsed its option down
 * to a single head URL and built every viem client from it, so a dead slot-0
 * provider failed the whole bootstrap even when the operator had configured
 * four healthy backups.
 *
 * The AC4 cases are hermetic and loopback-only. The dead slot is a socket we
 * hold open and hang up on immediately, NOT a closed port: a port that
 * `allocateAnvilPort()` released is re-allocatable, so a racing worker that
 * bound it would quietly turn the "dead" slot live and flip these assertions.
 * Owning the socket makes the failure a deterministic hangup that viem's
 * fallback treats as a transport error, and no other allocator can steal it.
 * The live tail is a minimal JSON-RPC stub.
 */

import { createServer, type Server } from 'node:http';
import { createServer as createTcpServer, type Server as TcpServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FleetBootstrapper } from '../../src/earning/bootstrap.js';
import { chainRpcUrls } from '../../src/earning/contracts.js';
import { createJinnWalletClient } from '../../src/earning/viem-clients.js';
import { executeSafeTxDirect } from '../../src/earning/safe-adapter.js';
import { PRODUCTION_DEPS as SOLVER_PLUGINS_DEPS } from '../../src/cli/commands/solver-plugins.js';
import { allocateAnvilPort } from '../_support/chain/port-allocator.js';
import { privateKeyToAccount } from 'viem/accounts';

const BASE_SEPOLIA_CHAIN_ID_HEX = '0x14a34';
const STUB_BALANCE_WEI = 1_234_000_000_000_000_000n;
const PROBE_ADDRESS = `0x${'ab'.repeat(20)}` as const;

/** Minimal JSON-RPC responder for the two methods `getBalance` needs. */
async function startRpcStub(): Promise<{ url: string; hits: () => number; close: () => Promise<void> }> {
  const port = await allocateAnvilPort();
  let hits = 0;
  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      hits += 1;
      const request = JSON.parse(body) as { id: number; method: string };
      const result =
        request.method === 'eth_chainId'
          ? BASE_SEPOLIA_CHAIN_ID_HEX
          : `0x${STUB_BALANCE_WEI.toString(16)}`;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }));
    });
  });
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${port}`,
    hits: () => hits,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/**
 * A slot that is reachable but never answers: it accepts the connection and
 * destroys it. Deterministically dead, and it owns its port for the lifetime
 * of the test so nothing else can bind it.
 */
async function startDeadEndpoint(): Promise<{ url: string; close: () => Promise<void> }> {
  const port = await allocateAnvilPort();
  const server: TcpServer = createTcpServer((socket) => socket.destroy());
  server.on('error', () => {});
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe('FleetBootstrapper RPC fallback chain (#4826)', () => {
  const dirs: string[] = [];
  const closers: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await Promise.all(closers.splice(0).map((close) => close()));
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function earningDir(): Promise<string> {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'jinn-rpc-fallback-'));
    dirs.push(dir);
    return dir;
  }

  it('fails over to a healthy tail slot when the head provider is dead', async () => {
    const stub = await startRpcStub();
    closers.push(stub.close);
    const dead = await startDeadEndpoint();
    closers.push(dead.close);

    const bootstrapper = new FleetBootstrapper({
      earningDir: await earningDir(),
      chain: 'base-sepolia',
      rpcUrl: [dead.url, stub.url],
    });

    const balance = await (bootstrapper as any).publicClient.getBalance({ address: PROBE_ADDRESS });

    expect(balance).toBe(STUB_BALANCE_WEI);
    expect(stub.hits()).toBeGreaterThan(0);
  });

  it('fails over on the wallet path the bootstrap steps build from', async () => {
    // Shape check on the chain config the extracted `steps/*` read: they build
    // their wallet clients from `chainRpcUrls(ctx.config)`, which used to be a
    // head URL alone. This asserts the list is usable, not that a step ran.
    const stub = await startRpcStub();
    closers.push(stub.close);
    const dead = await startDeadEndpoint();
    closers.push(dead.close);

    const bootstrapper = new FleetBootstrapper({
      earningDir: await earningDir(),
      chain: 'base-sepolia',
      rpcUrl: [dead.url, stub.url],
    });
    const wallet = createJinnWalletClient(
      chainRpcUrls((bootstrapper as any).config),
      'base-sepolia',
      privateKeyToAccount(`0x${'11'.repeat(32)}`),
    );

    await expect(wallet.getChainId()).resolves.toBe(84532);
    expect(stub.hits()).toBeGreaterThan(0);
  });

  it('negative control: a dead head with no tail slot still fails', async () => {
    const dead = await startDeadEndpoint();
    closers.push(dead.close);

    const bootstrapper = new FleetBootstrapper({
      earningDir: await earningDir(),
      chain: 'base-sepolia',
      rpcUrl: dead.url,
    });

    await expect(
      (bootstrapper as any).publicClient.getBalance({ address: PROBE_ADDRESS }),
    ).rejects.toThrow();
  });

  it('carries the whole provider list onto the chain config, in slot order', async () => {
    const bootstrapper = new FleetBootstrapper({
      earningDir: await earningDir(),
      chain: 'base-sepolia',
      rpcUrl: ['https://a.example', 'https://b.example'],
    });
    const config = (bootstrapper as any).config;

    expect(chainRpcUrls(config)).toEqual(['https://a.example', 'https://b.example']);
    expect(config.rpcUrl).toBe(chainRpcUrls(config)[0]);
  });

  it('still accepts a single-string rpcUrl (back-compat)', async () => {
    const bootstrapper = new FleetBootstrapper({
      earningDir: await earningDir(),
      chain: 'base-sepolia',
      rpcUrl: 'http://127.0.0.1:8545',
    });
    const config = (bootstrapper as any).config;

    expect(chainRpcUrls(config)).toEqual(['http://127.0.0.1:8545']);
    expect(config.rpcUrl).toBe(chainRpcUrls(config)[0]);
  });

  it('splits a comma-separated rpcUrl and names slot 0 as the head', async () => {
    const bootstrapper = new FleetBootstrapper({
      earningDir: await earningDir(),
      chain: 'base-sepolia',
      rpcUrl: 'https://a.example,https://b.example',
    });
    const config = (bootstrapper as any).config;

    expect(chainRpcUrls(config)).toEqual(['https://a.example', 'https://b.example']);
    expect(config.rpcUrl).toBe('https://a.example');
  });

  it('falls back to the chain default when rpcUrl is empty rather than throwing', async () => {
    const bootstrapper = new FleetBootstrapper({
      earningDir: await earningDir(),
      chain: 'base-sepolia',
      rpcUrl: '',
    });
    const config = (bootstrapper as any).config;

    expect(chainRpcUrls(config)).toEqual(['https://base-sepolia-rpc.publicnode.com']);
  });

  it('refuses a supplied-but-empty provider list instead of seating one default', async () => {
    // Pre-fix this fell through to the single static chain default, which is
    // how a caller that resolved an empty chain would have shipped as "one
    // provider, no fallback" with no signal at all.
    await expect(
      (async () =>
        new FleetBootstrapper({
          earningDir: await earningDir(),
          chain: 'base-sepolia',
          rpcUrl: [],
        }))(),
    ).rejects.toThrow(/at least one RPC URL/i);
  });

  it('call site: the CLI bootstrapper factory forwards the whole chain, not the head', async () => {
    // The defect was never inside FleetBootstrapper — the factories passed
    // `config.rpcUrl`. Reverting any of them to the head string turns this red.
    const bootstrapper = SOLVER_PLUGINS_DEPS.bootstrapperFactory({
      earningDir: await earningDir(),
      network: 'testnet',
      rpcUrl: 'https://a.example',
      rpcUrls: ['https://a.example', 'https://b.example'],
      stakingMode: 'standard',
    } as never);

    expect(chainRpcUrls((bootstrapper as any).config)).toEqual([
      'https://a.example',
      'https://b.example',
    ]);
  });
});

describe('executeSafeTxDirect RPC fallback chain (#4826)', () => {
  const closers: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await Promise.all(closers.splice(0).map((close) => close()));
  });

  it('reaches a healthy tail slot when the head provider is dead', async () => {
    // The Safe-execution path builds its own viem clients rather than using
    // the Safe SDK transport, and used to build them from a single URL. Its
    // very first call is a chain-id probe, so a dead slot 0 refused the whole
    // step (mech deploy, stake, orphan sweep) before anything else ran.
    //
    // The call still rejects — the stub answers eth_chainId and nothing else,
    // so there is no Safe to transact with — but WHERE it rejects is the
    // point: pre-fix the stub was never contacted at all.
    const stub = await startRpcStub();
    closers.push(stub.close);
    const dead = await startDeadEndpoint();
    closers.push(dead.close);

    await expect(
      executeSafeTxDirect({
        rpcUrl: [dead.url, stub.url],
        signerKey: `0x${'11'.repeat(32)}`,
        safeAddress: `0x${'cd'.repeat(20)}`,
        to: `0x${'ef'.repeat(20)}`,
        data: '0x',
      }),
    ).rejects.toThrow();

    expect(stub.hits()).toBeGreaterThan(0);
  });
});
