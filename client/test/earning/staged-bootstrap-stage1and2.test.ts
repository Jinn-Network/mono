import { mkdtemp, rm } from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FleetBootstrapper } from '../../src/earning/bootstrap.js';
import { FleetStateStore } from '../../src/earning/store.js';
import {
  generateMnemonic,
  encryptMnemonic,
  deriveMasterAddress,
  deriveAgentAddress,
} from '../../src/earning/wallet.js';
import { createDefaultFleetState } from '../../src/earning/types.js';

const FLEET_SAFE = '0xFFFF000000000000000000000000000000000001';
const FLEET_AGENT_ID = '7777';
const STAKING_SAFE = '0xAAAA000000000000000000000000000000000002';
const IDENTITY_REGISTRY = '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432';

describe('FleetBootstrapper.ensureStage1And2 — combined walk (nghf)', () => {
  const dirs: string[] = [];

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  it('clean state — walks Stage 1, then Stage 2; standard mode produces two distinct Safes', async () => {
    const earningDir = await mkdtemp(path.join(os.tmpdir(), 'jinn-nghf-full-'));
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

    vi.spyOn((bootstrapper as any).publicClient, 'getBalance').mockResolvedValue(
      100_000_000_000_000_000n, // 0.1 ETH
    );
    vi.spyOn((bootstrapper as any).publicClient, 'getCode').mockResolvedValue('0xdeadbeef');

    // Stage 1 mocks.
    vi.spyOn(bootstrapper as any, 'stepFleetSafePredict').mockImplementation(async () => {
      await store.patchFleet({ fleet_safe_address: FLEET_SAFE });
      return store.load('base');
    });
    vi.spyOn(bootstrapper as any, 'stepFleetSafeDeploy').mockImplementation(async () =>
      store.load('base'),
    );
    vi.spyOn(bootstrapper as any, 'stepFleetIdentityRegister').mockImplementation(async () => {
      await store.patchFleet({
        fleet_agent_id: FLEET_AGENT_ID,
        fleet_identity_registry: IDENTITY_REGISTRY,
        fleet_stage: 'stage1',
      });
      return store.load('base');
    });

    // Stage 2 mocks — standard mode produces a separate staking Safe.
    vi.spyOn(bootstrapper as any, 'stepStolasStake').mockImplementation(
      async (_s: any, _m: any, index: number) =>
        store.updateService(index, {
          safe_address: STAKING_SAFE,
          service_id: 99,
          staking_address: '0x0000000000000000000000000000000000000003',
          step: 'staked',
        }),
    );
    vi.spyOn(bootstrapper as any, 'stepDeployMech').mockImplementation(
      async (_s: any, _m: any, index: number) =>
        store.updateService(index, {
          mech_address: '0x0000000000000000000000000000000000000004',
          step: 'mech_deployed',
        }),
    );
    vi.spyOn(bootstrapper as any, 'stepRegisterAgent').mockImplementation(
      async (_s: any, _m: any, index: number) => {
        // Reuse fleet identity on the service row (Task 8 enforces this).
        const fleet = await store.load('base');
        await store.updateService(index, {
          agent_id: fleet.fleet_agent_id,
          identity_registry_address: fleet.fleet_identity_registry,
          step: 'complete',
          safe_bound_to_agent: true,
        });
        return store.load('base');
      },
    );

    const result = await bootstrapper.ensureStage1And2('test-password');

    expect(result.ok).toBe(true);
    expect(result.fleet_state.fleet_stage).toBe('stage1_and_2');
    expect(result.fleet_state.fleet_agent_id).toBe(FLEET_AGENT_ID);
    expect(result.fleet_state.fleet_safe_address).toBe(FLEET_SAFE);
    expect(result.fleet_state.services).toHaveLength(1);

    const svc = result.fleet_state.services[0]!;
    // Two-Safe topology in standard mode.
    expect(svc.safe_address).toBe(STAKING_SAFE);
    expect(result.fleet_state.fleet_safe_address).not.toBe(svc.safe_address);
    // Same agentId reused across fleet and service.
    expect(svc.agent_id).toBe(result.fleet_state.fleet_agent_id);
  });

  it('migrated operator — existing services[0].agent_id is promoted; no new Safe deploy', async () => {
    const earningDir = await mkdtemp(path.join(os.tmpdir(), 'jinn-nghf-full-'));
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
          safe_address: STAKING_SAFE,
          service_id: 42,
          mech_address: '0xCCCC000000000000000000000000000000000001',
          staking_address: '0xDDDD000000000000000000000000000000000001',
          step: 'complete',
          error: null,
          agent_id: '321',
          agent_uri: '',
          identity_registry_address: IDENTITY_REGISTRY,
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

    vi.spyOn((bootstrapper as any).publicClient, 'getBalance').mockResolvedValue(
      10_000_000_000_000_000n,
    );
    vi.spyOn((bootstrapper as any).publicClient, 'getCode').mockResolvedValue('0xdeadbeef');

    const predictSpy = vi.spyOn(bootstrapper as any, 'stepFleetSafePredict');
    const deploySpy = vi.spyOn(bootstrapper as any, 'stepFleetSafeDeploy');
    const registerSpy = vi.spyOn(bootstrapper as any, 'stepFleetIdentityRegister');
    vi.spyOn(bootstrapper as any, 'gatherChainSignals').mockResolvedValue({
      stakingState: 1,
      stakingMultisig: STAKING_SAFE,
      registryState: 4,
      registryMultisig: STAKING_SAFE,
      safeDeployed: true,
    });
    vi.spyOn(bootstrapper as any, 'getStakingState').mockResolvedValue(1);

    const result = await bootstrapper.ensureStage1And2('test-password');

    expect(result.ok).toBe(true);
    // Migration ran on load — fleet identity reflects services[0].
    expect(result.fleet_state.fleet_agent_id).toBe('321');
    expect(result.fleet_state.fleet_safe_address).toBe(STAKING_SAFE);
    expect(result.fleet_state.fleet_stage).toBe('stage1_and_2');
    // Stage 1 steps did NOT fire — no re-deploy, no re-mint.
    expect(predictSpy).not.toHaveBeenCalled();
    expect(deploySpy).not.toHaveBeenCalled();
    expect(registerSpy).not.toHaveBeenCalled();
  });

  it('idempotent — re-running ensureStage1And2 on a complete fleet is a no-op', async () => {
    const earningDir = await mkdtemp(path.join(os.tmpdir(), 'jinn-nghf-full-'));
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
      fleet_agent_id: FLEET_AGENT_ID,
      fleet_safe_address: FLEET_SAFE,
      fleet_identity_registry: IDENTITY_REGISTRY,
      fleet_stage: 'stage1_and_2',
      services: [
        {
          index: 1,
          agent_address: agentAddr,
          safe_address: STAKING_SAFE,
          service_id: 42,
          mech_address: '0xCCCC000000000000000000000000000000000001',
          staking_address: '0xDDDD000000000000000000000000000000000001',
          step: 'complete',
          error: null,
          agent_id: FLEET_AGENT_ID,
          agent_uri: '',
          identity_registry_address: IDENTITY_REGISTRY,
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

    vi.spyOn((bootstrapper as any).publicClient, 'getBalance').mockResolvedValue(
      10_000_000_000_000_000n,
    );
    vi.spyOn((bootstrapper as any).publicClient, 'getCode').mockResolvedValue('0xdeadbeef');

    const predictSpy = vi.spyOn(bootstrapper as any, 'stepFleetSafePredict');
    const stakeSpy = vi.spyOn(bootstrapper as any, 'stepStolasStake');
    const mechSpy = vi.spyOn(bootstrapper as any, 'stepDeployMech');
    vi.spyOn(bootstrapper as any, 'gatherChainSignals').mockResolvedValue({
      stakingState: 1,
      stakingMultisig: STAKING_SAFE,
      registryState: 4,
      registryMultisig: STAKING_SAFE,
      safeDeployed: true,
    });
    vi.spyOn(bootstrapper as any, 'getStakingState').mockResolvedValue(1);

    const result = await bootstrapper.ensureStage1And2('test-password');

    expect(result.ok).toBe(true);
    expect(predictSpy).not.toHaveBeenCalled();
    expect(stakeSpy).not.toHaveBeenCalled();
    expect(mechSpy).not.toHaveBeenCalled();
  });

  it('resumes from mid-Stage-2 (existing services advance)', async () => {
    const earningDir = await mkdtemp(path.join(os.tmpdir(), 'jinn-nghf-full-'));
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
      fleet_agent_id: FLEET_AGENT_ID,
      fleet_safe_address: FLEET_SAFE,
      fleet_identity_registry: IDENTITY_REGISTRY,
      fleet_stage: 'stage1',
      services: [
        {
          index: 1,
          agent_address: agentAddr,
          safe_address: STAKING_SAFE,
          service_id: 50,
          mech_address: null,
          staking_address: '0xDDDD000000000000000000000000000000000001',
          step: 'staked',
          error: null,
          agent_id: null,
          agent_uri: null,
          identity_registry_address: null,
          agent_registered_tx: null,
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

    vi.spyOn((bootstrapper as any).publicClient, 'getBalance').mockResolvedValue(
      10_000_000_000_000_000n,
    );
    vi.spyOn((bootstrapper as any).publicClient, 'getCode').mockResolvedValue('0xdeadbeef');

    vi.spyOn(bootstrapper as any, 'gatherChainSignals').mockResolvedValue({
      stakingState: 1,
      stakingMultisig: STAKING_SAFE,
      registryState: 4,
      registryMultisig: STAKING_SAFE,
      safeDeployed: true,
    });
    vi.spyOn(bootstrapper as any, 'getStakingState').mockResolvedValue(1);
    vi.spyOn(bootstrapper as any, 'stepStolasStake');
    vi.spyOn(bootstrapper as any, 'stepDeployMech').mockImplementation(
      async (_s: any, _m: any, index: number) =>
        store.updateService(index, {
          mech_address: '0xCAFE000000000000000000000000000000000001',
          step: 'mech_deployed',
        }),
    );
    vi.spyOn(bootstrapper as any, 'stepRegisterAgent').mockImplementation(
      async (_s: any, _m: any, index: number) => {
        const fleet = await store.load('base');
        await store.updateService(index, {
          agent_id: fleet.fleet_agent_id,
          identity_registry_address: fleet.fleet_identity_registry,
          step: 'complete',
          safe_bound_to_agent: true,
        });
        return store.load('base');
      },
    );

    const result = await bootstrapper.ensureStage1And2('test-password');

    expect(result.ok).toBe(true);
    expect((bootstrapper as any).stepStolasStake).not.toHaveBeenCalled();
    expect((bootstrapper as any).stepDeployMech).toHaveBeenCalledTimes(1);
    expect((bootstrapper as any).stepRegisterAgent).toHaveBeenCalledTimes(1);
    expect(result.fleet_state.services[0]!.step).toBe('complete');
    // Stage marker advances after Stage 2 completes a service.
    expect(result.fleet_state.fleet_stage).toBe('stage1_and_2');
  });

  it('creates the first service row when fleet_stage="stage1" and services is empty', async () => {
    const earningDir = await mkdtemp(path.join(os.tmpdir(), 'jinn-nghf-full-'));
    dirs.push(earningDir);

    const mnemonic = generateMnemonic();
    const encrypted = await encryptMnemonic(mnemonic, 'test-password');
    const store = new FleetStateStore(earningDir);
    await store.saveMnemonicKeystore(encrypted);

    const masterAddr = deriveMasterAddress(mnemonic);
    await store.save({
      ...createDefaultFleetState('base'),
      master_address: masterAddr,
      fleet_agent_id: FLEET_AGENT_ID,
      fleet_safe_address: FLEET_SAFE,
      fleet_identity_registry: IDENTITY_REGISTRY,
      fleet_stage: 'stage1',
      services: [],
    });

    const bootstrapper = new FleetBootstrapper({
      earningDir,
      chain: 'base',
      rpcUrl: 'http://127.0.0.1:8545',
      stakingMode: 'standard',
    });

    vi.spyOn((bootstrapper as any).publicClient, 'getBalance').mockResolvedValue(
      10_000_000_000_000_000n,
    );
    vi.spyOn((bootstrapper as any).publicClient, 'getCode').mockResolvedValue('0xdeadbeef');

    vi.spyOn(bootstrapper as any, 'stepStolasStake').mockImplementation(
      async (_s: any, _m: any, index: number) =>
        store.updateService(index, {
          safe_address: STAKING_SAFE,
          service_id: 80,
          staking_address: '0x0000000000000000000000000000000000000003',
          step: 'staked',
        }),
    );
    vi.spyOn(bootstrapper as any, 'stepDeployMech').mockImplementation(
      async (_s: any, _m: any, index: number) =>
        store.updateService(index, {
          mech_address: '0x000000000000000000000000000000000000aabb',
          step: 'mech_deployed',
        }),
    );
    vi.spyOn(bootstrapper as any, 'stepRegisterAgent').mockImplementation(
      async (_s: any, _m: any, index: number) => {
        const fleet = await store.load('base');
        await store.updateService(index, {
          agent_id: fleet.fleet_agent_id,
          identity_registry_address: fleet.fleet_identity_registry,
          step: 'complete',
          safe_bound_to_agent: true,
        });
        return store.load('base');
      },
    );

    const result = await bootstrapper.ensureStage1And2('test-password');

    expect(result.ok).toBe(true);
    expect(result.fleet_state.services).toHaveLength(1);
    expect(result.fleet_state.services[0]!.step).toBe('complete');
    expect(result.fleet_state.services[0]!.agent_id).toBe(FLEET_AGENT_ID);
    expect(result.fleet_state.fleet_stage).toBe('stage1_and_2');
  });

  // ── Boundary tests for the Stage 2 master ETH gate (jinn-mono-u34i convention) ──
  //
  // The u34i regression (Stage 1 gate == transfer amount → no master gas
  // headroom) was missed because the existing tests mocked balances at 0.05
  // or 0.1 ETH — way above any gate. Boundary tests at gate ± 1 wei catch
  // the class of "did someone bump the transfer without bumping the gate?"
  // bugs that look harmless in 0.05-ETH mocks.
  //
  // The Stage 2 gate fires after ensureStage1 returns ok. With a fresh fleet
  // and standard mode, the gate is `minEoaGasEth * 2 = 0.01 ETH` (line ~467
  // in bootstrap.ts) — covering the per-service transfer (`minEoaGasEth =
  // 0.005 ETH`, line ~1043) plus master's own gas reserve (`minEoaGasEth`).
  //
  // To isolate the Stage 2 gate from Stage 1's, we pre-seed `fleet_stage:
  // 'stage1'` so Stage 1 short-circuits and Stage 2 is the only thing that
  // can reject on funding.
  const STAGE2_FRESH_GATE_WEI = 10_000_000_000_000_000n; // minEoaGasEth (0.005) * 2 = 0.01 ETH

  it('Stage 2 fresh-fleet gate rejects master at gate - 1 wei (jinn-mono-u34i boundary)', async () => {
    const earningDir = await mkdtemp(path.join(os.tmpdir(), 'jinn-u34i-stage2-bound-'));
    dirs.push(earningDir);

    const mnemonic = generateMnemonic();
    const encrypted = await encryptMnemonic(mnemonic, 'test-password');
    const store = new FleetStateStore(earningDir);
    await store.saveMnemonicKeystore(encrypted);

    const masterAddr = deriveMasterAddress(mnemonic);
    await store.save({
      ...createDefaultFleetState('base'),
      master_address: masterAddr,
      // Stage 1 already complete — isolate the Stage 2 gate.
      fleet_agent_id: FLEET_AGENT_ID,
      fleet_safe_address: FLEET_SAFE,
      fleet_identity_registry: IDENTITY_REGISTRY,
      fleet_stage: 'stage1',
      services: [],
    });

    const bootstrapper = new FleetBootstrapper({
      earningDir,
      chain: 'base',
      rpcUrl: 'http://127.0.0.1:8545',
      stakingMode: 'standard',
    });

    // Exactly one wei below the Stage 2 gate.
    vi.spyOn((bootstrapper as any).publicClient, 'getBalance').mockResolvedValue(
      STAGE2_FRESH_GATE_WEI - 1n,
    );
    vi.spyOn((bootstrapper as any).publicClient, 'getCode').mockResolvedValue('0xdeadbeef');

    const result = await bootstrapper.ensureStage1And2('test-password');

    expect(result.ok).toBe(false);
    expect(result.funding).toBeDefined();
    expect(result.funding!.eth_required).toBe('1'); // shortfall is exactly 1 wei
  });

  it('Stage 2 fresh-fleet gate accepts master at gate (jinn-mono-u34i boundary)', async () => {
    const earningDir = await mkdtemp(path.join(os.tmpdir(), 'jinn-u34i-stage2-bound-'));
    dirs.push(earningDir);

    const mnemonic = generateMnemonic();
    const encrypted = await encryptMnemonic(mnemonic, 'test-password');
    const store = new FleetStateStore(earningDir);
    await store.saveMnemonicKeystore(encrypted);

    const masterAddr = deriveMasterAddress(mnemonic);
    await store.save({
      ...createDefaultFleetState('base'),
      master_address: masterAddr,
      fleet_agent_id: FLEET_AGENT_ID,
      fleet_safe_address: FLEET_SAFE,
      fleet_identity_registry: IDENTITY_REGISTRY,
      fleet_stage: 'stage1',
      services: [],
    });

    const bootstrapper = new FleetBootstrapper({
      earningDir,
      chain: 'base',
      rpcUrl: 'http://127.0.0.1:8545',
      stakingMode: 'standard',
    });

    // Exactly the Stage 2 gate (gate uses strict `<`, so >= passes).
    vi.spyOn((bootstrapper as any).publicClient, 'getBalance').mockResolvedValue(
      STAGE2_FRESH_GATE_WEI,
    );
    vi.spyOn((bootstrapper as any).publicClient, 'getCode').mockResolvedValue('0xdeadbeef');

    // Per-service steps are mocked so the gate is the only thing under test.
    vi.spyOn(bootstrapper as any, 'stepStolasStake').mockImplementation(
      async (_s: any, _m: any, index: number) =>
        store.updateService(index, {
          safe_address: STAKING_SAFE,
          service_id: 81,
          staking_address: '0x0000000000000000000000000000000000000003',
          step: 'staked',
        }),
    );
    vi.spyOn(bootstrapper as any, 'stepDeployMech').mockImplementation(
      async (_s: any, _m: any, index: number) =>
        store.updateService(index, {
          mech_address: '0x000000000000000000000000000000000000aabb',
          step: 'mech_deployed',
        }),
    );
    vi.spyOn(bootstrapper as any, 'stepRegisterAgent').mockImplementation(
      async (_s: any, _m: any, index: number) => {
        const fleet = await store.load('base');
        await store.updateService(index, {
          agent_id: fleet.fleet_agent_id,
          identity_registry_address: fleet.fleet_identity_registry,
          step: 'complete',
          safe_bound_to_agent: true,
        });
        return store.load('base');
      },
    );

    const result = await bootstrapper.ensureStage1And2('test-password');

    expect(result.ok).toBe(true);
    expect(result.fleet_state.services).toHaveLength(1);
    expect(result.fleet_state.services[0]!.step).toBe('complete');
  });
});
