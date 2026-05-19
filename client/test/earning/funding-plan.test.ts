import { mkdtemp, rm, readdir } from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { planFleetFunding } from '../../src/earning/funding-plan.js';
import { FleetStateStore } from '../../src/earning/store.js';
import { encryptMnemonic, generateMnemonic, deriveMasterAddress } from '../../src/earning/wallet.js';
import { createDefaultFleetState } from '../../src/earning/types.js';

const ZERO = '0x0000000000000000000000000000000000000000';

describe('planFleetFunding (read-only funding plan)', () => {
  const dirs: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  function fakeChainConfig(): any {
    return {
      chainId: 8453,
      rpcUrl: 'http://127.0.0.1:8545',
      minEoaGasEth: 5_000_000_000_000_000n,
      minSafeEth: 2_000_000_000_000_000n,
    };
  }

  it('returns partial=true with no_keystore when nothing has been initialised', async () => {
    const earningDir = await mkdtemp(path.join(os.tmpdir(), 'jinn-plan-'));
    dirs.push(earningDir);

    const plan = await planFleetFunding({
      earningDir,
      chain: 'base',
      chainConfigResolver: () => fakeChainConfig(),
      publicClientFactory: () => ({ getBalance: vi.fn() }) as any,
    });

    expect(plan.partial).toBe(true);
    expect(plan.reasons).toContain('no_keystore');
    expect(plan.reasons).toContain('fleet_state_missing');
    expect(plan.satisfied).toBe(false);
    expect(plan.master).toBeUndefined();
    expect(plan.safes).toEqual([]);
  });

  it('does NOT create a fleet state file when invoked on a fresh directory', async () => {
    // This is the read-only contract: planning must not touch disk except for reads.
    const earningDir = await mkdtemp(path.join(os.tmpdir(), 'jinn-plan-'));
    dirs.push(earningDir);

    await planFleetFunding({
      earningDir,
      chain: 'base',
      chainConfigResolver: () => fakeChainConfig(),
      publicClientFactory: () => ({ getBalance: vi.fn() }) as any,
    });

    const filesAfter = await readdir(earningDir);
    expect(filesAfter).toEqual([]);
  });

  it('reports password_missing when a keystore exists but no password is given', async () => {
    const earningDir = await mkdtemp(path.join(os.tmpdir(), 'jinn-plan-'));
    dirs.push(earningDir);
    const store = new FleetStateStore(earningDir);
    const mnemonic = generateMnemonic();
    await store.saveMnemonicKeystore(await encryptMnemonic(mnemonic, 'pw'));

    const plan = await planFleetFunding({
      earningDir,
      chain: 'base',
      chainConfigResolver: () => fakeChainConfig(),
      publicClientFactory: () => ({ getBalance: vi.fn() }) as any,
    });

    expect(plan.partial).toBe(true);
    expect(plan.reasons).toContain('password_missing');
    expect(plan.master).toBeUndefined();
  });

  it('reports password_invalid for a wrong keystore password', async () => {
    const earningDir = await mkdtemp(path.join(os.tmpdir(), 'jinn-plan-'));
    dirs.push(earningDir);
    const store = new FleetStateStore(earningDir);
    const mnemonic = generateMnemonic();
    await store.saveMnemonicKeystore(await encryptMnemonic(mnemonic, 'pw'));

    const plan = await planFleetFunding({
      earningDir,
      chain: 'base',
      password: 'wrong',
      chainConfigResolver: () => fakeChainConfig(),
      publicClientFactory: () => ({ getBalance: vi.fn() }) as any,
    });

    expect(plan.partial).toBe(true);
    expect(plan.reasons).toContain('password_invalid');
    expect(plan.master).toBeUndefined();
  });

  it('reports rpc_unreachable when getBalance throws and never crashes', async () => {
    const earningDir = await mkdtemp(path.join(os.tmpdir(), 'jinn-plan-'));
    dirs.push(earningDir);
    const store = new FleetStateStore(earningDir);
    const mnemonic = generateMnemonic();
    await store.saveMnemonicKeystore(await encryptMnemonic(mnemonic, 'pw'));

    const getBalance = vi.fn(async () => { throw new Error('connect ECONNREFUSED'); });
    const plan = await planFleetFunding({
      earningDir,
      chain: 'base',
      password: 'pw',
      chainConfigResolver: () => fakeChainConfig(),
      publicClientFactory: () => ({ getBalance }) as any,
    });

    expect(plan.partial).toBe(true);
    expect(plan.reasons).toContain('rpc_unreachable');
  });

  it('returns satisfied=true when master holds enough ETH and no completed services', async () => {
    const earningDir = await mkdtemp(path.join(os.tmpdir(), 'jinn-plan-'));
    dirs.push(earningDir);
    const store = new FleetStateStore(earningDir);
    const mnemonic = generateMnemonic();
    const masterAddress = deriveMasterAddress(mnemonic);
    await store.saveMnemonicKeystore(await encryptMnemonic(mnemonic, 'pw'));
    await store.save({ ...createDefaultFleetState('base'), master_address: masterAddress });

    // Pre-Stage-1 (fleet_stage === 'none') the gate is the FULL bootstrap
    // budget: STAGE1_AGENT_ETH (0.010) + minEoaGasEth*2 (0.010) = 0.020 ETH
    // for N=1 (jinn-mono-u34i one-shot funding). Operator funds once; the
    // daemon does not re-prompt at the Stage 2 gate.
    const getBalance = vi.fn(async () => 20_000_000_000_000_000n); // 0.020 ETH
    const plan = await planFleetFunding({
      earningDir,
      chain: 'base',
      password: 'pw',
      chainConfigResolver: () => fakeChainConfig(),
      publicClientFactory: () => ({ getBalance }) as any,
    });

    expect(plan.satisfied).toBe(true);
    expect(plan.partial).toBe(false);
    expect(plan.master).toBeUndefined();
    expect(plan.safes).toEqual([]);
  });

  it('reports a master shortfall when master holds less than minEoaGasEth', async () => {
    const earningDir = await mkdtemp(path.join(os.tmpdir(), 'jinn-plan-'));
    dirs.push(earningDir);
    const store = new FleetStateStore(earningDir);
    const mnemonic = generateMnemonic();
    const masterAddress = deriveMasterAddress(mnemonic);
    await store.saveMnemonicKeystore(await encryptMnemonic(mnemonic, 'pw'));
    await store.save({ ...createDefaultFleetState('base'), master_address: masterAddress });

    const getBalance = vi.fn(async () => 1_000_000_000_000_000n); // 0.001 ETH < 0.020
    const plan = await planFleetFunding({
      earningDir,
      chain: 'base',
      password: 'pw',
      chainConfigResolver: () => fakeChainConfig(),
      publicClientFactory: () => ({ getBalance }) as any,
    });

    expect(plan.satisfied).toBe(false);
    expect(plan.partial).toBe(false);
    expect(plan.master?.master_address).toBe(masterAddress);
    expect(plan.master?.eth_balance).toBe('1000000000000000');
    // Pre-Stage-1 gate is the FULL bootstrap budget: STAGE1_AGENT_ETH (0.010)
    // + minEoaGasEth*2 (0.010) = 0.020 ETH for N=1 (jinn-mono-u34i one-shot
    // funding). shortfall = 0.020 - 0.001 = 0.019 ETH.
    expect(plan.master?.eth_required).toBe('19000000000000000');
  });

  it('does not call any mutating method on the fleet store', async () => {
    // The audit (W1) requires that planning never advances the bootstrap
    // state machine. We assert this directly: build a store, hand it to
    // the planner, and verify only read-only methods are invoked.
    const earningDir = await mkdtemp(path.join(os.tmpdir(), 'jinn-plan-'));
    dirs.push(earningDir);
    const realStore = new FleetStateStore(earningDir);
    const mnemonic = generateMnemonic();
    const masterAddress = deriveMasterAddress(mnemonic);
    await realStore.saveMnemonicKeystore(await encryptMnemonic(mnemonic, 'pw'));
    await realStore.save({ ...createDefaultFleetState('base'), master_address: masterAddress });

    // Wrap the store; throw on any mutator.
    const mutatorCalls: string[] = [];
    const wrappedStore: FleetStateStore = new Proxy(realStore, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        const mutators = new Set([
          'save',
          'patchFleet',
          'updateService',
          'addService',
          'removeService',
          'saveMnemonicKeystore',
          'migrateLegacyFiles',
        ]);
        if (typeof prop === 'string' && mutators.has(prop) && typeof value === 'function') {
          return (...args: unknown[]) => {
            mutatorCalls.push(prop);
            return (value as (...a: unknown[]) => unknown).apply(target, args);
          };
        }
        return value;
      },
    });

    const getBalance = vi.fn(async () => 10_000_000_000_000_000n);
    await planFleetFunding({
      earningDir,
      chain: 'base',
      password: 'pw',
      chainConfigResolver: () => fakeChainConfig(),
      storeFactory: () => wrappedStore,
      publicClientFactory: () => ({ getBalance }) as any,
    });

    expect(mutatorCalls).toEqual([]);
  });
});
