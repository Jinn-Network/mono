/**
 * #4826 — the #592 fallback chain never reached the fleet bootstrap. Every
 * caller handed it `config.rpcUrl`, the head of the resolved chain, so a dead
 * head slot failed the whole bootstrap even when the operator had configured
 * four live providers behind it.
 *
 * This file proves the WIRING, not the transport. The fallback logic itself is
 * already owned by `test/hermetic/rpc-fallback.test.ts` and
 * `test/rpc/transport.test.ts`; duplicating their assertions here is the
 * failure mode to avoid. Hermetic, and with no internal-module mocks: the dead
 * slot is an unbound loopback port (ECONNREFUSED, and `buildFallbackTransport`
 * pins `retryCount: 0` so the fall-through is immediate), the live slot is the
 * in-process JSON-RPC boundary fake.
 */
import { mkdtemp, rm } from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { getAddress } from 'viem';
import { FleetBootstrapper } from '../../src/earning/bootstrap.js';
import { allocateAnvilPort } from '../_support/chain/port-allocator.js';
import { startFakeRpc, type FakeRpc } from '../_support/chain/fake-rpc.js';

const PROBE = getAddress('0x1111111111111111111111111111111111111111');

describe('FleetBootstrapper RPC fallback chain wiring', () => {
  const dirs: string[] = [];
  const servers: FakeRpc[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => s.close()));
    await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  async function earningDir(): Promise<string> {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'jinn-rpc-chain-'));
    dirs.push(dir);
    return dir;
  }

  async function deadUrl(): Promise<string> {
    return `http://127.0.0.1:${await allocateAnvilPort()}`;
  }

  async function live(): Promise<FakeRpc> {
    const fake = await startFakeRpc();
    servers.push(fake);
    return fake;
  }

  it('falls through to a live slot when the head slot is dead', async () => {
    const fake = await live();
    const bs = new FleetBootstrapper({
      earningDir: await earningDir(),
      chain: 'base-sepolia',
      rpcUrl: [await deadUrl(), fake.url],
      stakingMode: 'standard',
    });

    await expect((bs as any).publicClient.getBalance({ address: PROBE }))
      .resolves.toBe(0n);
    expect(fake.methods).toContain('eth_getBalance');
  }, 30_000);

  it('accepts a single URL string', async () => {
    const fake = await live();
    const bs = new FleetBootstrapper({
      earningDir: await earningDir(),
      chain: 'base-sepolia',
      rpcUrl: fake.url,
      stakingMode: 'standard',
    });

    // A one-slot chain is still a fallback transport — `buildFallbackTransport`
    // always wraps — and the head is unchanged for every existing caller.
    expect((bs as any).publicClient.transport.type).toBe('fallback');
    expect((bs as any).config.rpcUrl).toBe(fake.url);
  }, 30_000);

  it('keeps the head a plain string for the Safe SDK', async () => {
    const fake = await live();
    const urls = [fake.url, 'https://base-sepolia.publicnode.com'];
    const bs = new FleetBootstrapper({
      earningDir: await earningDir(),
      chain: 'base-sepolia',
      rpcUrl: urls,
      stakingMode: 'standard',
    });

    // `initPredictedSafe` / `executeSafeTxDirect` / `rpcHostForDisplay` all
    // declare `rpcUrl: string` and hand it to protocol-kit's single-provider
    // `init({ provider })`, so the head must stay scalar.
    expect(typeof (bs as any).config.rpcUrl).toBe('string');
    expect((bs as any).config.rpcUrl).toBe(urls[0]);
  }, 30_000);

  it('preserves slot order', async () => {
    const first = await live();
    const second = await live();
    const bs = new FleetBootstrapper({
      earningDir: await earningDir(),
      chain: 'base-sepolia',
      rpcUrl: [first.url, second.url],
      stakingMode: 'standard',
    });

    await (bs as any).publicClient.getBalance({ address: PROBE });

    // `rank: false` — the #592 "Tenderly stays in slot 3" constraint.
    expect(first.methods).toContain('eth_getBalance');
    expect(second.methods).toEqual([]);
  }, 30_000);
});
