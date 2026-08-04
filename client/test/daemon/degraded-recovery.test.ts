/**
 * Issue #2407 / spec §5, §11: degrade-open boot's standalone recovery-loop
 * runner. Constructs the "always" admission economic loops
 * (eviction-check, checkpoint, balance-topup, reward-claim) from primitives
 * available BEFORE bootstrap completes — never the full `Daemon` class,
 * which needs `mechAddress`/`safeAddress`/`composition`/`adapter` resolved
 * from a completed bootstrap. Each of the four loop classes is independently
 * self-sufficient (loads `FleetStateStore` fresh every tick, iterates
 * whatever operational services already exist), so "zero services yet"
 * just means "nothing to do this tick," not a construction error.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startDegradedRecoveryLoops } from '../../src/daemon/degraded-recovery.js';
import { EvictionLoop } from '../../src/daemon/eviction-loop.js';
import { CheckpointLoop } from '../../src/daemon/checkpoint-loop.js';
import { BalanceTopupLoop } from '../../src/daemon/balance-topup-loop.js';
import { RewardClaimLoop } from '../../src/daemon/reward-claim-loop.js';

function makeEarningDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'jinn-degraded-recovery-'));
  writeFileSync(
    join(dir, 'earning_state.json'),
    JSON.stringify({ master_address: '0xabc', chain: 'base-sepolia', staking_mode: 'standard', services: [], updated_at: new Date().toISOString() }),
  );
  return dir;
}

const baseDeps = () => ({
  earningDir: makeEarningDir(),
  network: 'base-sepolia' as const,
  publicClient: { readContract: vi.fn() } as any,
  masterWallet: { account: { address: '0xEOA' }, writeContract: vi.fn() } as any,
  mnemonic: 'test test test test test test test test test test test junk',
  rpcUrl: 'http://127.0.0.1:8545',
  chainConfig: {
    distributorAddress: '0xDistributor',
    eoaTopupTrigger: 1n,
    minEoaGasEth: 2n,
    safeTopupTrigger: 3n,
    minSafeEth: 4n,
  } as any,
  intervals: {
    evictionCheckIntervalMs: 60_000,
    checkpointIntervalMs: 300_000,
    balanceTopupIntervalMs: 300_000,
    rewardClaimIntervalMs: 600_000,
  },
  stakingMode: 'standard' as const,
});

describe('startDegradedRecoveryLoops', () => {
  beforeEach(() => {
    vi.spyOn(EvictionLoop.prototype, 'run').mockImplementation(async () => {});
    vi.spyOn(CheckpointLoop.prototype, 'run').mockImplementation(async () => {});
    vi.spyOn(BalanceTopupLoop.prototype, 'run').mockImplementation(async () => {});
    vi.spyOn(RewardClaimLoop.prototype, 'run').mockImplementation(async () => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('starts all four always-admission loops when intervals are positive and staking mode is standard', () => {
    const evictionStop = vi.spyOn(EvictionLoop.prototype, 'stop');
    const checkpointStop = vi.spyOn(CheckpointLoop.prototype, 'stop');
    const topupStop = vi.spyOn(BalanceTopupLoop.prototype, 'stop');
    const claimStop = vi.spyOn(RewardClaimLoop.prototype, 'stop');

    const handle = startDegradedRecoveryLoops(baseDeps());
    expect(EvictionLoop.prototype.run).toHaveBeenCalledOnce();
    expect(CheckpointLoop.prototype.run).toHaveBeenCalledOnce();
    expect(BalanceTopupLoop.prototype.run).toHaveBeenCalledOnce();
    expect(RewardClaimLoop.prototype.run).toHaveBeenCalledOnce();

    handle.stop();
    expect(evictionStop).toHaveBeenCalledOnce();
    expect(checkpointStop).toHaveBeenCalledOnce();
    expect(topupStop).toHaveBeenCalledOnce();
    expect(claimStop).toHaveBeenCalledOnce();
  });

  it('never constructs a claim/work-path loop (creator, engine-tick, work) — ready-only stays off by construction', () => {
    // No creator/engine/work module is even imported by degraded-recovery.ts;
    // this test documents the invariant at the call-surface level: the
    // returned handle only ever touches the four always-admission loops.
    const handle = startDegradedRecoveryLoops(baseDeps());
    expect(Object.keys(handle)).toEqual(['stop']);
  });

  it('skips eviction-check and checkpoint in self-bond staking mode', () => {
    const deps = { ...baseDeps(), stakingMode: 'self-bond' as const };
    startDegradedRecoveryLoops(deps);
    expect(EvictionLoop.prototype.run).not.toHaveBeenCalled();
    expect(CheckpointLoop.prototype.run).not.toHaveBeenCalled();
    expect(BalanceTopupLoop.prototype.run).toHaveBeenCalledOnce();
    expect(RewardClaimLoop.prototype.run).toHaveBeenCalledOnce();
  });

  it('skips eviction-check when no distributor address is resolved', () => {
    const deps = { ...baseDeps(), chainConfig: { ...baseDeps().chainConfig, distributorAddress: undefined } };
    startDegradedRecoveryLoops(deps);
    expect(EvictionLoop.prototype.run).not.toHaveBeenCalled();
  });

  it('respects a zero interval as "disabled" per loop, matching production wiring', () => {
    const deps = { ...baseDeps(), intervals: { evictionCheckIntervalMs: 0, checkpointIntervalMs: 0, balanceTopupIntervalMs: 0, rewardClaimIntervalMs: 0 } };
    startDegradedRecoveryLoops(deps);
    expect(EvictionLoop.prototype.run).not.toHaveBeenCalled();
    expect(CheckpointLoop.prototype.run).not.toHaveBeenCalled();
    expect(BalanceTopupLoop.prototype.run).not.toHaveBeenCalled();
    expect(RewardClaimLoop.prototype.run).not.toHaveBeenCalled();
  });

  it('stop() does not throw even when a loop crashed', async () => {
    vi.spyOn(RewardClaimLoop.prototype, 'run').mockRejectedValue(new Error('boom'));
    const handle = startDegradedRecoveryLoops(baseDeps());
    // let the rejected promise's .catch() run
    await new Promise((r) => setTimeout(r, 10));
    expect(() => handle.stop()).not.toThrow();
  });
});
