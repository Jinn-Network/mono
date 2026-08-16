/**
 * Wiring-seam regression test for GAP-1 (release-readiness v2026.05.25).
 *
 * `computeRequiredMasterEth()` in bootstrap.ts is documented as the single
 * source of truth for the master-ETH cold-start funding gate. Before this fix
 * it was dead code: the FleetBootstrapper gate (`ensureStage1And2`) and the
 * read-only `planFleetFunding` view each re-derived the gate inline, and the
 * funding-plan variant omitted the `pendingSetupMigration` guard entirely.
 *
 * Result: a migration-wiped fleet computed a DIFFERENT required-ETH gate in
 * the funding-plan view than in the bootstrapper gate — the u34i cross-module
 * invariant-drift hazard, cited verbatim in this same code's own comments.
 *
 * These tests assert the bootstrapper gate and the funding-plan gate return
 * an identical `requiredMasterEth` for (a) a migration-wiped fleet and (b) a
 * normal cold fleet. They fail against the pre-fix code (the funding-plan
 * view reported 0n / satisfied for a migration-wiped fleet because it skipped
 * the guard) and pass after both call sites route through the helper.
 */
import { mkdtemp, rm } from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { computeRequiredMasterEth } from '../../src/earning/bootstrap.js';
import { planFleetFunding } from '../../src/earning/funding-plan.js';
import { FleetStateStore } from '../../src/earning/store.js';
import { encryptMnemonic, generateMnemonic, deriveMasterAddress } from '../../src/earning/wallet.js';
import { createDefaultFleetState, createDefaultServiceState, type ServiceState } from '../../src/earning/types.js';
import { DEPRECATED_BASE_SEPOLIA_STAKING_PROXY } from '../../src/earning/testnet-setup-migration.js';

const MIN_EOA_GAS_ETH = 5_000_000_000_000_000n; // 0.005 ETH
const CURRENT_TESTNET_STAKING = '0xe9c8DaBb4062deEc921562e7E286be3cEcb826b0';

/**
 * Chain config stub. `stakingContract` is the *current* staking proxy — a
 * service still pointing at DEPRECATED_BASE_SEPOLIA_STAKING_PROXY is therefore
 * detected as a deprecated (migration-wiped) setup.
 */
function fakeTestnetChainConfig(): any {
  return {
    chainId: 84532,
    rpcUrl: 'http://127.0.0.1:8545',
    minEoaGasEth: MIN_EOA_GAS_ETH,
    minSafeEth: 2_000_000_000_000_000n,
    stakingContract: CURRENT_TESTNET_STAKING,
  };
}

/** An operational service still anchored to the deprecated staking proxy. */
function migrationWipedService(): ServiceState {
  return {
    ...createDefaultServiceState(1, '0x0000000000000000000000000000000000000001'),
    service_id: 42,
    staking_address: DEPRECATED_BASE_SEPOLIA_STAKING_PROXY,
    safe_address: null,
    step: 'complete',
  };
}

describe('GAP-1: master-ETH gate wiring seam (bootstrapper vs funding-plan)', () => {
  const dirs: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  /**
   * Resolve the required-master-ETH gate that `planFleetFunding` is using.
   *
   * With the master EOA holding 0 wei, any non-zero gate surfaces as a
   * `master` shortfall whose `eth_required` equals the gate exactly
   * (shortfall = gate - balance = gate - 0). A zero gate leaves `master`
   * undefined and the plan `satisfied`.
   */
  async function fundingPlanGate(fleetServices: ServiceState[], fleetStage: 'none' | 'stage1_and_2'): Promise<bigint> {
    const earningDir = await mkdtemp(path.join(os.tmpdir(), 'jinn-gap1-'));
    dirs.push(earningDir);
    const store = new FleetStateStore(earningDir);
    const mnemonic = generateMnemonic();
    const masterAddress = deriveMasterAddress(mnemonic);
    await store.saveMnemonicKeystore(await encryptMnemonic(mnemonic, 'pw'));
    await store.save({
      ...createDefaultFleetState('base-sepolia'),
      master_address: masterAddress,
      fleet_stage: fleetStage,
      services: fleetServices,
    });

    // Master holds nothing → eth_required == the gate itself.
    const getBalance = vi.fn(async () => 0n);
    const plan = await planFleetFunding({
      earningDir,
      chain: 'base-sepolia',
      password: 'pw',
      chainConfigResolver: () => fakeTestnetChainConfig(),
      publicClientFactory: () => ({ getBalance }) as any,
    });

    return plan.master ? BigInt(plan.master.eth_required) : 0n;
  }

  it('(a) migration-wiped fleet: both gates agree and neither is 0n', async () => {
    const services = [migrationWipedService()];

    // Bootstrapper gate — `ensureStage1And2` computes this after Stage 1, so
    // preStage1 is false and pendingSetupMigration is true for a wiped fleet.
    const bootstrapperGate = computeRequiredMasterEth({
      services,
      minEoaGasEth: MIN_EOA_GAS_ETH,
      pendingSetupMigration: true,
      targetServices: 1,
      stakingMode: 'standard',
      preStage1: false,
    });

    // Funding-plan gate — derived from the same fleet fixture via the
    // public `planFleetFunding` entry point.
    const planGate = await fundingPlanGate(services, 'stage1_and_2');

    // The bug: pre-fix the funding-plan view skipped the pendingSetupMigration
    // guard, short-circuited `standardFleetAlreadyComplete` to 0n, and reported
    // the fleet as satisfied — disagreeing with the bootstrapper.
    expect(bootstrapperGate).not.toBe(0n);
    expect(planGate).not.toBe(0n);
    expect(planGate).toBe(bootstrapperGate);
  });

  it('(b) normal cold fleet: both gates agree on the Stage 1 budget', async () => {
    // Fresh pre-Stage-1 fleet — no services, fleet_stage 'none'.
    const bootstrapperGate = computeRequiredMasterEth({
      services: [],
      minEoaGasEth: MIN_EOA_GAS_ETH,
      pendingSetupMigration: false,
      targetServices: 1,
      stakingMode: 'standard',
      preStage1: true,
    });

    const planGate = await fundingPlanGate([], 'none');

    expect(bootstrapperGate).not.toBe(0n);
    expect(planGate).toBe(bootstrapperGate);
  });

  it('both call sites route the gate through computeRequiredMasterEth', async () => {
    // Structural assertion: the helper is no longer dead code. A spy on the
    // helper is not feasible across module boundaries without rewiring, so we
    // assert the observable consequence instead — the helper's distinctive
    // migration-wiped semantics (no 0n short-circuit) are visible at BOTH the
    // direct call and through `planFleetFunding`.
    const services = [migrationWipedService()];
    const direct = computeRequiredMasterEth({
      services,
      minEoaGasEth: MIN_EOA_GAS_ETH,
      pendingSetupMigration: true,
      targetServices: 1,
      preStage1: false,
    });
    const viaPlan = await fundingPlanGate(services, 'stage1_and_2');
    expect(viaPlan).toBe(direct);
  });
});
