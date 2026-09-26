/**
 * Regression coverage for issue #4826: the #592 RPC fallback chain never
 * reached the fleet bootstrap. `FleetBootstrapper` collapsed its option down
 * to a single head URL and built every viem client from it, so a dead slot-0
 * provider failed the whole bootstrap even when the operator had configured
 * four healthy backups.
 *
 * The AC4 cases are hermetic and loopback-only: the dead slot is a port
 * `allocateAnvilPort()` handed back after closing its probe socket (so the
 * connection is refused), and the live tail is a minimal JSON-RPC stub.
 */

import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FleetBootstrapper } from '../../src/earning/bootstrap.js';
import { chainRpcUrls } from '../../src/earning/contracts.js';
import { createJinnWalletClient } from '../../src/earning/viem-clients.js';
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
    const deadUrl = `http://127.0.0.1:${await allocateAnvilPort()}`;

    const bootstrapper = new FleetBootstrapper({
      earningDir: await earningDir(),
      chain: 'base-sepolia',
      rpcUrl: [deadUrl, stub.url],
    });

    const balance = await (bootstrapper as any).publicClient.getBalance({ address: PROBE_ADDRESS });

    expect(balance).toBe(STUB_BALANCE_WEI);
    expect(stub.hits()).toBeGreaterThan(0);
  });

  it('fails over on the wallet path the bootstrap steps build from', async () => {
    // The step/wallet clients are the seam that actually regressed: they read
    // the chain config, which used to carry the head URL alone.
    const stub = await startRpcStub();
    closers.push(stub.close);
    const deadUrl = `http://127.0.0.1:${await allocateAnvilPort()}`;

    const bootstrapper = new FleetBootstrapper({
      earningDir: await earningDir(),
      chain: 'base-sepolia',
      rpcUrl: [deadUrl, stub.url],
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
    const deadUrl = `http://127.0.0.1:${await allocateAnvilPort()}`;

    const bootstrapper = new FleetBootstrapper({
      earningDir: await earningDir(),
      chain: 'base-sepolia',
      rpcUrl: deadUrl,
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
});
