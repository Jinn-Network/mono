import { describe, expect, it } from 'vitest';
import {
  reconcileSelfBondService,
  reconcileStandardService,
  reconcileServiceAgainstChain,
  type ServiceChainSignals,
} from '../../src/earning/reconcile.js';
import type { ServiceState } from '../../src/earning/types.js';

const STAKING = '0x51c5f4982b9b0b3c0482678f5847ea6228cc8e54';

function baseSvc(overrides: Partial<ServiceState>): ServiceState {
  return {
    index: 1,
    agent_address: '0x1111111111111111111111111111111111111111',
    safe_address: null,
    service_id: null,
    mech_address: null,
    staking_address: null,
    step: 'awaiting_stake',
    error: null,
    ...overrides,
  };
}

const emptySignals = (over: Partial<ServiceChainSignals> = {}): ServiceChainSignals => ({
  stakingState: 0,
  stakingMultisig: null,
  registryState: 0,
  registryMultisig: null,
  safeDeployed: null,
  ...over,
});

describe('reconcileStandardService', () => {
  it('returns null when staking shows evicted (handled by reStake path)', () => {
    const svc = baseSvc({ service_id: 7, step: 'complete' });
    const r = reconcileStandardService(1, svc, emptySignals({ stakingState: 2 }), {
      stakingContract: STAKING,
    });
    expect(r).toBeNull();
  });

  it('clears identity when staking read reverts (unknown service id)', () => {
    const svc = baseSvc({ service_id: 99, step: 'staked', safe_address: '0x' + '22'.repeat(20) });
    const r = reconcileStandardService(2, svc, emptySignals({ stakingState: 'revert' }), {
      stakingContract: STAKING,
    });
    expect(r?.patch.step).toBe('awaiting_stake');
    expect(r?.patch.service_id).toBeNull();
    expect(r?.message).toContain('unknown to the staking contract');
  });

  it('preserves non-default setup when staking read reverts', () => {
    const svc = baseSvc({
      service_id: 99,
      step: 'complete',
      safe_address: '0x' + '22'.repeat(20),
      staking_address: '0x' + '77'.repeat(20),
    });
    const r = reconcileStandardService(2, svc, emptySignals({ stakingState: 'revert' }), {
      stakingContract: svc.staking_address!,
      preserveExistingSetup: true,
    });
    expect(r?.patch.service_id).toBeUndefined();
    expect(r?.patch.safe_address).toBeUndefined();
    expect(r?.patch.error).toContain('preserved');
  });

  it('does nothing when staking read was inconclusive (transient RPC)', () => {
    const svc = baseSvc({ service_id: 99, step: 'complete', safe_address: '0x' + '22'.repeat(20) });
    const r = reconcileStandardService(1, svc, emptySignals({ stakingState: 'inconclusive' }), {
      stakingContract: STAKING,
    });
    expect(r).toBeNull();
  });

  it('does nothing when registry read inconclusive in standard mode', () => {
    const svc = baseSvc({ service_id: 3, step: 'complete' });
    const r = reconcileStandardService(
      1,
      svc,
      emptySignals({ stakingState: 1, registryState: 'inconclusive' }),
      { stakingContract: STAKING },
    );
    expect(r).toBeNull();
  });

  it('resets when complete on-chain but unstaked (unstakeAndWithdraw / partial)', () => {
    const svc = baseSvc({ service_id: 3, step: 'complete', mech_address: '0x' + '33'.repeat(20) });
    const r = reconcileStandardService(1, svc, emptySignals({ stakingState: 0 }), {
      stakingContract: STAKING,
    });
    expect(r?.patch.step).toBe('awaiting_stake');
    expect(r?.patch.mech_address).toBeNull();
    expect(r?.message).toContain('unstaked');
  });

  it('preserves non-default setup when it appears inactive', () => {
    const svc = baseSvc({
      service_id: 3,
      step: 'complete',
      safe_address: '0x' + '22'.repeat(20),
      mech_address: '0x' + '33'.repeat(20),
      staking_address: '0x' + '77'.repeat(20),
    });
    const r = reconcileStandardService(1, svc, emptySignals({ stakingState: 0 }), {
      stakingContract: svc.staking_address!,
      preserveExistingSetup: true,
    });
    expect(r?.patch.service_id).toBeUndefined();
    expect(r?.patch.mech_address).toBeUndefined();
    expect(r?.patch.error).toContain('preserved');
  });

  it('preserves non-default awaiting_stake setup when it appears inactive', () => {
    const svc = baseSvc({
      service_id: 3,
      step: 'awaiting_stake',
      safe_address: '0x' + '22'.repeat(20),
      staking_address: '0x' + '77'.repeat(20),
    });
    const r = reconcileStandardService(1, svc, emptySignals({ stakingState: 0 }), {
      stakingContract: svc.staking_address!,
      preserveExistingSetup: true,
    });
    expect(r?.patch.service_id).toBeUndefined();
    expect(r?.patch.safe_address).toBeUndefined();
    expect(r?.patch.error).toContain('preserved');
  });

  it('clears stale service_id when local awaiting_stake but not staked on-chain', () => {
    const svc = baseSvc({ service_id: 5, step: 'awaiting_stake' });
    const r = reconcileStandardService(1, svc, emptySignals({ stakingState: 0 }), {
      stakingContract: STAKING,
    });
    expect(r?.patch.service_id).toBeNull();
    expect(r?.message).toContain('awaiting_stake');
  });

  it('advances to staked when chain already staked after crash before step save', () => {
    const safe = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const svc = baseSvc({ service_id: 8, step: 'awaiting_stake' });
    const r = reconcileStandardService(1, svc, emptySignals({ stakingState: 1, stakingMultisig: safe }), {
      stakingContract: STAKING,
    });
    expect(r?.patch.step).toBe('staked');
    expect(r?.patch.safe_address).toMatch(/^0x/i);
    expect(r?.patch.staking_address?.toLowerCase()).toBe(STAKING.toLowerCase());
  });

  it('returns null for awaiting_stake + staked on-chain but no multisig', () => {
    const svc = baseSvc({ service_id: 8, step: 'awaiting_stake' });
    const r = reconcileStandardService(1, svc, emptySignals({ stakingState: 1, stakingMultisig: null }), {
      stakingContract: STAKING,
    });
    expect(r).toBeNull();
  });
});

describe('reconcileSelfBondService', () => {
  it('rewinds when Safe missing but step advanced', () => {
    const svc = baseSvc({
      step: 'service_activated',
      safe_address: '0x' + 'cc'.repeat(20),
      service_id: 1,
    });
    const r = reconcileSelfBondService(1, svc, emptySignals({ safeDeployed: false }));
    expect(r?.patch.step).toBe('awaiting_stake');
    expect(r?.message).toContain('no bytecode');
  });

  it('clears service id when registry read reverts', () => {
    const svc = baseSvc({
      step: 'service_deployed',
      service_id: 4,
      safe_address: '0x' + 'dd'.repeat(20),
    });
    const r = reconcileSelfBondService(1, svc, emptySignals({ registryState: 'revert', safeDeployed: true }));
    expect(r?.patch.service_id).toBeNull();
    expect(r?.patch.step).toBe('service_created');
  });

  it('does not clear service id when registry read inconclusive', () => {
    const svc = baseSvc({
      step: 'service_deployed',
      service_id: 4,
      safe_address: '0x' + 'dd'.repeat(20),
    });
    const r = reconcileSelfBondService(
      1,
      svc,
      emptySignals({ registryState: 'inconclusive', safeDeployed: true, stakingState: 1 }),
    );
    expect(r).toBeNull();
  });

  it('downgrades when local step is ahead of registry', () => {
    const svc = baseSvc({
      step: 'service_deployed',
      service_id: 2,
      safe_address: '0x' + 'ee'.repeat(20),
      mech_address: '0x' + 'ff'.repeat(20),
    });
    const r = reconcileSelfBondService(
      1,
      svc,
      emptySignals({
        registryState: 2,
        registryMultisig: '0x' + 'ee'.repeat(20),
        stakingState: 0,
      }),
    );
    expect(r?.patch.step).toBe('agents_registered');
    expect(r?.patch.mech_address).toBeNull();
    expect(r?.message).toContain('ahead of registry');
  });

  it('rewinds to service_staked when evicted on self-bond', () => {
    const svc = baseSvc({ step: 'complete', service_id: 9, mech_address: '0x' + 'ab'.repeat(20) });
    const r = reconcileSelfBondService(
      1,
      svc,
      emptySignals({ registryState: 4, stakingState: 2 }),
    );
    expect(r?.patch.step).toBe('service_staked');
    expect(r?.patch.mech_address).toBeNull();
    expect(r?.message).toContain('evicted');
  });

  it('rewinds to service_staked when unstaked but local said complete', () => {
    const svc = baseSvc({ step: 'complete', service_id: 9 });
    const r = reconcileSelfBondService(
      1,
      svc,
      emptySignals({ registryState: 4, stakingState: 0 }),
    );
    expect(r?.patch.step).toBe('service_staked');
    expect(r?.message).toContain('not staked');
  });
});

describe('reconcileServiceAgainstChain', () => {
  it('dispatches to standard reconciler', () => {
    const svc = baseSvc({ service_id: 1, step: 'complete' });
    const r = reconcileServiceAgainstChain('standard', svc, emptySignals({ stakingState: 0 }), {
      stakingContract: STAKING,
    });
    expect(r?.patch.step).toBe('awaiting_stake');
  });

  it('dispatches to self-bond reconciler', () => {
    const svc = baseSvc({
      step: 'service_activated',
      safe_address: '0x' + 'aa'.repeat(20),
    });
    const r = reconcileServiceAgainstChain('self-bond', svc, emptySignals({ safeDeployed: false }), {
      stakingContract: STAKING,
    });
    expect(r?.patch.step).toBe('awaiting_stake');
  });
});
