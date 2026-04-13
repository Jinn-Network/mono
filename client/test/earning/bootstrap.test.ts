import { mkdtemp, rm, writeFile, mkdir } from 'fs/promises';
import os from 'os';
import path from 'path';
import { getAddress } from 'ethers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FleetBootstrapper } from '../../src/earning/bootstrap.js';
import { FleetStateStore } from '../../src/earning/store.js';
import {
  generateMnemonic,
  encryptMnemonic,
  deriveMasterAddress,
  deriveAgentAddress,
} from '../../src/earning/wallet.js';
import { createDefaultFleetState } from '../../src/earning/types.js';

describe('Fleet bootstrap', () => {
  const dirs: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('generates mnemonic and pauses at funding on first run', async () => {
    const earningDir = await mkdtemp(path.join(os.tmpdir(), 'jinn-fleet-'));
    dirs.push(earningDir);

    const bootstrapper = new FleetBootstrapper({
      earningDir,
      chain: 'base',
      rpcUrl: 'http://127.0.0.1:8545',
      stakingMode: 'standard',
    });

    // Mock provider to return 0 balance
    vi.spyOn((bootstrapper as any).provider, 'getBalance').mockResolvedValue(0n);

    const result = await bootstrapper.bootstrap('test-password');

    expect(result.ok).toBe(false);
    expect(result.funding).toBeDefined();
    expect(result.message).toContain('Your master wallet needs more ETH');
    expect(result.message).toContain(result.funding!.master_address);
    expect(result.funding!.master_address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(result.funding!.eth_balance).toBe('0');

    // Verify mnemonic keystore was created
    const store = new FleetStateStore(earningDir);
    expect(store.hasMnemonicKeystore()).toBe(true);

    // Verify state has master address
    const state = await store.load();
    expect(state.master_address).toBe(result.funding!.master_address);
    expect(state.services).toEqual([]);
  });

  it('detects legacy keystore and migrates', async () => {
    const earningDir = await mkdtemp(path.join(os.tmpdir(), 'jinn-fleet-'));
    dirs.push(earningDir);

    // Create a fake legacy keystore
    await mkdir(earningDir, { recursive: true });
    await writeFile(path.join(earningDir, 'agent_keystore.json'), '{"fake":"legacy"}');

    const store = new FleetStateStore(earningDir);
    expect(store.hasLegacyKeystore()).toBe(true);

    const bootstrapper = new FleetBootstrapper({
      earningDir,
      chain: 'base',
      rpcUrl: 'http://127.0.0.1:8545',
    });

    vi.spyOn((bootstrapper as any).provider, 'getBalance').mockResolvedValue(0n);

    await bootstrapper.bootstrap('test-password');

    // Legacy file should be renamed
    expect(store.hasLegacyKeystore()).toBe(false);
    // New mnemonic keystore should exist
    expect(store.hasMnemonicKeystore()).toBe(true);
  });

  it('resumes from existing state without regenerating mnemonic', async () => {
    const earningDir = await mkdtemp(path.join(os.tmpdir(), 'jinn-fleet-'));
    dirs.push(earningDir);

    // Pre-create mnemonic keystore
    const mnemonic = generateMnemonic();
    const encrypted = await encryptMnemonic(mnemonic, 'test-password');
    const store = new FleetStateStore(earningDir);
    await store.saveMnemonicKeystore(encrypted);

    // Pre-create state with master address
    const masterAddr = deriveMasterAddress(mnemonic);
    await store.save({
      ...createDefaultFleetState('base'),
      master_address: masterAddr,
    });

    const bootstrapper = new FleetBootstrapper({
      earningDir,
      chain: 'base',
      rpcUrl: 'http://127.0.0.1:8545',
    });

    // Master is funded
    vi.spyOn((bootstrapper as any).provider, 'getBalance').mockResolvedValue(10_000_000_000_000_000n);

    // Mock the service bootstrap steps.
    // bootstrapService() adds a service with step='awaiting_stake' first, then calls resumeService().
    // stepStolasStake is called for services in 'awaiting_stake' step — update the existing service.
    vi.spyOn(bootstrapper as any, 'stepStolasStake').mockImplementation(async (_state: any, _m: any, index: number) => {
      return store.updateService(index, {
        agent_address: '0x0000000000000000000000000000000000000001',
        safe_address: '0x0000000000000000000000000000000000000002',
        service_id: 99,
        staking_address: '0x0000000000000000000000000000000000000003',
        step: 'staked',
      });
    });
    vi.spyOn(bootstrapper as any, 'stepDeployMech').mockImplementation(async (_s: any, _m: any, index: number) => {
      return store.updateService(index, { mech_address: '0x0000000000000000000000000000000000000004', step: 'complete' });
    });

    const result = await bootstrapper.bootstrap('test-password');

    expect(result.ok).toBe(true);
    expect(result.fleet_state.services).toHaveLength(1);
    expect(result.fleet_state.services[0].step).toBe('complete');
    expect(result.fleet_state.master_address).toBe(masterAddr);
  });

  it('creates multiple services when targetServices > 1', async () => {
    const earningDir = await mkdtemp(path.join(os.tmpdir(), 'jinn-fleet-'));
    dirs.push(earningDir);

    const mnemonic = generateMnemonic();
    const encrypted = await encryptMnemonic(mnemonic, 'test-password');
    const store = new FleetStateStore(earningDir);
    await store.saveMnemonicKeystore(encrypted);

    const masterAddr = deriveMasterAddress(mnemonic);
    await store.save({
      ...createDefaultFleetState('base'),
      master_address: masterAddr,
    });

    const bootstrapper = new FleetBootstrapper({
      earningDir,
      chain: 'base',
      rpcUrl: 'http://127.0.0.1:8545',
      targetServices: 3,
    });

    vi.spyOn((bootstrapper as any).provider, 'getBalance').mockResolvedValue(10_000_000_000_000_000n);

    let serviceCounter = 100;
    vi.spyOn(bootstrapper as any, 'stepStolasStake').mockImplementation(async (_s: any, _m: any, index: number) => {
      return store.updateService(index, {
        safe_address: `0x000000000000000000000000000000000000100${index}`,
        service_id: serviceCounter++,
        staking_address: '0x0000000000000000000000000000000000000003',
        step: 'staked',
      });
    });
    vi.spyOn(bootstrapper as any, 'stepDeployMech').mockImplementation(async (_s: any, _m: any, index: number) => {
      return store.updateService(index, { mech_address: `0x000000000000000000000000000000000000200${index}`, step: 'complete' });
    });

    const result = await bootstrapper.bootstrap('test-password');

    expect(result.ok).toBe(true);
    expect(result.fleet_state.services).toHaveLength(3);
    expect(result.fleet_state.services.every(s => s.step === 'complete')).toBe(true);
    // Services should have distinct indices 1, 2, 3
    expect(result.fleet_state.services.map(s => s.index)).toEqual([1, 2, 3]);
  });

  it('reconciles standard service unstaked on-chain before resume (mocked chain reads)', async () => {
    const earningDir = await mkdtemp(path.join(os.tmpdir(), 'jinn-fleet-'));
    dirs.push(earningDir);

    const mnemonic = generateMnemonic();
    const encrypted = await encryptMnemonic(mnemonic, 'test-password');
    const store = new FleetStateStore(earningDir);
    await store.saveMnemonicKeystore(encrypted);

    const masterAddr = deriveMasterAddress(mnemonic);
    const agentAddr = deriveAgentAddress(mnemonic, 1);
    await store.save({
      ...createDefaultFleetState('base'),
      master_address: masterAddr,
      services: [
        {
          index: 1,
          agent_address: agentAddr,
          safe_address: '0x2222222222222222222222222222222222222222',
          service_id: 42,
          mech_address: '0x3333333333333333333333333333333333333333',
          staking_address: '0x51c5f4982b9b0b3c0482678f5847ea6228cc8e54',
          step: 'complete',
          error: null,
        },
      ],
    });

    const bootstrapper = new FleetBootstrapper({
      earningDir,
      chain: 'base',
      rpcUrl: 'http://127.0.0.1:8545',
      stakingMode: 'standard',
    });

    vi.spyOn(bootstrapper as any, 'getStakingState').mockResolvedValue(1);

    const sweepSpy = vi
      .spyOn(bootstrapper as any, 'sweepAbandonedSafeForService')
      .mockResolvedValue(undefined);

    vi.spyOn(bootstrapper as any, 'gatherChainSignals').mockResolvedValue({
      stakingState: 0,
      stakingMultisig: null,
      registryState: 4,
      registryMultisig: '0x2222222222222222222222222222222222222222',
      safeDeployed: true,
    });
    vi.spyOn(bootstrapper as any, 'stepStolasStake').mockImplementation(async (_s: any, _m: any, index: number) => {
      return store.updateService(index, {
        safe_address: '0x2222222222222222222222222222222222222222',
        service_id: 100,
        staking_address: '0x51c5f4982b9b0b3c0482678f5847ea6228cc8e54',
        step: 'staked',
      });
    });
    vi.spyOn(bootstrapper as any, 'stepDeployMech').mockImplementation(async (_s: any, _m: any, index: number) => {
      return store.updateService(index, { mech_address: '0x4444444444444444444444444444444444444444', step: 'complete' });
    });

    vi.spyOn((bootstrapper as any).provider, 'getBalance').mockResolvedValue(10_000_000_000_000_000n);

    const result = await bootstrapper.bootstrap('test-password');
    expect(result.ok).toBe(true);
    const svc = result.fleet_state.services[0];
    expect(svc.step).toBe('complete');
    expect(svc.service_id).toBe(100);

    expect(sweepSpy).toHaveBeenCalledTimes(1);
    expect(sweepSpy).toHaveBeenCalledWith(
      expect.objectContaining({ master_address: masterAddr }),
      expect.any(String),
      1,
      getAddress('0x2222222222222222222222222222222222222222'),
    );
  });

  it('does not sweep abandoned Safe when standard service is only evicted (reStake path)', async () => {
    const earningDir = await mkdtemp(path.join(os.tmpdir(), 'jinn-fleet-'));
    dirs.push(earningDir);

    const mnemonic = generateMnemonic();
    const encrypted = await encryptMnemonic(mnemonic, 'test-password');
    const store = new FleetStateStore(earningDir);
    await store.saveMnemonicKeystore(encrypted);

    const masterAddr = deriveMasterAddress(mnemonic);
    const agentAddr = deriveAgentAddress(mnemonic, 1);
    await store.save({
      ...createDefaultFleetState('base'),
      master_address: masterAddr,
      services: [
        {
          index: 1,
          agent_address: agentAddr,
          safe_address: '0x2222222222222222222222222222222222222222',
          service_id: 42,
          mech_address: '0x3333333333333333333333333333333333333333',
          staking_address: '0x51c5f4982b9b0b3c0482678f5847ea6228cc8e54',
          step: 'complete',
          error: null,
        },
      ],
    });

    const bootstrapper = new FleetBootstrapper({
      earningDir,
      chain: 'base',
      rpcUrl: 'http://127.0.0.1:8545',
      stakingMode: 'standard',
    });

    const sweepSpy = vi
      .spyOn(bootstrapper as any, 'sweepAbandonedSafeForService')
      .mockResolvedValue(undefined);

    vi.spyOn(bootstrapper as any, 'gatherChainSignals').mockResolvedValue({
      stakingState: 2,
      stakingMultisig: '0x2222222222222222222222222222222222222222',
      registryState: 4,
      registryMultisig: '0x2222222222222222222222222222222222222222',
      safeDeployed: true,
    });

    vi.spyOn(bootstrapper as any, 'getStakingState').mockResolvedValue(2);
    vi.spyOn(bootstrapper as any, 'recoverEvictedService').mockImplementation(async (s: any, _m: string, index: number) => {
      return store.updateService(index, { step: 'complete' });
    });

    vi.spyOn((bootstrapper as any).provider, 'getBalance').mockResolvedValue(10_000_000_000_000_000n);

    const result = await bootstrapper.bootstrap('test-password');
    expect(result.ok).toBe(true);
    expect(sweepSpy).not.toHaveBeenCalled();
  });
});
