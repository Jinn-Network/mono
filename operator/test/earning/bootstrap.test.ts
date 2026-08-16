import { mkdtemp, readdir, rm, writeFile, mkdir } from 'fs/promises';
import os from 'os';
import path from 'path';
import { getAddress } from 'viem';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FleetBootstrapper, computeRequiredMasterEth } from '../../src/earning/bootstrap.js';
import { FleetStateStore } from '../../src/earning/store.js';
import {
  generateMnemonic,
  encryptMnemonic,
  deriveMasterAddress,
  deriveAgentAddress,
} from '../../src/earning/wallet.js';
import { createDefaultFleetState, type FleetState } from '../../src/earning/types.js';
import { DEPRECATED_BASE_SEPOLIA_STAKING_PROXY } from '../../src/earning/testnet-setup-migration.js';

const BOOTSTRAP_TEST_TIMEOUT_MS = 15_000;

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

  it('uses the 0.0005 ETH/day default master daily when pollIntervalMs is the daemon default (#288)', async () => {
    // Regression for #288: the per-poll heuristic baked into
    // `estimateMasterDailyGasWei` short-circuited the conservative floor at
    // pollIntervalMs=5000 (the daemon default), returning 3.6e15 wei
    // (≈ 0.0036 ETH/day) and producing the misleading "1 days runway"
    // dashboard reading after fresh bootstrap. The fix drops the blend and
    // returns the floor (0.0005 ETH/day = 5e14 wei) directly when no
    // explicit override is supplied.
    const earningDir = await mkdtemp(path.join(os.tmpdir(), 'jinn-fleet-'));
    dirs.push(earningDir);

    const bootstrapper = new FleetBootstrapper({
      earningDir,
      chain: 'base',
      rpcUrl: 'http://127.0.0.1:8545',
      stakingMode: 'standard',
      pollIntervalMs: 5000,
    });

    expect((bootstrapper as any).masterEthDailyEstimateWei).toBe(500_000_000_000_000n);
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

  it('archives an unusable keystore only when fleet state is still fresh', async () => {
    const earningDir = await mkdtemp(path.join(os.tmpdir(), 'jinn-fleet-'));
    dirs.push(earningDir);

    const store = new FleetStateStore(earningDir);
    await store.save(createDefaultFleetState('base-sepolia'));
    await writeFile(
      path.join(earningDir, 'master_keystore.json'),
      JSON.stringify({
        version: 1,
        type: 'hd-mnemonic',
        master_address: '0x0000000000000000000000000000000000000000',
        keystore: {},
        mnemonic_obfuscated: '',
        mnemonic_length: 0,
      }),
    );

    const bootstrapper = new FleetBootstrapper({
      earningDir,
      chain: 'base-sepolia',
      rpcUrl: 'http://127.0.0.1:8545',
      stakingMode: 'standard',
      autoTestnetFaucet: false,
    });
    vi.spyOn((bootstrapper as any).publicClient, 'getBalance').mockResolvedValue(0n);

    const result = await bootstrapper.bootstrap('test-password');

    expect(result.ok).toBe(false);
    expect(result.funding?.master_address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    const files = await readdir(earningDir);
    expect(files.some((name) => name.startsWith('master_keystore.json.invalid-before-wallet-init.'))).toBe(true);
    expect(store.hasMnemonicKeystore()).toBe(true);
    const state = await store.load('base-sepolia');
    expect(state.chain).toBe('base-sepolia');
    expect(getAddress(state.master_address!)).toBe(getAddress(result.funding!.master_address));
  });

  it('does not archive an unusable keystore once fleet state references a wallet', async () => {
    const earningDir = await mkdtemp(path.join(os.tmpdir(), 'jinn-fleet-'));
    dirs.push(earningDir);

    const store = new FleetStateStore(earningDir);
    await store.save({
      ...createDefaultFleetState('base-sepolia'),
      master_address: '0x1111111111111111111111111111111111111111',
    });
    await writeFile(
      path.join(earningDir, 'master_keystore.json'),
      JSON.stringify({
        version: 1,
        type: 'hd-mnemonic',
        master_address: '0x1111111111111111111111111111111111111111',
        keystore: {},
        mnemonic_obfuscated: '',
        mnemonic_length: 0,
      }),
    );

    const bootstrapper = new FleetBootstrapper({
      earningDir,
      chain: 'base-sepolia',
      rpcUrl: 'http://127.0.0.1:8545',
      stakingMode: 'standard',
      autoTestnetFaucet: false,
    });
    vi.spyOn((bootstrapper as any).publicClient, 'getBalance').mockResolvedValue(10_000_000_000_000_000n);

    const result = await bootstrapper.bootstrap('test-password');

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/Existing mnemonic keystore could not be decrypted/);
    const files = await readdir(earningDir);
    expect(files.some((name) => name.startsWith('master_keystore.json.invalid-before-wallet-init.'))).toBe(false);
    expect(store.hasMnemonicKeystore()).toBe(true);
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

    // Master is funded — pre-Stage-1 gate is the FULL bootstrap budget:
    // STAGE1_AGENT_ETH (0.010) + minEoaGasEth*2 (0.010) = 0.020 ETH for N=1 (jinn-mono-u34i one-shot funding).
    vi.spyOn((bootstrapper as any).publicClient, 'getBalance').mockResolvedValue(20_000_000_000_000_000n);
    vi.spyOn((bootstrapper as any).publicClient, 'getCode').mockResolvedValue('0xdeadbeef');

    // Stage 1 mocks — bootstrap() now calls ensureStage1 first (nghf).
    vi.spyOn(bootstrapper as any, 'stepFleetSafePredict').mockImplementation(async () => {
      await store.patchFleet({ fleet_safe_address: '0xF1F1F1F1F1F1F1F1F1F1F1F1F1F1F1F1F1F1F1F1' });
      return store.load('base');
    });
    vi.spyOn(bootstrapper as any, 'stepFleetSafeDeploy').mockImplementation(async () => store.load('base'));
    vi.spyOn(bootstrapper as any, 'stepFleetIdentityRegister').mockImplementation(async () => {
      await store.patchFleet({ fleet_agent_id: '1', fleet_stage: 'stage1' });
      return store.load('base');
    });

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

    // Pre-Stage-1 gate is the FULL bootstrap budget. For targetServices=3
    // standard mode: STAGE1_AGENT_ETH (0.010) + minEoaGasEth*2 (0.010) +
    // minEoaGasEth*(targetServices-1) (0.010) = 0.030 ETH (jinn-mono-u34i
    // one-shot funding). Operator funds once for all 3 services.
    vi.spyOn((bootstrapper as any).publicClient, 'getBalance').mockResolvedValue(30_000_000_000_000_000n);
    vi.spyOn((bootstrapper as any).publicClient, 'getCode').mockResolvedValue('0xdeadbeef');

    // Stage 1 mocks — bootstrap() now calls ensureStage1 first (nghf).
    vi.spyOn(bootstrapper as any, 'stepFleetSafePredict').mockImplementation(async () => {
      await store.patchFleet({ fleet_safe_address: '0xF2F2F2F2F2F2F2F2F2F2F2F2F2F2F2F2F2F2F2F2' });
      return store.load('base');
    });
    vi.spyOn(bootstrapper as any, 'stepFleetSafeDeploy').mockImplementation(async () => store.load('base'));
    vi.spyOn(bootstrapper as any, 'stepFleetIdentityRegister').mockImplementation(async () => {
      await store.patchFleet({ fleet_agent_id: '2', fleet_stage: 'stage1' });
      return store.load('base');
    });

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
  }, BOOTSTRAP_TEST_TIMEOUT_MS);

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

  it('defers an evicted standard service to the background EvictionLoop at resume — no inline startup reStake (#773/#789)', async () => {
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
    // #773: resume must NOT inline-reStake an evicted service at startup —
    // re-staking is orthogonal to earning and is handled out-of-band by the
    // throttled background EvictionLoop. An eager startup reStake broadcasts
    // from the agent EOA during boot and contends with other agent-EOA work
    // (e.g. a launch's setMetadata, which then reverts and strands the launch).
    // Spy so a regression that re-introduces the eager startup reStake fails.
    const recoverSpy = vi
      .spyOn(bootstrapper as any, 'recoverEvictedService')
      .mockResolvedValue(undefined);

    vi.spyOn((bootstrapper as any).publicClient, 'getBalance').mockResolvedValue(10_000_000_000_000_000n);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await bootstrapper.bootstrap('test-password');
    expect(result.ok).toBe(true);
    expect(recoverSpy).not.toHaveBeenCalled();
    expect(sweepSpy).not.toHaveBeenCalled();
    const logged = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(logged).toMatch(/deferring to the background EvictionLoop/);
    // Eviction is non-load-bearing substrate — the deferral notice must not
    // read as an error (#1060 / DR-2026-06-04).
    const errs = errorSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(errs).not.toMatch(/deferring to the background EvictionLoop/);
  }, BOOTSTRAP_TEST_TIMEOUT_MS);

  // (Removed) The startup-reStake-revert test (#789) no longer applies: resume
  // does NOT inline-reStake an evicted service at startup (see the "defers … to
  // the background EvictionLoop" test above — #773). The invariants it covered
  // now live where the behaviour lives:
  //   - non-fatal reStake-revert + throttle → test/daemon/eviction-loop.test.ts
  //     ("keeps a reverted reStake attempt throttled within the window" — #917).
  //   - the actionable UnauthorizedAccount operator message → test/operator-errors.test.ts.

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

    // Pre-Stage-1 gate is the FULL bootstrap budget = 0.020 ETH for N=1 (jinn-mono-u34i one-shot funding).
    vi.spyOn((bootstrapper as any).publicClient, 'getBalance').mockResolvedValue(20_000_000_000_000_000n);
    vi.spyOn((bootstrapper as any).publicClient, 'getCode').mockResolvedValue('0xdeadbeef');

    // Stage 1 mocks — bootstrap() now calls ensureStage1 first (nghf).
    // Note: fleet_agent_id is left unset so stepRegisterAgent falls through to its
    // legacy mint path (no fleet identity to reuse), exercising the ERC-8004 mint spy.
    vi.spyOn(bootstrapper as any, 'stepFleetSafePredict').mockImplementation(async () => {
      await store.patchFleet({ fleet_safe_address: '0xF3F3F3F3F3F3F3F3F3F3F3F3F3F3F3F3F3F3F3F3' });
      return store.load('base');
    });
    vi.spyOn(bootstrapper as any, 'stepFleetSafeDeploy').mockImplementation(async () => store.load('base'));
    vi.spyOn(bootstrapper as any, 'stepFleetIdentityRegister').mockImplementation(async () => {
      // Do NOT set fleet_agent_id here — this test asserts that stepRegisterAgent
      // is called for the service row (legacy mint path when fleet_agent_id is absent).
      await store.patchFleet({ fleet_stage: 'stage1' });
      return store.load('base');
    });

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
  }, BOOTSTRAP_TEST_TIMEOUT_MS);

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
        ok: true as const,
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

  it('agent_registered step does not block bootstrap when setAgentWallet bind reverts (post-h74p: after retry budget)', async () => {
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
      // h74p: skip retry sleeps so the test doesn't burn time.
      safeBindingRetryDelayMs: 0,
    });

    const bindingMod = await import('../../src/earning/agent-wallet-binding.js');
    vi.spyOn(bindingMod, 'bindAgentWalletToSafe').mockResolvedValue({
      ok: false as const,
      error: {
        kind: 'safe_binding_failed' as const,
        message: 'bind reverted',
        shortMessage: 'bind reverted',
        revertReason: null,
      },
    });

    const fleet = await store.load('base');
    const next = await (bootstrapper as any).resumeServiceStandard(fleet, mnemonic, 1);

    const svc = next.services.find((s: any) => s.index === 1);
    expect(svc.step).toBe('safe_binding_pending');
    expect(svc.agent_id).toBe('777');
    expect(svc.safe_bound_to_agent).toBe(false);
    expect(svc.error).toContain('safe_binding_failed');
  });

  it('agent_registered step retries setAgentWallet on transient failure and succeeds (jinn-mono-h74p)', async () => {
    // h74p: against a freshly-deployed 1/1 Safe on Base Sepolia, the first
    // `setAgentWallet` attempt reverts (likely RPC state-lag / freshly-deployed-
    // Safe race window — observed empirically). A second attempt against the
    // same Safe + same agentId after a short delay succeeds with no code change.
    // Bootstrap must retry in-process so first-run operators don't sit at
    // `safe_bound_to_agent=false` waiting for the bootstrap loop to re-tick.
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
      // Fast retry delay so this test doesn't burn seconds on retry sleeps.
      safeBindingRetryDelayMs: 0,
    });

    const bindingMod = await import('../../src/earning/agent-wallet-binding.js');
    const bindSpy = vi
      .spyOn(bindingMod, 'bindAgentWalletToSafe')
      // First attempt: simulated freshly-deployed-Safe revert.
      .mockRejectedValueOnce(new Error('Execution reverted for an unknown reason.'))
      // Second attempt (after short retry delay): succeeds.
      // hjex.4 introduced the BindAgentWalletOutcome Result type — success
      // requires `ok: true` on the resolved value.
      .mockResolvedValueOnce({
        ok: true as const,
        txHash: ('0x' + 'ee'.repeat(32)) as `0x${string}`,
        identityDigest: ('0x' + '11'.repeat(32)) as `0x${string}`,
        safeMessageHash: ('0x' + '22'.repeat(32)) as `0x${string}`,
        signature: ('0x' + '33'.repeat(65)) as `0x${string}`,
        deadline: 9_999_999_999n,
      });

    const fleet = await store.load('base');
    const next = await (bootstrapper as any).resumeServiceStandard(fleet, mnemonic, 1);

    const svc = next.services.find((s: any) => s.index === 1);
    expect(bindSpy).toHaveBeenCalledTimes(2);
    expect(svc.safe_bound_to_agent).toBe(true);
    expect(svc.step).toBe('complete');
    expect(svc.error).toBe(null);
  });

  it('agent_registered step gives up after maxAttempts and persists failure (jinn-mono-h74p)', async () => {
    // h74p: bound retry budget so a real (non-transient) failure isn't masked.
    // After maxAttempts all-failing, bootstrap must fall through to the
    // existing 'safe_binding_pending' persisted state — same surface error
    // as today's no-retry behavior, just after N attempts instead of 1.
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
      safeBindingMaxAttempts: 3,
      safeBindingRetryDelayMs: 0,
    });

    const bindingMod = await import('../../src/earning/agent-wallet-binding.js');
    const bindSpy = vi
      .spyOn(bindingMod, 'bindAgentWalletToSafe')
      .mockRejectedValue(new Error('persistent bind revert'));

    const fleet = await store.load('base');
    const next = await (bootstrapper as any).resumeServiceStandard(fleet, mnemonic, 1);

    const svc = next.services.find((s: any) => s.index === 1);
    expect(bindSpy).toHaveBeenCalledTimes(3);
    expect(svc.step).toBe('safe_binding_pending');
    expect(svc.safe_bound_to_agent).toBe(false);
    expect(svc.error).toContain('safe_binding_failed');
  });

  it('agent_registered step retries setAgentWallet on returned ok:false (production race) and succeeds (jinn-mono-k1ng)', async () => {
    // jinn-mono-k1ng: the existing h74p tests mock `mockRejectedValueOnce(new
    // Error(...))` — i.e. they assume bindAgentWalletToSafe THROWS on the
    // race. In production it RETURNS `{ ok: false, error }` (try/catch
    // internal). The previous retry only caught throws, so it was dead code.
    // This test mocks the REAL production shape: two transient ok:false
    // followed by ok:true. The unified bindAgentWalletWithRetry must retry
    // on returned ok:false (not just thrown exceptions) for the per-service
    // path to actually heal the race in-process — without relying on the
    // 'safe_binding_pending' resume-on-next-bootstrap fallback.
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
      safeBindingRetryDelayMs: 0,
    });

    const bindingMod = await import('../../src/earning/agent-wallet-binding.js');
    const transientOkFalse = {
      ok: false as const,
      error: {
        kind: 'safe_binding_failed' as const,
        message: 'Execution reverted for an unknown reason.',
        shortMessage: 'Execution reverted for an unknown reason.',
        revertReason: null,
      },
    };
    const successOutcome = {
      ok: true as const,
      txHash: ('0x' + 'ee'.repeat(32)) as `0x${string}`,
      identityDigest: ('0x' + '11'.repeat(32)) as `0x${string}`,
      safeMessageHash: ('0x' + '22'.repeat(32)) as `0x${string}`,
      signature: ('0x' + '33'.repeat(65)) as `0x${string}`,
      deadline: 9_999_999_999n,
    };
    const bindSpy = vi
      .spyOn(bindingMod, 'bindAgentWalletToSafe')
      .mockResolvedValueOnce(transientOkFalse)
      .mockResolvedValueOnce(transientOkFalse)
      .mockResolvedValueOnce(successOutcome);

    const fleet = await store.load('base');
    const next = await (bootstrapper as any).resumeServiceStandard(fleet, mnemonic, 1);

    const svc = next.services.find((s: any) => s.index === 1);
    expect(bindSpy).toHaveBeenCalledTimes(3);
    expect(svc.safe_bound_to_agent).toBe(true);
    expect(svc.step).toBe('complete');
    expect(svc.error).toBe(null);
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

  it('refuses to stake when agent_address is already registered on-chain (jinn-mono-hjex.1)', async () => {
    // Simulates the scenario after a failed migration: service_id was cleared
    // but agent_address kept. mapAgentInstanceOperators returns a non-zero
    // operator address on-chain, so calling stake() would revert with
    // AgentInstanceRegistered (0x631695bd). stepStolasStake must detect this
    // and fail fast with a typed error.
    //
    // We invoke stepStolasStake directly (rather than via the full
    // bootstrap() entrypoint) because the upstream Stage-1 ETH gate aborts
    // before the staking step is reached in unit-test mocks. The point of
    // this test is the guard itself.
    const earningDir = await mkdtemp(path.join(os.tmpdir(), 'jinn-fleet-'));
    dirs.push(earningDir);

    const mnemonic = generateMnemonic();
    const encrypted = await encryptMnemonic(mnemonic, 'test-password');
    const store = new FleetStateStore(earningDir);
    await store.saveMnemonicKeystore(encrypted);

    const masterAddr = deriveMasterAddress(mnemonic);
    const agentAddr = deriveAgentAddress(mnemonic, 1);
    // State after a failed migration: service_id null but agent_address present
    const state: FleetState = {
      ...createDefaultFleetState('base-sepolia'),
      master_address: masterAddr,
      services: [
        {
          index: 1,
          agent_address: agentAddr,
          safe_address: null,
          service_id: null,
          mech_address: null,
          staking_address: null,
          step: 'awaiting_stake',
          error: null,
          agent_id: null,
          agent_uri: null,
          identity_registry_address: null,
          agent_registered_tx: null,
          safe_bound_to_agent: false,
        },
      ],
    };
    await store.save(state);

    const bootstrapper = new FleetBootstrapper({
      earningDir,
      chain: 'base-sepolia',
      rpcUrl: 'http://127.0.0.1:8545',
      stakingMode: 'standard',
      autoTestnetFaucet: false,
    });

    // mapAgentInstanceOperators returns a non-zero operator address — agent EOA
    // is already bound on-chain (operator that registered the instance during the
    // failed retire).
    const previousOperator = '0x1111111111111111111111111111111111111111';
    const readContractSpy = vi.spyOn((bootstrapper as any).publicClient, 'readContract').mockImplementation(
      async ({ functionName }: { functionName: string }) => {
        if (functionName === 'mapAgentInstanceOperators') return previousOperator;
        return 0n;
      },
    );

    // Guard fires before stolasPreflightCheck / stake submission, but stub the
    // preflight anyway so failure modes downstream of the guard cannot leak in.
    vi.spyOn(bootstrapper as any, 'stolasPreflightCheck').mockResolvedValue(undefined);

    let thrown: unknown;
    try {
      await (bootstrapper as any).stepStolasStake(state, mnemonic, 1);
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain('agent_already_bound');
    expect((thrown as Error).message).toContain(agentAddr);
    // Confirm the guard actually queried the registry — proves the guard fired
    // rather than the failure coming from some downstream path.
    const operatorReads = readContractSpy.mock.calls.filter(
      ([args]: any[]) => args?.functionName === 'mapAgentInstanceOperators',
    );
    expect(operatorReads.length).toBeGreaterThan(0);
  });

  it('does NOT trip the agent_already_bound guard when mapAgentInstanceOperators returns zero address (unregistered)', async () => {
    // Simulates a clean state after migration: service_id null, agent_address present,
    // but the agent EOA is NOT registered on-chain (mapAgentInstanceOperators returns
    // the zero address). stepStolasStake should proceed past the precondition without
    // throwing the typed agent_already_bound error.
    const earningDir = await mkdtemp(path.join(os.tmpdir(), 'jinn-fleet-'));
    dirs.push(earningDir);

    const mnemonic = generateMnemonic();
    const encrypted = await encryptMnemonic(mnemonic, 'test-password');
    const store = new FleetStateStore(earningDir);
    await store.saveMnemonicKeystore(encrypted);

    const masterAddr = deriveMasterAddress(mnemonic);
    const agentAddr = deriveAgentAddress(mnemonic, 1);
    const state: FleetState = {
      ...createDefaultFleetState('base-sepolia'),
      master_address: masterAddr,
      services: [
        {
          index: 1,
          agent_address: agentAddr,
          safe_address: null,
          service_id: null,
          mech_address: null,
          staking_address: null,
          step: 'awaiting_stake',
          error: null,
          agent_id: null,
          agent_uri: null,
          identity_registry_address: null,
          agent_registered_tx: null,
          safe_bound_to_agent: false,
        },
      ],
    };
    await store.save(state);

    const bootstrapper = new FleetBootstrapper({
      earningDir,
      chain: 'base-sepolia',
      rpcUrl: 'http://127.0.0.1:8545',
      stakingMode: 'standard',
      autoTestnetFaucet: false,
    });

    // mapAgentInstanceOperators returns zero address — agent EOA is NOT registered.
    const readContractSpy = vi.spyOn((bootstrapper as any).publicClient, 'readContract').mockImplementation(
      async ({ functionName }: { functionName: string }) => {
        if (functionName === 'mapAgentInstanceOperators') {
          return '0x0000000000000000000000000000000000000000';
        }
        return 0n;
      },
    );

    // Make the preflight throw a sentinel AFTER the guard, so we can prove
    // the guard ran without entering the actual stake() submission (which
    // hangs on the mocked RPC's retry loop).
    let preflightReached = false;
    vi.spyOn(bootstrapper as any, 'stolasPreflightCheck').mockImplementation(async () => {
      preflightReached = true;
      throw new Error('stolasPreflightCheck-sentinel');
    });

    let thrown: unknown;
    try {
      await (bootstrapper as any).stepStolasStake(state, mnemonic, 1);
    } catch (err) {
      thrown = err;
    }

    // Guard ran (registry was queried) and did NOT throw agent_already_bound.
    // stepStolasStake advanced past the guard into the preflight sentinel.
    expect(preflightReached).toBe(true);
    expect((thrown as Error | undefined)?.message ?? '').not.toContain('agent_already_bound');
    expect((thrown as Error | undefined)?.message ?? '').toContain('stolasPreflightCheck-sentinel');
    const operatorReads = readContractSpy.mock.calls.filter(
      ([args]: any[]) => args?.functionName === 'mapAgentInstanceOperators',
    );
    expect(operatorReads.length).toBeGreaterThan(0);
  });

  it('retry-after-failed-retire: stepStolasStake proceeds past the guard with no agent_already_bound trip (jinn-mono-hjex.1)', async () => {
    // Regression for the original hjex.1 sequence: a previous migration retire
    // failed and left local state preserved (service_id null, agent_address kept,
    // and the on-chain registry NEVER registered the agent EOA because the retire
    // failed before binding). On the retry, stepStolasStake's pre-stake guard
    // must not spuriously trip — mapAgentInstanceOperators returns the zero
    // address because no operator ever bound this EOA, and stepStolasStake must
    // proceed past the precondition into the stake submission path.
    const earningDir = await mkdtemp(path.join(os.tmpdir(), 'jinn-fleet-'));
    dirs.push(earningDir);

    const mnemonic = generateMnemonic();
    const encrypted = await encryptMnemonic(mnemonic, 'test-password');
    const store = new FleetStateStore(earningDir);
    await store.saveMnemonicKeystore(encrypted);

    const masterAddr = deriveMasterAddress(mnemonic);
    const agentAddr = deriveAgentAddress(mnemonic, 1);

    // Persist post-failed-migration state: service_id cleared but other fields
    // preserved (matches the migration's retire-failure preservation behaviour).
    const state: FleetState = {
      ...createDefaultFleetState('base-sepolia'),
      master_address: masterAddr,
      services: [
        {
          index: 1,
          agent_address: agentAddr,
          safe_address: null,
          service_id: null,
          mech_address: null,
          staking_address: null,
          step: 'awaiting_stake',
          error: null,
          agent_id: null,
          agent_uri: null,
          identity_registry_address: null,
          agent_registered_tx: null,
          safe_bound_to_agent: false,
        },
      ],
    };
    await store.save(state);

    const bootstrapper = new FleetBootstrapper({
      earningDir,
      chain: 'base-sepolia',
      rpcUrl: 'http://127.0.0.1:8545',
      stakingMode: 'standard',
      autoTestnetFaucet: false,
    });

    // mapAgentInstanceOperators returns zero address (no operator bound).
    const readContractSpy = vi.spyOn((bootstrapper as any).publicClient, 'readContract').mockImplementation(
      async ({ functionName }: { functionName: string }) => {
        if (functionName === 'mapAgentInstanceOperators') {
          return '0x0000000000000000000000000000000000000000';
        }
        return 0n;
      },
    );

    // Stub the preflight. Short-circuit the actual stake submission by making
    // the preflight throw a sentinel error AFTER the guard — so we can prove
    // the guard ran to completion without enabling full tx flow on the mock.
    let preflightReached = false;
    vi.spyOn(bootstrapper as any, 'stolasPreflightCheck').mockImplementation(async () => {
      preflightReached = true;
      throw new Error('stolasPreflightCheck-sentinel');
    });

    let thrown: unknown;
    try {
      await (bootstrapper as any).stepStolasStake(state, mnemonic, 1);
    } catch (err) {
      thrown = err;
    }

    // The guard ran (proved by the operator read) and did NOT throw
    // agent_already_bound. stepStolasStake then advanced into the preflight
    // (our sentinel), proving we got past the guard.
    const operatorReads = readContractSpy.mock.calls.filter(
      ([args]: any[]) => args?.functionName === 'mapAgentInstanceOperators',
    );
    expect(operatorReads.length).toBeGreaterThan(0);
    expect(preflightReached).toBe(true);
    expect((thrown as Error | undefined)?.message ?? '').not.toContain('agent_already_bound');
    expect((thrown as Error | undefined)?.message ?? '').toContain('stolasPreflightCheck-sentinel');
  });
});

describe('computeRequiredMasterEth (single source of truth for the cold-start gate)', () => {
  const MIN_ETH = 5_000_000_000_000_000n; // 0.005 ETH
  const STAGE1_AGENT_ETH = 10_000_000_000_000_000n; // 0.01 ETH
  // Stage 1 gate for N services: STAGE1_AGENT_ETH + minEoaGasEth*2 (cold-start
  // multiplier) + minEoaGasEth*(N-1) per-extra-service transfers.
  const stage1Gate = (n: number) =>
    STAGE1_AGENT_ETH + MIN_ETH * 2n + MIN_ETH * BigInt(Math.max(0, n - 1));
  // Stage 2 gate for N services: minEoaGasEth + minEoaGasEth*(N-1).
  const stage2Gate = (n: number) => MIN_ETH + MIN_ETH * BigInt(Math.max(0, n - 1));

  it('returns the Stage 1 gate for a fresh pre-Stage-1 fleet (empty services)', () => {
    const required = computeRequiredMasterEth({
      services: [],
      minEoaGasEth: MIN_ETH,
      preStage1: true,
    });
    expect(required).toBe(stage1Gate(1));
  });

  it('returns the Stage 2 gate for a post-Stage-1 fleet with no operational services', () => {
    const required = computeRequiredMasterEth({
      services: [{ service_id: null, step: 'awaiting_stake' }],
      minEoaGasEth: MIN_ETH,
      preStage1: false,
    });
    expect(required).toBe(stage2Gate(1));
  });

  it('returns 0n when the fleet is already complete (no pending setup migration)', () => {
    const required = computeRequiredMasterEth({
      services: [{ service_id: 42, step: 'complete' }],
      minEoaGasEth: MIN_ETH,
      targetServices: 1,
      pendingSetupMigration: false,
    });
    expect(required).toBe(0n);
  });

  it('does NOT short-circuit to 0n for a migration-wiped fleet even when every service is operational', () => {
    // The GAP-1 bug: funding-plan.ts omitted this guard, so a migration-wiped
    // fleet whose services were all `complete` returned 0n there while the
    // bootstrapper still required funding. With the reconciled guard, the
    // pendingSetupMigration flag suppresses the `alreadyComplete` short-circuit.
    const required = computeRequiredMasterEth({
      services: [{ service_id: 42, step: 'complete' }],
      minEoaGasEth: MIN_ETH,
      targetServices: 1,
      pendingSetupMigration: true,
      preStage1: false,
    });
    expect(required).toBe(stage2Gate(1));
    expect(required).not.toBe(0n);
  });

  it('requires every service operational before short-circuiting to 0n', () => {
    // Strictest of the three historic variants: a fleet with one complete and
    // one in-progress service is NOT already-complete even if the operational
    // count alone would clear targetServices.
    const required = computeRequiredMasterEth({
      services: [
        { service_id: 1, step: 'complete' },
        { service_id: 2, step: 'staked' },
      ],
      minEoaGasEth: MIN_ETH,
      targetServices: 1,
      preStage1: false,
    });
    expect(required).not.toBe(0n);
  });

  it('scales the Stage 2 gate with per-extra-service top-ups', () => {
    const required = computeRequiredMasterEth({
      services: [],
      minEoaGasEth: MIN_ETH,
      targetServices: 3,
      preStage1: false,
    });
    expect(required).toBe(stage2Gate(3));
  });

  it('uses a flat per-service budget for self-bond mode', () => {
    const SELF_BOND_PER_SERVICE = 30_000_000_000_000_000n; // 0.03 ETH
    const required = computeRequiredMasterEth({
      services: [],
      minEoaGasEth: MIN_ETH,
      targetServices: 2,
      stakingMode: 'self-bond',
    });
    expect(required).toBe(SELF_BOND_PER_SERVICE * 2n);
  });
});

describe('structured error envelope (jinn-mono-hjex.6)', () => {
  const dirs: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  /**
   * Helper: install mocks that satisfy ensureStage1 + the post-Stage-1
   * `getBalance` re-check, so the test's `bootstrapService` mock is the
   * first thing that can throw inside `ensureStage1And2`.
   *
   * After the u34i/wkbw rebase ensureStage1 calls getCode() + ensureStage1
   * runs a real flow that the unit-level tests can't satisfy without a
   * network. Stubbing ensureStage1 to a clean ok-result is the smallest
   * fixture that keeps the post-rebase `category`/`txHash` assertions
   * meaningful.
   */
  function stubEnsureStage1AndBalance(bootstrapper: FleetBootstrapper): void {
    // Empty services so ensureStage1And2's "create new" loop calls
    // bootstrapService for service 1 — that's the test's mock target.
    const stubState = {
      master_address: '0x000000000000000000000000000000000000dEaD',
      fleet_stage: 'stage1' as const,
      services: [] as any[],
    };
    vi.spyOn(bootstrapper as any, 'ensureStage1').mockResolvedValue({
      ok: true,
      fleet_state: stubState,
      message: 'stage1 stubbed',
    });
    vi.spyOn((bootstrapper as any).publicClient, 'getBalance').mockResolvedValue(
      100_000_000_000_000_000n,
    );
    // Phase 2 calls loadExistingMnemonic → decryptMnemonic. Bypass with a
    // canonical test mnemonic; the test never spends from it.
    vi.spyOn(bootstrapper as any, 'loadExistingMnemonic').mockResolvedValue(
      'test test test test test test test test test test test junk',
    );
    // Skip the reconcile branch; it would otherwise read chain state.
    vi.spyOn(bootstrapper as any, 'reconcileFleetWithChain').mockImplementation(
      async (state: any) => state,
    );
    vi.spyOn((bootstrapper as any).store, 'patchFleet').mockImplementation(async () => stubState);
  }

  it('returns errorCategory: insufficient_funds when bootstrap fails with an EVM insufficient-funds error', async () => {
    const earningDir = await mkdtemp(path.join(os.tmpdir(), 'jinn-fleet-hjex6-'));
    dirs.push(earningDir);

    const bootstrapper = new FleetBootstrapper({
      earningDir,
      chain: 'base',
      rpcUrl: 'http://127.0.0.1:8545',
      stakingMode: 'standard',
    });
    stubEnsureStage1AndBalance(bootstrapper);

    // Simulate an EVM "insufficient funds for gas" revert during service creation.
    vi.spyOn(bootstrapper as any, 'bootstrapService').mockRejectedValue(
      new Error('insufficient funds for gas * price + value: have 0 want 1000000000000000'),
    );

    const result = await bootstrapper.bootstrap('test-password');

    expect(result.ok).toBe(false);
    expect(result.errorCategory).toBe('insufficient_funds');
    // The funding gate must NOT be set — this is an exception, not an early-return.
    expect(result.funding).toBeUndefined();
  });

  it('returns errorCategory: gas_too_low when bootstrap fails with an out-of-gas error', async () => {
    const earningDir = await mkdtemp(path.join(os.tmpdir(), 'jinn-fleet-hjex6-oog-'));
    dirs.push(earningDir);

    const bootstrapper = new FleetBootstrapper({
      earningDir,
      chain: 'base',
      rpcUrl: 'http://127.0.0.1:8545',
      stakingMode: 'standard',
    });
    stubEnsureStage1AndBalance(bootstrapper);

    vi.spyOn(bootstrapper as any, 'bootstrapService').mockRejectedValue(
      new Error('execution reverted: out of gas while creating contract'),
    );

    const result = await bootstrapper.bootstrap('test-password');

    expect(result.ok).toBe(false);
    expect(result.errorCategory).toBe('gas_too_low');
  });

  it('does not set errorCategory for unclassified errors', async () => {
    const earningDir = await mkdtemp(path.join(os.tmpdir(), 'jinn-fleet-hjex6-unclassified-'));
    dirs.push(earningDir);

    const bootstrapper = new FleetBootstrapper({
      earningDir,
      chain: 'base',
      rpcUrl: 'http://127.0.0.1:8545',
      stakingMode: 'standard',
    });
    stubEnsureStage1AndBalance(bootstrapper);

    vi.spyOn(bootstrapper as any, 'bootstrapService').mockRejectedValue(
      new Error('some completely unrecognized blockchain error'),
    );

    const result = await bootstrapper.bootstrap('test-password');

    expect(result.ok).toBe(false);
    expect(result.errorCategory).toBeUndefined();
  });

  it('surfaces txHash in result when a contract-revert path embeds it in the error message', async () => {
    const earningDir = await mkdtemp(path.join(os.tmpdir(), 'jinn-fleet-hjex6-txhash-'));
    dirs.push(earningDir);

    const expectedTxHash = '0x' + 'ab'.repeat(32);

    const bootstrapper = new FleetBootstrapper({
      earningDir,
      chain: 'base',
      rpcUrl: 'http://127.0.0.1:8545',
      stakingMode: 'standard',
    });
    stubEnsureStage1AndBalance(bootstrapper);

    // Simulate an on-chain revert that embeds the tx hash in the message,
    // matching the pattern thrown by stepStakeService / stepSelfBond* paths.
    vi.spyOn(bootstrapper as any, 'bootstrapService').mockRejectedValue(
      new Error(`stOLAS stake() tx failed for service 1: ${expectedTxHash}`),
    );

    const result = await bootstrapper.bootstrap('test-password');

    expect(result.ok).toBe(false);
    expect(result.txHash).toBe(expectedTxHash);
  });

  it('does not set txHash when the error message has no embedded tx hash', async () => {
    const earningDir = await mkdtemp(path.join(os.tmpdir(), 'jinn-fleet-hjex6-notxhash-'));
    dirs.push(earningDir);

    const bootstrapper = new FleetBootstrapper({
      earningDir,
      chain: 'base',
      rpcUrl: 'http://127.0.0.1:8545',
      stakingMode: 'standard',
    });
    stubEnsureStage1AndBalance(bootstrapper);

    vi.spyOn(bootstrapper as any, 'bootstrapService').mockRejectedValue(
      new Error('RPC connection refused'),
    );

    const result = await bootstrapper.bootstrap('test-password');

    expect(result.ok).toBe(false);
    expect(result.txHash).toBeUndefined();
  });
});
