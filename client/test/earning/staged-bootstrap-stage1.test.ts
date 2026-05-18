import { mkdtemp, rm } from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FleetBootstrapper } from '../../src/earning/bootstrap.js';
import { FleetStateStore } from '../../src/earning/store.js';
import {
  generateMnemonic,
  encryptMnemonic,
  deriveAgentAddress,
} from '../../src/earning/wallet.js';

const PREDICTED_SAFE = '0xBBBB000000000000000000000000000000000001';
const FLEET_AGENT_ID = '1234';
const IDENTITY_REGISTRY = '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432';

function buildBootstrapper(earningDir: string): FleetBootstrapper {
  return new FleetBootstrapper({
    earningDir,
    chain: 'base',
    rpcUrl: 'http://127.0.0.1:8545',
    stakingMode: 'standard',
  });
}

describe('FleetBootstrapper.ensureStage1 — greenfield walk (nghf)', () => {
  const dirs: string[] = [];

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  it('pauses at ETH funding when agent EOA balance is 0 (no OLAS required)', async () => {
    const earningDir = await mkdtemp(path.join(os.tmpdir(), 'jinn-nghf-stage1-'));
    dirs.push(earningDir);

    const bootstrapper = buildBootstrapper(earningDir);

    // 0 balance on every getBalance call (master + agent EOA).
    vi.spyOn((bootstrapper as any).publicClient, 'getBalance').mockResolvedValue(0n);

    const result = await bootstrapper.ensureStage1('test-password');

    expect(result.ok).toBe(false);
    expect(result.funding).toBeDefined();
    // Stage 1 funding gate is ETH-only.
    expect(result.message.toLowerCase()).toContain('eth');
    expect(result.fleet_state.fleet_stage).toBe('none');
    expect(result.fleet_state.services).toEqual([]);
  });

  it('walks wallet → predict Safe → deploy Safe → mint → bind, ending at fleet_stage="stage1"', async () => {
    const earningDir = await mkdtemp(path.join(os.tmpdir(), 'jinn-nghf-stage1-'));
    dirs.push(earningDir);

    const mnemonic = generateMnemonic();
    const encrypted = await encryptMnemonic(mnemonic, 'test-password');
    const store = new FleetStateStore(earningDir);
    await store.saveMnemonicKeystore(encrypted);

    const bootstrapper = buildBootstrapper(earningDir);

    // Sufficient ETH balance for Stage 1.
    vi.spyOn((bootstrapper as any).publicClient, 'getBalance').mockResolvedValue(
      50_000_000_000_000_000n, // 0.05 ETH
    );
    // Safe code lookup returns "0x" (not yet deployed) on the first call,
    // and bytecode after stepFleetSafeDeploy ran.
    let safeDeployed = false;
    vi.spyOn((bootstrapper as any).publicClient, 'getCode').mockImplementation(async () =>
      safeDeployed ? '0xdeadbeef' : '0x',
    );

    vi.spyOn(bootstrapper as any, 'stepFleetSafePredict').mockImplementation(async () => {
      await store.patchFleet({ fleet_safe_address: PREDICTED_SAFE });
      return store.load('base');
    });
    vi.spyOn(bootstrapper as any, 'stepFleetSafeDeploy').mockImplementation(async () => {
      safeDeployed = true;
      return store.load('base');
    });
    vi.spyOn(bootstrapper as any, 'stepFleetIdentityRegister').mockImplementation(async () => {
      await store.patchFleet({
        fleet_agent_id: FLEET_AGENT_ID,
        fleet_identity_registry: IDENTITY_REGISTRY,
        fleet_stage: 'stage1',
      });
      return store.load('base');
    });

    const result = await bootstrapper.ensureStage1('test-password');

    expect(result.ok).toBe(true);
    expect(result.fleet_state.fleet_stage).toBe('stage1');
    expect(result.fleet_state.fleet_agent_id).toBe(FLEET_AGENT_ID);
    expect(result.fleet_state.fleet_safe_address).toBe(PREDICTED_SAFE);
    expect(result.fleet_state.fleet_identity_registry).toBe(IDENTITY_REGISTRY);
    // No service rows created by Stage 1.
    expect(result.fleet_state.services).toEqual([]);

    // Predict + deploy + register each called exactly once.
    expect((bootstrapper as any).stepFleetSafePredict).toHaveBeenCalledTimes(1);
    expect((bootstrapper as any).stepFleetSafeDeploy).toHaveBeenCalledTimes(1);
    expect((bootstrapper as any).stepFleetIdentityRegister).toHaveBeenCalledTimes(1);
  });

  it('is idempotent — re-running ensureStage1 after stage1 is complete is a no-op', async () => {
    const earningDir = await mkdtemp(path.join(os.tmpdir(), 'jinn-nghf-stage1-'));
    dirs.push(earningDir);

    const mnemonic = generateMnemonic();
    const encrypted = await encryptMnemonic(mnemonic, 'test-password');
    const store = new FleetStateStore(earningDir);
    await store.saveMnemonicKeystore(encrypted);
    await store.patchFleet({
      fleet_agent_id: FLEET_AGENT_ID,
      fleet_safe_address: PREDICTED_SAFE,
      fleet_identity_registry: IDENTITY_REGISTRY,
      fleet_stage: 'stage1',
    });

    const bootstrapper = buildBootstrapper(earningDir);
    vi.spyOn((bootstrapper as any).publicClient, 'getBalance').mockResolvedValue(
      50_000_000_000_000_000n,
    );
    vi.spyOn((bootstrapper as any).publicClient, 'getCode').mockResolvedValue('0xdeadbeef');

    const predictSpy = vi.spyOn(bootstrapper as any, 'stepFleetSafePredict');
    const deploySpy = vi.spyOn(bootstrapper as any, 'stepFleetSafeDeploy');
    const registerSpy = vi.spyOn(bootstrapper as any, 'stepFleetIdentityRegister');

    const result = await bootstrapper.ensureStage1('test-password');

    expect(result.ok).toBe(true);
    expect(result.fleet_state.fleet_stage).toBe('stage1');
    expect(predictSpy).not.toHaveBeenCalled();
    expect(deploySpy).not.toHaveBeenCalled();
    expect(registerSpy).not.toHaveBeenCalled();
  });

  it('resumes from mid-Stage-1 (Safe predicted but not deployed)', async () => {
    const earningDir = await mkdtemp(path.join(os.tmpdir(), 'jinn-nghf-stage1-'));
    dirs.push(earningDir);

    const mnemonic = generateMnemonic();
    const encrypted = await encryptMnemonic(mnemonic, 'test-password');
    const store = new FleetStateStore(earningDir);
    await store.saveMnemonicKeystore(encrypted);
    await store.patchFleet({
      fleet_safe_address: PREDICTED_SAFE,
      fleet_stage: 'none',
    });

    const bootstrapper = buildBootstrapper(earningDir);
    vi.spyOn((bootstrapper as any).publicClient, 'getBalance').mockResolvedValue(
      50_000_000_000_000_000n,
    );
    vi.spyOn((bootstrapper as any).publicClient, 'getCode').mockResolvedValue('0x'); // not deployed

    const predictSpy = vi.spyOn(bootstrapper as any, 'stepFleetSafePredict');
    vi.spyOn(bootstrapper as any, 'stepFleetSafeDeploy').mockImplementation(async () => store.load('base'));
    vi.spyOn(bootstrapper as any, 'stepFleetIdentityRegister').mockImplementation(async () => {
      await store.patchFleet({
        fleet_agent_id: FLEET_AGENT_ID,
        fleet_identity_registry: IDENTITY_REGISTRY,
        fleet_stage: 'stage1',
      });
      return store.load('base');
    });

    const result = await bootstrapper.ensureStage1('test-password');

    expect(result.ok).toBe(true);
    expect(result.fleet_state.fleet_stage).toBe('stage1');
    // Predict was skipped (already had fleet_safe_address).
    expect(predictSpy).not.toHaveBeenCalled();
    expect((bootstrapper as any).stepFleetSafeDeploy).toHaveBeenCalledTimes(1);
    expect((bootstrapper as any).stepFleetIdentityRegister).toHaveBeenCalledTimes(1);
  });

  it('rejects funding at the gate when master has exactly the old (pre-u34i) threshold but not enough for transfer + gas (jinn-mono-u34i)', async () => {
    const earningDir = await mkdtemp(path.join(os.tmpdir(), 'jinn-u34i-stage1-'));
    dirs.push(earningDir);
    const bootstrapper = buildBootstrapper(earningDir);
    // 0.011 ETH on the master — above the OLD 0.01 ETH gate, below the NEW
    // STAGE1_AGENT_ETH + minEoaGasEth = 0.015 ETH gate. Pre-fix this would
    // pass the gate and then revert in the funding tx with
    // "gas required exceeds allowance (0)".
    vi.spyOn((bootstrapper as any).publicClient, 'getBalance').mockResolvedValue(
      11_000_000_000_000_000n, // 0.011 ETH
    );
    const result = await bootstrapper.ensureStage1('test-password');
    expect(result.ok).toBe(false);
    expect(result.funding).toBeDefined();
    expect(result.message.toLowerCase()).toContain('eth');
    expect(result.fleet_state.fleet_stage).toBe('none');
  });

  it('accepts funding when master has STAGE1_AGENT_ETH + minEoaGasEth = 0.015 ETH (jinn-mono-u34i)', async () => {
    const earningDir = await mkdtemp(path.join(os.tmpdir(), 'jinn-u34i-stage1-'));
    dirs.push(earningDir);

    const mnemonic = generateMnemonic();
    const encrypted = await encryptMnemonic(mnemonic, 'test-password');
    const store = new FleetStateStore(earningDir);
    await store.saveMnemonicKeystore(encrypted);

    const bootstrapper = buildBootstrapper(earningDir);

    // Exactly 0.015 ETH — the new gate's minimum. Pre-fix this would have
    // sailed past the old 0.01 ETH gate too, but the funding tx (transfer
    // 0.01 ETH + gas) had no headroom. With the new gate, this is the
    // minimum balance that should allow Stage 1 to proceed.
    vi.spyOn((bootstrapper as any).publicClient, 'getBalance').mockResolvedValue(
      15_000_000_000_000_000n, // 0.015 ETH
    );
    let safeDeployed = false;
    vi.spyOn((bootstrapper as any).publicClient, 'getCode').mockImplementation(async () =>
      safeDeployed ? '0xdeadbeef' : '0x',
    );
    vi.spyOn(bootstrapper as any, 'stepFleetSafePredict').mockImplementation(async () => {
      await store.patchFleet({ fleet_safe_address: PREDICTED_SAFE });
      return store.load('base');
    });
    vi.spyOn(bootstrapper as any, 'stepFleetSafeDeploy').mockImplementation(async () => {
      safeDeployed = true;
      return store.load('base');
    });
    vi.spyOn(bootstrapper as any, 'stepFleetIdentityRegister').mockImplementation(async () => {
      await store.patchFleet({
        fleet_agent_id: FLEET_AGENT_ID,
        fleet_identity_registry: IDENTITY_REGISTRY,
        fleet_stage: 'stage1',
      });
      return store.load('base');
    });

    const result = await bootstrapper.ensureStage1('test-password');

    expect(result.ok).toBe(true);
    expect(result.fleet_state.fleet_stage).toBe('stage1');
  });

  it('Stage 1 ignores OLAS balances entirely', async () => {
    const earningDir = await mkdtemp(path.join(os.tmpdir(), 'jinn-nghf-stage1-'));
    dirs.push(earningDir);

    const mnemonic = generateMnemonic();
    const encrypted = await encryptMnemonic(mnemonic, 'test-password');
    const store = new FleetStateStore(earningDir);
    await store.saveMnemonicKeystore(encrypted);

    const bootstrapper = buildBootstrapper(earningDir);
    // Plenty of ETH everywhere.
    vi.spyOn((bootstrapper as any).publicClient, 'getBalance').mockResolvedValue(
      50_000_000_000_000_000n,
    );
    // Safe code: "0x" first call (predict), bytecode after deploy.
    let safeDeployed = false;
    vi.spyOn((bootstrapper as any).publicClient, 'getCode').mockImplementation(async () =>
      safeDeployed ? '0xdeadbeef' : '0x',
    );

    // The contract surface that would read OLAS balance: getBondTokenBalance.
    // Spy on it; assert it is NEVER called from ensureStage1.
    const olasSpy = vi
      .spyOn(bootstrapper as any, 'getBondTokenBalance')
      .mockResolvedValue(0n);

    vi.spyOn(bootstrapper as any, 'stepFleetSafePredict').mockImplementation(async () => {
      await store.patchFleet({ fleet_safe_address: PREDICTED_SAFE });
      return store.load('base');
    });
    vi.spyOn(bootstrapper as any, 'stepFleetSafeDeploy').mockImplementation(async () => {
      safeDeployed = true;
      return store.load('base');
    });
    vi.spyOn(bootstrapper as any, 'stepFleetIdentityRegister').mockImplementation(async () => {
      await store.patchFleet({
        fleet_agent_id: FLEET_AGENT_ID,
        fleet_identity_registry: IDENTITY_REGISTRY,
        fleet_stage: 'stage1',
      });
      return store.load('base');
    });

    const result = await bootstrapper.ensureStage1('test-password');

    expect(result.ok).toBe(true);
    expect(result.fleet_state.fleet_stage).toBe('stage1');
    expect(olasSpy).not.toHaveBeenCalled();
  });
});
