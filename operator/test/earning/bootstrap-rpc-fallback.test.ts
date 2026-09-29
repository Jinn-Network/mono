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
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getAddress } from 'viem';
import * as safeAdapter from '../../src/earning/safe-adapter.js';
import { FleetBootstrapper } from '../../src/earning/bootstrap.js';
import { runFleetBootstrap, SetupBootstrapHalted } from '../../src/earning/bootstrap-run.js';
import { FleetStateStore } from '../../src/earning/store.js';
import { createDefaultFleetState } from '../../src/earning/types.js';
import { deriveAgentAddress, deriveMasterAddress, generateMnemonic } from '../../src/earning/wallet.js';
import type { JinnConfig } from '../../src/config.js';
import { PRODUCTION_DEPS as SOLVER_PLUGINS_DEPS } from '../../src/cli/commands/solver-plugins.js';
import { allocateAnvilPort } from '../_support/chain/port-allocator.js';
import { startFakeRpc, type FakeRpc } from '../_support/chain/fake-rpc.js';

// MOCK_JUSTIFICATION: @safe-global/protocol-kit is a third-party SDK boundary
// reached through safe-adapter.js; stepDeployMech constructs it internally
// with no DI seam. Precedent: test/earning/bootstrap-mech-funding-fence.test.ts.
vi.mock('../../src/earning/safe-adapter.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/earning/safe-adapter.js')>();
  return { ...actual, initDeployedSafe: vi.fn(), executeSafeTxDirect: vi.fn() };
});

const PROBE = getAddress('0x1111111111111111111111111111111111111111');
const SAFE_ADDRESS = '0x2222222222222222222222222222222222222222';
const MECH_ADDRESS = '0x3333333333333333333333333333333333333333';
const CREATE_MECH_TOPIC =
  '0x46e1ca45c09520471c43e2e88eca33bb51803011cfd456933629dcc645ecacd6';

describe('FleetBootstrapper RPC fallback chain wiring', () => {
  const dirs: string[] = [];
  const servers: FakeRpc[] = [];

  afterEach(async () => {
    vi.clearAllMocks();
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

  it('funds and deploys through a live slot when the head slot is dead', async () => {
    // Drives a real step, so the master's funding send goes out through a
    // WALLET client and the balance reads through the public client — both
    // must be built from the chain, not the head.
    const dir = await earningDir();
    const mnemonic = generateMnemonic();
    const agentAddress = deriveAgentAddress(mnemonic, 1);
    const store = new FleetStateStore(dir);
    await store.save({
      ...createDefaultFleetState('base-sepolia'),
      master_address: deriveMasterAddress(mnemonic),
      services: [{
        index: 1,
        agent_address: agentAddress,
        safe_address: SAFE_ADDRESS,
        service_id: 42,
        mech_address: null,
        staking_address: '0x24e34E5037956a5Feca1AAAfaA30297084C228B8',
        step: 'staked',
        error: null,
        agent_id: null,
        agent_uri: null,
        identity_registry_address: null,
        agent_registered_tx: null,
        safe_bound_to_agent: false,
        error_revert_reason: null,
        error_short_message: null,
      }],
    });

    const fake = await live();
    // Unfunded before the transfer, funded (base-sepolia `minEoaGasEth`) after.
    let balanceCall = 0;
    fake.on('eth_getBalance', () => (balanceCall++ === 0 ? '0x0' : '0x11c37937e08000'));
    fake.on('eth_getTransactionReceipt', (params: unknown[]) => ({
      transactionHash: String(params[0]),
      transactionIndex: '0x0',
      blockHash: `0x${'11'.repeat(32)}`,
      blockNumber: '0x10',
      from: `0x${'00'.repeat(20)}`,
      to: `0x${'00'.repeat(20)}`,
      cumulativeGasUsed: '0x5208',
      gasUsed: '0x5208',
      contractAddress: null,
      logs: [{
        address: `0x${'00'.repeat(20)}`,
        topics: [CREATE_MECH_TOPIC, `0x${'0'.repeat(24)}${MECH_ADDRESS.slice(2)}`],
        data: '0x',
        blockNumber: '0x10',
        blockHash: `0x${'11'.repeat(32)}`,
        transactionHash: String(params[0]),
        transactionIndex: '0x0',
        logIndex: '0x0',
        removed: false,
      }],
      logsBloom: `0x${'00'.repeat(256)}`,
      status: '0x1',
      effectiveGasPrice: '0x3b9aca00',
      type: '0x2',
    }));
    vi.mocked(safeAdapter.executeSafeTxDirect).mockResolvedValue({
      hash: `0x${'cd'.repeat(32)}` as `0x${string}`,
    });

    const head = await deadUrl();
    const bs = new FleetBootstrapper({
      earningDir: dir,
      chain: 'base-sepolia',
      rpcUrl: [head, fake.url],
      stakingMode: 'standard',
    });

    const state = await store.load('base-sepolia');
    const updated = await (bs as any).stepDeployMech(state, mnemonic, 1);

    expect(updated.services[0].mech_address).toBe(MECH_ADDRESS);
    expect(fake.methods).toContain('eth_sendRawTransaction');
    // The Safe SDK takes exactly one provider, so it gets the scalar head.
    expect(vi.mocked(safeAdapter.executeSafeTxDirect).mock.calls[0]![0].rpcUrl).toBe(head);
  }, 30_000);

  it('runFleetBootstrap hands the bootstrapper the whole chain', async () => {
    // The #4826 defect lived in the callers, not the constructor: each one
    // passed `config.rpcUrl`. Go through a real caller. With a dead head, a
    // head-only bootstrapper cannot read the master balance at all; with the
    // chain it reaches the funding gate.
    const fake = await live();
    const dir = await earningDir();
    const head = await deadUrl();
    const previous = {
      noUi: process.env['JINN_NO_UI'],
      noDaemon: process.env['JINN_NO_DAEMON'],
      timeout: process.env['JINN_FUNDING_TIMEOUT_MS'],
    };
    // Keep failBootstrap throwing SetupBootstrapHalted instead of exiting,
    // and time the funding poll out on its first pass.
    delete process.env['JINN_NO_UI'];
    delete process.env['JINN_NO_DAEMON'];
    process.env['JINN_FUNDING_TIMEOUT_MS'] = '1';
    let caught: unknown;
    try {
      await runFleetBootstrap({
        config: {
          earningDir: dir,
          rpcUrl: head,
          rpcUrls: [head, fake.url],
          stakingMode: 'standard',
          targetServices: 1,
          debug: false,
          pollIntervalMs: 5000,
          runLegacyMigrations: false,
        } as unknown as JinnConfig,
        password: 'test-password',
        network: 'base-sepolia',
        emitProgress: () => {},
      });
    } catch (err) {
      caught = err;
    } finally {
      for (const [key, value] of [
        ['JINN_NO_UI', previous.noUi],
        ['JINN_NO_DAEMON', previous.noDaemon],
        ['JINN_FUNDING_TIMEOUT_MS', previous.timeout],
      ] as const) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    }

    expect(caught).toBeInstanceOf(SetupBootstrapHalted);
    expect((caught as SetupBootstrapHalted).envelope.code).toBe('funding_required');
    expect(fake.methods).toContain('eth_getBalance');
  }, 30_000);

  it('solver-plugins production wiring hands the bootstrapper the whole chain', async () => {
    const fake = await live();
    const head = await deadUrl();
    const bs = SOLVER_PLUGINS_DEPS.bootstrapperFactory({
      earningDir: await earningDir(),
      network: 'testnet',
      rpcUrl: head,
      rpcUrls: [head, fake.url],
      stakingMode: 'standard',
    } as unknown as JinnConfig);

    await expect((bs as any).publicClient.getBalance({ address: PROBE })).resolves.toBe(0n);
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
