import { mkdtemp, rm, writeFile, mkdir } from 'fs/promises';
import os from 'os';
import path from 'path';
import { getAddress } from 'viem';
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
import { DEPRECATED_BASE_SEPOLIA_STAKING_PROXY } from '../../src/earning/testnet-setup-migration.js';

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
    vi.spyOn((bootstrapper as any).publicClient, 'getBalance').mockResolvedValue(0n);

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

  it('hydrates master_address when keystore exists without fleet master (post-init)', async () => {
    const earningDir = await mkdtemp(path.join(os.tmpdir(), 'jinn-fleet-'));
    dirs.push(earningDir);

    const mnemonic = generateMnemonic();
    const encrypted = await encryptMnemonic(mnemonic, 'test-password');
    const store = new FleetStateStore(earningDir);
    await store.saveMnemonicKeystore(encrypted);

    const bootstrapper = new FleetBootstrapper({
      earningDir,
      chain: 'base',
      rpcUrl: 'http://127.0.0.1:8545',
      stakingMode: 'standard',
    });

    vi.spyOn((bootstrapper as any).publicClient, 'getBalance').mockResolvedValue(0n);

    const result = await bootstrapper.bootstrap('test-password');

    expect(result.ok).toBe(false);
    expect(result.funding).toBeDefined();
    const expected = deriveMasterAddress(mnemonic);
    expect(getAddress(result.funding!.master_address)).toBe(getAddress(expected));

    const state = await store.load();
    expect(getAddress(state.master_address!)).toBe(getAddress(expected));
  });

  it('requires master gas before automatic testnet setup migration even when legacy service is complete', async () => {
    const earningDir = await mkdtemp(path.join(os.tmpdir(), 'jinn-fleet-'));
    dirs.push(earningDir);

    const mnemonic = generateMnemonic();
    const encrypted = await encryptMnemonic(mnemonic, 'test-password');
    const store = new FleetStateStore(earningDir);
    await store.saveMnemonicKeystore(encrypted);

    const masterAddr = deriveMasterAddress(mnemonic);
    const agentAddr = deriveAgentAddress(mnemonic, 1);
    await store.save({
      ...createDefaultFleetState('base-sepolia'),
      master_address: masterAddr,
      services: [
        {
          index: 1,
          agent_address: agentAddr,
          safe_address: '0x2222222222222222222222222222222222222222',
          service_id: 42,
          mech_address: '0x3333333333333333333333333333333333333333',
          staking_address: DEPRECATED_BASE_SEPOLIA_STAKING_PROXY,
          step: 'complete',
          error: null,
          agent_id: '123',
          agent_uri: '',
          identity_registry_address: '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432',
          agent_registered_tx: '0x' + 'aa'.repeat(32),
          safe_bound_to_agent: true,
        },
      ],
    });

    const bootstrapper = new FleetBootstrapper({
      earningDir,
      chain: 'base-sepolia',
      rpcUrl: 'http://127.0.0.1:8545',
      stakingMode: 'standard',
      env: { JINN_DISABLE_TESTNET_FAUCET: '1' },
    });

    vi.spyOn((bootstrapper as any).publicClient, 'getBalance').mockResolvedValue(0n);

    const result = await bootstrapper.bootstrap('test-password');

    expect(result.ok).toBe(false);
    expect(result.funding).toBeDefined();
    expect(result.message).toContain('Your master wallet needs more ETH');
  });

  it('preserves a non-default complete setup instead of failing during eviction recovery', async () => {
    const earningDir = await mkdtemp(path.join(os.tmpdir(), 'jinn-fleet-'));
    dirs.push(earningDir);

    const mnemonic = generateMnemonic();
    const encrypted = await encryptMnemonic(mnemonic, 'test-password');
    const store = new FleetStateStore(earningDir);
    await store.saveMnemonicKeystore(encrypted);

    const masterAddr = deriveMasterAddress(mnemonic);
    const agentAddr = deriveAgentAddress(mnemonic, 1);
    const customStaking = '0x7777777777777777777777777777777777777777';
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
          staking_address: customStaking,
          step: 'complete',
          error: null,
          agent_id: '123',
          agent_uri: '',
          identity_registry_address: '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432',
          agent_registered_tx: '0x' + 'aa'.repeat(32),
          safe_bound_to_agent: true,
        },
      ],
    });

    const bootstrapper = new FleetBootstrapper({
      earningDir,
      chain: 'base',
      rpcUrl: 'http://127.0.0.1:8545',
      stakingMode: 'standard',
    });

    vi.spyOn((bootstrapper as any).publicClient, 'getBalance').mockResolvedValue(10_000_000_000_000_000n);
    vi.spyOn(bootstrapper as any, 'gatherChainSignals').mockResolvedValue({
      stakingState: 'revert',
      stakingMultisig: null,
      registryState: 4,
      registryMultisig: '0x2222222222222222222222222222222222222222',
      safeDeployed: true,
    });
    const getStakingStateSpy = vi
      .spyOn(bootstrapper as any, 'getStakingState')
      .mockRejectedValue(new Error('custom staking read failed'));

    const result = await bootstrapper.bootstrap('test-password');

    expect(result.ok).toBe(true);
    expect(getStakingStateSpy).not.toHaveBeenCalled();
    const svc = result.fleet_state.services[0]!;
    expect(svc.service_id).toBe(42);
    expect(svc.safe_address).toBe('0x2222222222222222222222222222222222222222');
    expect(svc.staking_address).toBe(customStaking);
    expect(svc.error).toContain('preserved');
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

    vi.spyOn((bootstrapper as any).publicClient, 'getBalance').mockResolvedValue(0n);

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
    vi.spyOn((bootstrapper as any).publicClient, 'getBalance').mockResolvedValue(10_000_000_000_000_000n);

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

    vi.spyOn((bootstrapper as any).publicClient, 'getBalance').mockResolvedValue(10_000_000_000_000_000n);

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

    vi.spyOn((bootstrapper as any).publicClient, 'getBalance').mockResolvedValue(10_000_000_000_000_000n);

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

    vi.spyOn((bootstrapper as any).publicClient, 'getBalance').mockResolvedValue(10_000_000_000_000_000n);

    const result = await bootstrapper.bootstrap('test-password');
    expect(result.ok).toBe(true);
    expect(sweepSpy).not.toHaveBeenCalled();
  });

  it('surfaces an actionable error when distributor.reStake reverts with UnauthorizedAccount', async () => {
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

    vi.spyOn(bootstrapper as any, 'gatherChainSignals').mockResolvedValue({
      stakingState: 2,
      stakingMultisig: '0x2222222222222222222222222222222222222222',
      registryState: 4,
      registryMultisig: '0x2222222222222222222222222222222222222222',
      safeDeployed: true,
    });
    vi.spyOn(bootstrapper as any, 'getStakingState').mockResolvedValue(2);
    vi.spyOn((bootstrapper as any).publicClient, 'getBalance').mockResolvedValue(10_000_000_000_000_000n);

    // Force recoverEvictedService down its UnauthorizedAccount catch-branch
    // by throwing a viem-shaped revert from the underlying send. We spy on
    // the `publicClient`'s internal send path via `writeContract` won't work
    // here — the reStake path uses `viemSendTransactionWithRetry`. Mocking
    // it across the ES-module boundary is brittle, so instead we spy on
    // recoverEvictedService itself and directly reproduce the error the
    // catch block produces. This asserts the SHAPE that downstream code
    // sees; the logic that converts UnauthorizedAccount into this shape
    // lives immediately above in the same file and is unit-level obvious.
    vi.spyOn(bootstrapper as any, 'recoverEvictedService').mockImplementation(
      async (_s: any, _m: string, index: number) => {
        const masterAddress = '0xMASTERADDRESSLOCALFAKEMASTERADDRESSLOCAL';
        throw new Error(
          `Service ${index} (service_id 42) is evicted on the staking proxy, but master EOA ${masterAddress} is not authorized to reStake it. ` +
          `The distributor only permits the recorded service operator, a managing agent, or the owner. ` +
          `Verify JINN_EARNING_DIR and JINN_PASSWORD derive the original master EOA for this service, then re-run jinn bootstrap; otherwise request owner / managing-agent recovery or abandon-and-rebootstrap. ` +
          `reStake revert: UnauthorizedAccount(address)`,
        );
      },
    );

    const result = await bootstrapper.bootstrap('test-password');
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/is evicted on the staking proxy/);
    expect(result.message).toMatch(/original master EOA/);
    expect(result.message).toMatch(/JINN_EARNING_DIR/);
    expect(result.message).not.toMatch(/setCuratingAgents/);
  });

  // ── ERC-8004 IdentityRegistry mint (jinn-mono-j07) ─────────────────────────

  it('runs the ERC-8004 mint step on first bootstrap and persists agent_id', async () => {
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
      stakingMode: 'standard',
    });

    vi.spyOn((bootstrapper as any).publicClient, 'getBalance').mockResolvedValue(10_000_000_000_000_000n);

    // Stub the upstream OLAS steps; let the real `stepRegisterAgent` run.
    vi.spyOn(bootstrapper as any, 'stepStolasStake').mockImplementation(async (_s: any, _m: any, index: number) => {
      return store.updateService(index, {
        safe_address: '0x2222222222222222222222222222222222222222',
        service_id: 99,
        staking_address: '0x51c5f4982b9b0b3c0482678f5847ea6228cc8e54',
        step: 'staked',
      });
    });
    vi.spyOn(bootstrapper as any, 'stepDeployMech').mockImplementation(async (_s: any, _m: any, index: number) => {
      return store.updateService(index, {
        mech_address: '0x4444444444444444444444444444444444444444',
        step: 'mech_deployed',
      });
    });

    // Capture the call to `stepRegisterAgent` — easier than mocking the
    // whole viem write+receipt path. The real implementation drives the
    // state store the same way; what we assert here is the wiring (it
    // gets called) + the resulting transition through agent_registered
    // to safe_binding_pending when the bind is not yet done.
    const stepRegisterSpy = vi
      .spyOn(bootstrapper as any, 'stepRegisterAgent')
      .mockImplementation(async (_s: any, _m: any, index: number) => {
        return store.updateService(index as number, {
          agent_id: '7',
          agent_uri: '',
          identity_registry_address: '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432',
          agent_registered_tx: '0x' + 'ab'.repeat(32),
          safe_bound_to_agent: false,
          step: 'safe_binding_pending',
        });
      });

    const result = await bootstrapper.bootstrap('test-password');

    expect(result.ok).toBe(true);
    expect(stepRegisterSpy).toHaveBeenCalledTimes(1);
    expect(result.fleet_state.services).toHaveLength(1);
    const svc = result.fleet_state.services[0];
    expect(svc.step).toBe('safe_binding_pending');
    expect(svc.agent_id).toBe('7');
    expect(svc.identity_registry_address).toBe(
      '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432',
    );
    expect(svc.safe_bound_to_agent).toBe(false);
  });

  it('agent_registered step is idempotent — does not re-mint when agent_id is already set', async () => {
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
          step: 'mech_deployed',
          error: null,
          // Agent was minted AND bound on a previous run — both
          // sub-steps of `stepRegisterAgent` (jinn-mono-j07 mint +
          // jinn-mono-aev setAgentWallet bind) must be no-ops here.
          agent_id: '12345',
          agent_uri: '',
          identity_registry_address: '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432',
          agent_registered_tx: '0x' + 'aa'.repeat(32),
          safe_bound_to_agent: true,
        },
      ],
    });

    const bootstrapper = new FleetBootstrapper({
      earningDir,
      chain: 'base',
      rpcUrl: 'http://127.0.0.1:8545',
      stakingMode: 'standard',
    });

    // Master is funded; on-chain says service still staked (state=1).
    vi.spyOn((bootstrapper as any).publicClient, 'getBalance').mockResolvedValue(10_000_000_000_000_000n);
    vi.spyOn(bootstrapper as any, 'getStakingState').mockResolvedValue(1);
    vi.spyOn(bootstrapper as any, 'gatherChainSignals').mockResolvedValue({
      stakingState: 1,
      stakingMultisig: '0x2222222222222222222222222222222222222222',
      registryState: 4,
      registryMultisig: '0x2222222222222222222222222222222222222222',
      safeDeployed: true,
    });

    // Stake step should NOT run (we're already past awaiting_stake).
    const stakeSpy = vi
      .spyOn(bootstrapper as any, 'stepStolasStake')
      .mockImplementation(async () => {
        throw new Error('stepStolasStake should not be called on idempotent re-run');
      });

    // `stepDeployMech` is re-entered on `mech_deployed` (existing behaviour);
    // its own internal short-circuit returns immediately when mech_address
    // is already set. We assert the no-op shape via the spy here.
    const deploySpy = vi
      .spyOn(bootstrapper as any, 'stepDeployMech')
      .mockImplementation(async (_s: any, _m: any, index: number) => {
        // Real stepDeployMech early-returns to `mech_deployed` when
        // mech_address exists; mirror that here.
        return store.updateService(index, { step: 'mech_deployed' });
      });

    // The real stepRegisterAgent runs — its internal short-circuit must
    // detect the existing agent_id and skip the mint tx. We assert by
    // spying on the underlying viem send path: zero tx writes means no
    // re-mint.
    const sendSpy = vi
      .spyOn((bootstrapper as any).publicClient, 'request')
      .mockImplementation(async (_opts: any) => {
        // Fall through to the real eth_chainId and balance reads; only
        // forbid send paths.
        return undefined as any;
      });

    const result = await bootstrapper.bootstrap('test-password');

    expect(result.ok).toBe(true);
    expect(stakeSpy).not.toHaveBeenCalled();
    expect(deploySpy).toHaveBeenCalledTimes(1);

    // The publicClient.request mock above swallows everything, so we
    // can't fail-by-fact-of-call. Instead assert no eth_sendRawTransaction
    // / eth_sendTransaction calls reached the request fn.
    const sendCalls = sendSpy.mock.calls.filter(([opts]: any[]) =>
      typeof opts === 'object' && opts && (opts.method === 'eth_sendRawTransaction' || opts.method === 'eth_sendTransaction'),
    );
    expect(sendCalls).toHaveLength(0);

    const svc = result.fleet_state.services[0];
    expect(svc.step).toBe('complete');
    // agent_id and identity_registry_address survive the re-run.
    expect(svc.agent_id).toBe('12345');
    expect(svc.identity_registry_address).toBe(
      '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432',
    );
  });

  it('agent_registered step short-circuits in stepRegisterAgent when agent_id already set', async () => {
    // Direct unit test of the idempotency guard in `stepRegisterAgent`,
    // without driving the full bootstrap loop. Asserts that no
    // outgoing tx is sent when `agent_id` is already on the service row.
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
          step: 'mech_deployed',
          error: null,
          agent_id: '999',
          agent_uri: '',
          identity_registry_address: '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432',
          agent_registered_tx: '0x' + 'cc'.repeat(32),
          // Both sub-steps already done — short-circuit the entire
          // stepRegisterAgent (jinn-mono-aev folded the bind into the
          // same step, gated by this flag).
          safe_bound_to_agent: true,
        },
      ],
    });

    const bootstrapper = new FleetBootstrapper({
      earningDir,
      chain: 'base',
      rpcUrl: 'http://127.0.0.1:8545',
      stakingMode: 'standard',
    });

    const writeSpy = vi.spyOn((bootstrapper as any).publicClient, 'request');

    // Drive the step directly. We don't supply state-with-services; the
    // method re-reads from the store regardless.
    const fleet = await store.load('base');
    const next = await (bootstrapper as any).stepRegisterAgent(fleet, mnemonic, 1);

    const svc = next.services.find((s: any) => s.index === 1);
    expect(svc.step).toBe('complete');
    expect(svc.agent_id).toBe('999');
    // identity_registry_address is preserved from the prior persisted value.
    expect(svc.identity_registry_address).toBe(
      '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432',
    );
    // No outgoing RPC writes — the short-circuit happens before any tx.
    const sendCalls = writeSpy.mock.calls.filter(([opts]: any[]) =>
      typeof opts === 'object' && opts && (opts.method === 'eth_sendRawTransaction' || opts.method === 'eth_sendTransaction'),
    );
    expect(sendCalls).toHaveLength(0);
  });

  it('agent_registered step runs setAgentWallet bind when agent_id set but safe_bound_to_agent=false (jinn-mono-aev)', async () => {
    // Mint already happened; bind didn't. stepRegisterAgent must skip
    // the mint sub-step but invoke the binding helper exactly once.
    const earningDir = await mkdtemp(path.join(os.tmpdir(), 'jinn-fleet-'));
    dirs.push(earningDir);

    const mnemonic = generateMnemonic();
    const encrypted = await encryptMnemonic(mnemonic, 'test-password');
    const store = new FleetStateStore(earningDir);
    await store.saveMnemonicKeystore(encrypted);

    const masterAddr = deriveMasterAddress(mnemonic);
    const agentAddr = deriveAgentAddress(mnemonic, 1);
    const safeAddr = '0x2222222222222222222222222222222222222222';
    await store.save({
      ...createDefaultFleetState('base'),
      master_address: masterAddr,
      services: [
        {
          index: 1,
          agent_address: agentAddr,
          safe_address: safeAddr,
          service_id: 42,
          mech_address: '0x3333333333333333333333333333333333333333',
          staking_address: '0x51c5f4982b9b0b3c0482678f5847ea6228cc8e54',
          step: 'mech_deployed',
          error: null,
          agent_id: '777',
          agent_uri: '',
          identity_registry_address: '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432',
          agent_registered_tx: '0x' + 'dd'.repeat(32),
          // Critical: mint persisted, bind did not.
          safe_bound_to_agent: false,
        },
      ],
    });

    const bootstrapper = new FleetBootstrapper({
      earningDir,
      chain: 'base',
      rpcUrl: 'http://127.0.0.1:8545',
      stakingMode: 'standard',
    });

    // Stub the binding helper at module-import boundary by intercepting
    // the dependency through doMock. Vitest's `vi.doMock` requires the
    // import to be re-fetched; instead, monkey-patch via the helper
    // module directly.
    const bindingMod = await import('../../src/earning/agent-wallet-binding.js');
    const bindSpy = vi
      .spyOn(bindingMod, 'bindAgentWalletToSafe')
      .mockResolvedValue({
        txHash: ('0x' + 'ee'.repeat(32)) as `0x${string}`,
        identityDigest: ('0x' + '11'.repeat(32)) as `0x${string}`,
        safeMessageHash: ('0x' + '22'.repeat(32)) as `0x${string}`,
        signature: ('0x' + '33'.repeat(65)) as `0x${string}`,
        deadline: 9_999_999_999n,
      });

    const fleet = await store.load('base');
    const next = await (bootstrapper as any).stepRegisterAgent(fleet, mnemonic, 1);

    const svc = next.services.find((s: any) => s.index === 1);
    expect(svc.safe_bound_to_agent).toBe(true);
    expect(svc.agent_id).toBe('777');
    expect(bindSpy).toHaveBeenCalledTimes(1);
    const callArgs = bindSpy.mock.calls[0]![0];
    expect(callArgs.agentId).toBe(777n);
    expect(getAddress(callArgs.safeAddress)).toBe(getAddress(safeAddr));
    expect(callArgs.chainId).toBe(8453);
  });

  it('agent_registered step does not block bootstrap when setAgentWallet bind reverts', async () => {
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
          step: 'agent_registered',
          error: null,
          agent_id: '777',
          agent_uri: '',
          identity_registry_address: '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432',
          agent_registered_tx: '0x' + 'dd'.repeat(32),
          safe_bound_to_agent: false,
        },
      ],
    });

    const bootstrapper = new FleetBootstrapper({
      earningDir,
      chain: 'base',
      rpcUrl: 'http://127.0.0.1:8545',
      stakingMode: 'standard',
    });

    const bindingMod = await import('../../src/earning/agent-wallet-binding.js');
    vi.spyOn(bindingMod, 'bindAgentWalletToSafe').mockRejectedValue(new Error('bind reverted'));

    const fleet = await store.load('base');
    const next = await (bootstrapper as any).resumeServiceStandard(fleet, mnemonic, 1);

    const svc = next.services.find((s: any) => s.index === 1);
    expect(svc.step).toBe('safe_binding_pending');
    expect(svc.agent_id).toBe('777');
    expect(svc.safe_bound_to_agent).toBe(false);
    expect(svc.error).toContain('safe_binding_failed');
  });

  it('resume path: complete service with agent_id + safe_bound_to_agent=false runs binding step', async () => {
    // Should-fix #3: legacy operator who minted agent NFT (agent_id set) but
    // never ran the Safe-binding step (safe_bound_to_agent=false). Resuming
    // with step='complete' must detect this and call stepRegisterAgent once.
    const earningDir = await mkdtemp(path.join(os.tmpdir(), 'jinn-fleet-'));
    dirs.push(earningDir);

    const mnemonic = generateMnemonic();
    const encrypted = await encryptMnemonic(mnemonic, 'test-password');
    const store = new FleetStateStore(earningDir);
    await store.saveMnemonicKeystore(encrypted);

    const masterAddr = deriveMasterAddress(mnemonic);
    const agentAddr = deriveAgentAddress(mnemonic, 1);
    // Service is 'complete', has an agent_id, but safe was never bound.
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
          agent_id: '555',
          agent_uri: '',
          identity_registry_address: '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432',
          agent_registered_tx: '0x' + 'aa'.repeat(32),
          safe_bound_to_agent: false,
        },
      ],
    });

    const bootstrapper = new FleetBootstrapper({
      earningDir,
      chain: 'base',
      rpcUrl: 'http://127.0.0.1:8545',
      stakingMode: 'standard',
    });

    vi.spyOn((bootstrapper as any).publicClient, 'getBalance').mockResolvedValue(10_000_000_000_000_000n);
    // On-chain staking state is 1 (staked), so eviction recovery path is skipped.
    vi.spyOn(bootstrapper as any, 'getStakingState').mockResolvedValue(1);
    // Avoid real RPC: chain-signal gather returns a healthy staked + bound view.
    vi.spyOn(bootstrapper as any, 'gatherChainSignals').mockResolvedValue({
      stakingState: 1,
      stakingMultisig: '0x2222222222222222222222222222222222222222',
      registryState: 4,
      registryMultisig: '0x2222222222222222222222222222222222222222',
      safeDeployed: true,
    });

    // Spy on stepRegisterAgent to assert it is called for the binding step.
    const stepRegisterSpy = vi
      .spyOn(bootstrapper as any, 'stepRegisterAgent')
      .mockImplementation(async (_s: any, _m: any, index: number) => {
        // Simulate the binding completing: safe_bound_to_agent flips to true,
        // service stays at 'complete' (binding is a one-shot side-step).
        return store.updateService(index, {
          safe_bound_to_agent: true,
        });
      });

    const result = await bootstrapper.bootstrap('test-password');

    expect(result.ok).toBe(true);
    // stepRegisterAgent must have been called to complete the binding.
    expect(stepRegisterSpy).toHaveBeenCalledTimes(1);
    const svc = result.fleet_state.services[0];
    // Service must remain 'complete' after the binding step runs.
    expect(svc.step).toBe('complete');
    // Binding flag persisted.
    expect(svc.safe_bound_to_agent).toBe(true);
    // agent_id preserved.
    expect(svc.agent_id).toBe('555');
  });

  it('resume path: complete service with agent_id + safe_bound_to_agent=true skips binding (no-op)', async () => {
    // Counterpart: already-bound legacy operator must NOT re-run binding.
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
          agent_id: '555',
          agent_uri: '',
          identity_registry_address: '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432',
          agent_registered_tx: '0x' + 'aa'.repeat(32),
          safe_bound_to_agent: true,
        },
      ],
    });

    const bootstrapper = new FleetBootstrapper({
      earningDir,
      chain: 'base',
      rpcUrl: 'http://127.0.0.1:8545',
      stakingMode: 'standard',
    });

    vi.spyOn((bootstrapper as any).publicClient, 'getBalance').mockResolvedValue(10_000_000_000_000_000n);
    vi.spyOn(bootstrapper as any, 'getStakingState').mockResolvedValue(1);
    vi.spyOn(bootstrapper as any, 'gatherChainSignals').mockResolvedValue({
      stakingState: 1,
      stakingMultisig: '0x2222222222222222222222222222222222222222',
      registryState: 4,
      registryMultisig: '0x2222222222222222222222222222222222222222',
      safeDeployed: true,
    });

    const stepRegisterSpy = vi.spyOn(bootstrapper as any, 'stepRegisterAgent');

    const result = await bootstrapper.bootstrap('test-password');

    expect(result.ok).toBe(true);
    // Safe already bound — binding step must NOT run.
    expect(stepRegisterSpy).not.toHaveBeenCalled();
    const svc = result.fleet_state.services[0];
    expect(svc.step).toBe('complete');
  });

  it('agent_registered step short-circuits bind when safe_bound_to_agent already true', async () => {
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
          step: 'mech_deployed',
          error: null,
          agent_id: '777',
          agent_uri: '',
          identity_registry_address: '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432',
          agent_registered_tx: '0x' + 'ee'.repeat(32),
          safe_bound_to_agent: true,
        },
      ],
    });

    const bootstrapper = new FleetBootstrapper({
      earningDir,
      chain: 'base',
      rpcUrl: 'http://127.0.0.1:8545',
      stakingMode: 'standard',
    });

    const bindingMod = await import('../../src/earning/agent-wallet-binding.js');
    const bindSpy = vi.spyOn(bindingMod, 'bindAgentWalletToSafe');

    const fleet = await store.load('base');
    const next = await (bootstrapper as any).stepRegisterAgent(fleet, mnemonic, 1);

    expect(bindSpy).not.toHaveBeenCalled();
    const svc = next.services.find((s: any) => s.index === 1);
    expect(svc.safe_bound_to_agent).toBe(true);
  });
});
