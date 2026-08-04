import { describe, expect, it } from 'vitest';
import {
  assembleStatusV1,
  resolveMasterDailyEstimateWei,
  type GatheredStatusRaw,
} from '../../src/api/status-build.js';
import type { FleetState } from '../../src/earning/types.js';
import { buildInfo } from '../../src/build-info.js';

function minimalFleet(overrides: Partial<FleetState> = {}): FleetState {
  return {
    master_address: '0x1111111111111111111111111111111111111111',
    chain: 'base',
    staking_mode: 'standard',
    services: [
      {
        index: 1,
        agent_address: '0x2222222222222222222222222222222222222222',
        safe_address: '0x3333333333333333333333333333333333333333',
        service_id: 42,
        mech_address: '0x4444444444444444444444444444444444444444',
        staking_address: '0x5555555555555555555555555555555555555555',
        step: 'complete',
        error: null,
      },
    ],
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('resolveMasterDailyEstimateWei', () => {
  it('uses explicit config string', () => {
    expect(resolveMasterDailyEstimateWei('5000000000000000', 5000)).toBe(5_000_000_000_000_000n);
  });

  it('falls back to poll-based heuristic when unset', () => {
    const v = resolveMasterDailyEstimateWei(undefined, 5000);
    expect(v).toBeGreaterThan(0n);
  });

  it('returns the 0.0005 ETH/day floor at default pollIntervalMs (#288)', () => {
    // Pre-#288 the poll-based blend short-circuited the floor at default
    // pollIntervalMs=5000 (returning 3.6e15 wei ≈ 0.0036 ETH/day), which made
    // "(balance - min) / daily" floor to 0 days at modest 0.008 ETH balances
    // and surfaced as a misleading "1 days runway" red flag in the dashboard.
    // The fix drops the blend and lets the floor (0.0005 ETH/day = 5e14 wei)
    // govern when no explicit config is supplied.
    expect(resolveMasterDailyEstimateWei(undefined, 5000)).toBe(500_000_000_000_000n);
  });
});

describe('assembleStatusV1', () => {
  it('marks sqlite_only mode and short-circuits next actions', () => {
    const raw: GatheredStatusRaw = {
      hintsScope: 'sqlite_only',
      shutdownState: 'running',
      dbPath: '/tmp/x.db',
      activityCounts: { created: 1 },
      recentActivity: [],
      lastRewardClaimTickAt: null,
      rewardClaimIntervalMs: 0,
      fleet: null,
      rpc: { ok: true },
      master: { address: null },
      pollIntervalMs: 5000,
      masterDailyEstimateWei: '1000',
    };
    const j = assembleStatusV1(raw);
    expect(j.statusMode).toBe('sqlite_only');
    expect(j.nextActions).toHaveLength(1);
    expect(j.nextActions[0]).toMatch(/npm run status/);
    expect(j.earnings.hint).toMatch(/omitted/);
  });

  // Regression coverage for spec §14.2 item 2 / issue #2402: `daemon.dbPath`
  // is an absolute filesystem path (home dir, username) on the same
  // unauthenticated /v1/status endpoint the RPC-error masking targets. It's
  // dropped from the assembled response even though `raw.dbPath` stays on
  // GatheredStatusRaw for the local `jinn status` CLI roll-up.
  it('never projects dbPath into the assembled daemon block', () => {
    const raw: GatheredStatusRaw = {
      hintsScope: 'sqlite_only',
      shutdownState: 'running',
      dbPath: '/Users/some-operator/.jinn-client/jinn.db',
      activityCounts: {},
      recentActivity: [],
      lastRewardClaimTickAt: null,
      rewardClaimIntervalMs: 0,
      fleet: null,
      rpc: { ok: true },
      master: { address: null },
      pollIntervalMs: 5000,
      masterDailyEstimateWei: '1000',
    };
    const j = assembleStatusV1(raw);
    expect(j.daemon).not.toHaveProperty('dbPath');
    expect(JSON.stringify(j)).not.toContain('some-operator');
  });

  it('exposes the durable Phase D observation window without re-deriving it', () => {
    const raw: GatheredStatusRaw = {
      hintsScope: 'sqlite_only',
      shutdownState: 'running',
      dbPath: '/tmp/x.db',
      activityCounts: {},
      recentActivity: [],
      lastRewardClaimTickAt: null,
      rewardClaimIntervalMs: 0,
      fleet: null,
      rpc: { ok: true },
      master: { address: null },
      pollIntervalMs: 5000,
      masterDailyEstimateWei: '1000',
      phaseDTransitionUsage: {
        schemaVersion: 1,
        durable: true,
        observationWindowStartedAt: '2026-08-03T00:00:00.000Z',
        counters: [{
          signal: 'marketplace-pipeline-invocation',
          count: 2,
          firstObservedAt: '2026-08-03T01:00:00.000Z',
          lastObservedAt: '2026-08-03T02:00:00.000Z',
        }],
      },
    };
    expect(assembleStatusV1(raw).phaseDTransitionUsage).toEqual({
      ...raw.phaseDTransitionUsage,
      class: 'observation',
    });
  });

  it('tags phaseDTransitionUsage class: observation so a consumer cannot silently promote it (#2409, spec §7)', () => {
    const raw: GatheredStatusRaw = {
      hintsScope: 'sqlite_only',
      shutdownState: 'running',
      dbPath: '/tmp/x.db',
      activityCounts: {},
      recentActivity: [],
      lastRewardClaimTickAt: null,
      rewardClaimIntervalMs: 0,
      fleet: null,
      rpc: { ok: true },
      master: { address: null },
      pollIntervalMs: 5000,
      masterDailyEstimateWei: '1000',
      phaseDTransitionUsage: {
        schemaVersion: 1,
        durable: true,
        observationWindowStartedAt: '2026-08-03T00:00:00.000Z',
        counters: [],
      },
    };
    expect(assembleStatusV1(raw).phaseDTransitionUsage?.class).toBe('observation');
  });

  it('carries effectiveMode from the resolver, defaulting to legacy when absent (#2380)', () => {
    const base: GatheredStatusRaw = {
      hintsScope: 'sqlite_only',
      shutdownState: 'running',
      dbPath: '/tmp/x.db',
      activityCounts: {},
      recentActivity: [],
      lastRewardClaimTickAt: null,
      rewardClaimIntervalMs: 0,
      fleet: null,
      rpc: { ok: true },
      master: { address: null },
      pollIntervalMs: 5000,
      masterDailyEstimateWei: '1000',
    };
    expect(assembleStatusV1(base).effectiveMode).toBe('legacy');
    expect(assembleStatusV1({ ...base, effectiveMode: 'native-v1' }).effectiveMode).toBe('native-v1');
  });

  it('reports zero runway excess when balance is already below minimum', () => {
    const raw: GatheredStatusRaw = {
      shutdownState: 'running',
      dbPath: '/tmp/x.db',
      activityCounts: {},
      recentActivity: [],
      lastRewardClaimTickAt: null,
      rewardClaimIntervalMs: 0,
      fleet: minimalFleet(),
      rpc: { ok: true, chainId: 8453, blockNumber: '1' },
      master: {
        address: '0x1111111111111111111111111111111111111111',
        balanceWei: '20000000000000000',
      },
      pollIntervalMs: 5000,
      masterDailyEstimateWei: '1000000000000000',
      minMasterEthWei: '50000000000000000',
    };
    const j = assembleStatusV1(raw);
    expect(j.masterGas.runwayDaysExcess).toBe('0');
  });

  it("reports >=5 days runway at the issue's 0.008 ETH boundary post-fix (#288)", () => {
    // Boundary test from the user-reported scenario in #288: with a master
    // balance of ~0.008 ETH (the exact wei amount observed post-bootstrap),
    // a 0.005 ETH min-floor, and the post-fix 0.0005 ETH/day estimate, the
    // dashboard should show ~5 days runway, not "1 days" / "0 days".
    //   (7991886719184102 - 5000000000000000) / 500000000000000
    //   = 2991886719184102 / 500000000000000
    //   = 5.98... → BigInt floor → '5'
    const raw: GatheredStatusRaw = {
      shutdownState: 'running',
      dbPath: '/tmp/x.db',
      activityCounts: {},
      recentActivity: [],
      lastRewardClaimTickAt: null,
      rewardClaimIntervalMs: 0,
      fleet: minimalFleet(),
      rpc: { ok: true, chainId: 8453, blockNumber: '1' },
      master: {
        address: '0x1111111111111111111111111111111111111111',
        balanceWei: '7991886719184102',
      },
      pollIntervalMs: 5000,
      masterDailyEstimateWei: '500000000000000',
      minMasterEthWei: '5000000000000000',
    };
    const j = assembleStatusV1(raw);
    expect(j.masterGas.runwayDaysExcess).toBe('5');
  });

  it('flags low master balance vs minimum', () => {
    const raw: GatheredStatusRaw = {
      shutdownState: 'running',
      dbPath: '/tmp/x.db',
      activityCounts: {},
      recentActivity: [],
      lastRewardClaimTickAt: null,
      rewardClaimIntervalMs: 600_000,
      fleet: minimalFleet(),
      rpc: { ok: true, chainId: 8453, blockNumber: '1' },
      master: {
        address: '0x1111111111111111111111111111111111111111',
        balanceWei: '1',
      },
      pendingStakingRewardsWei: '0',
      pollIntervalMs: 5000,
      masterDailyEstimateWei: '1000000000000000000',
      minMasterEthWei: '10000000000000000000',
    };
    const j = assembleStatusV1(raw);
    expect(j.nextActions.some(a => a.includes('Fund master'))).toBe(true);
    expect(j.fleet.completeCount).toBe(1);
    expect(j.fleet.stakedLikeCount).toBe(1);
  });

  it('includes RPC failure in next actions when full mode', () => {
    const raw: GatheredStatusRaw = {
      shutdownState: 'running',
      dbPath: '/tmp/x.db',
      activityCounts: {},
      recentActivity: [],
      lastRewardClaimTickAt: null,
      rewardClaimIntervalMs: 0,
      fleet: minimalFleet(),
      rpc: { ok: false, error: 'boom' },
      master: { address: '0x1111111111111111111111111111111111111111' },
      pollIntervalMs: 5000,
      masterDailyEstimateWei: '1',
    };
    const j = assembleStatusV1(raw);
    expect(j.statusMode).toBe('full');
    expect(j.nextActions.some(a => a.includes('RPC'))).toBe(true);
  });

  it('reports claimed staking rewards summed across services', () => {
    const raw: GatheredStatusRaw = {
      shutdownState: 'running',
      dbPath: '/tmp/x.db',
      activityCounts: {},
      recentActivity: [],
      lastRewardClaimTickAt: null,
      rewardClaimIntervalMs: 0,
      fleet: minimalFleet(),
      rpc: { ok: true, chainId: 8453, blockNumber: '1' },
      master: { address: '0x1111111111111111111111111111111111111111' },
      claimedByService: {
        0: { total: '300', lastAt: '2026-01-01T00:00:00.000Z', lastTxHash: '0xabc' },
        1: { total: '500', lastAt: '2026-01-01T00:00:01.000Z', lastTxHash: '0xdef' },
      },
      claimedStakingRewardsLast24hWei: '120',
      pollIntervalMs: 5000,
      masterDailyEstimateWei: '1',
    };
    const j = assembleStatusV1(raw);
    expect(j.rewards.claimedStakingRewardsWei).toBe('800');
    expect(j.rewards.claimedStakingRewardsLast24hWei).toBe('120');
  });

  it('passes prediction.v1 status through when present', () => {
    const raw: GatheredStatusRaw = {
      shutdownState: 'running',
      dbPath: '/tmp/x.db',
      activityCounts: {},
      recentActivity: [],
      lastRewardClaimTickAt: null,
      rewardClaimIntervalMs: 0,
      fleet: minimalFleet(),
      rpc: { ok: true, chainId: 8453, blockNumber: '1' },
      master: { address: '0x1111111111111111111111111111111111111111' },
      pollIntervalMs: 5000,
      masterDailyEstimateWei: '1',
      predictionV1: {
        operator: null,
        totals: {
          observedTasks: 1,
          activeTaskRuns: 0,
          solutions: 1,
          verdicts: 0,
          failed: 0,
        },
        latest: {
          taskAt: 100,
          solutionAt: 100,
          verdictAt: null,
        },
        recentTasks: [],
        recentSolutions: [],
        recentVerdicts: [],
      },
    };
    const j = assembleStatusV1(raw);
    expect(j.predictionV1?.totals.solutions).toBe(1);
    expect(j.predictionV1?.latest.solutionAt).toBe(100);
  });

  it('exposes per-role ETH balances from serviceBalances + master', () => {
    const raw: GatheredStatusRaw = {
      shutdownState: 'running',
      dbPath: '/tmp/x.db',
      activityCounts: {},
      recentActivity: [],
      lastRewardClaimTickAt: null,
      rewardClaimIntervalMs: 0,
      fleet: minimalFleet(),
      rpc: { ok: true, chainId: 8453, blockNumber: '1' },
      master: {
        address: '0x1111111111111111111111111111111111111111',
        balanceWei: '7000000000000000',
      },
      pollIntervalMs: 5000,
      masterDailyEstimateWei: '1',
      // minimalFleet has services[0].index === 1, so displayFleetServiceIndex === 0.
      serviceBalances: {
        0: {
          agentNativeWei: '2500000000000000',
          safeNativeWei: '4000000000000000',
          safeBondWei: '0',
        },
      },
    };
    const j = assembleStatusV1(raw);
    expect(j.balances.eth.master).toEqual({
      address: '0x1111111111111111111111111111111111111111',
      balanceWei: '7000000000000000',
    });
    expect(j.balances.eth.agent).toEqual({
      address: '0x2222222222222222222222222222222222222222',
      balanceWei: '2500000000000000',
    });
    expect(j.balances.eth.safe).toEqual({
      address: '0x3333333333333333333333333333333333333333',
      balanceWei: '4000000000000000',
    });
  });

  it('returns null balances for roles whose address or row is missing', () => {
    const raw: GatheredStatusRaw = {
      shutdownState: 'running',
      dbPath: '/tmp/x.db',
      activityCounts: {},
      recentActivity: [],
      lastRewardClaimTickAt: null,
      rewardClaimIntervalMs: 0,
      fleet: null,
      rpc: { ok: true, chainId: 8453, blockNumber: '1' },
      master: { address: null },
      pollIntervalMs: 5000,
      masterDailyEstimateWei: '1',
    };
    const j = assembleStatusV1(raw);
    expect(j.balances.eth.master).toEqual({ address: null, balanceWei: null });
    expect(j.balances.eth.agent).toEqual({ address: null, balanceWei: null });
    expect(j.balances.eth.safe).toEqual({ address: null, balanceWei: null });
  });

  it('propagates the master read error onto balances.eth.master', () => {
    const raw: GatheredStatusRaw = {
      shutdownState: 'running',
      dbPath: '/tmp/x.db',
      activityCounts: {},
      recentActivity: [],
      lastRewardClaimTickAt: null,
      rewardClaimIntervalMs: 0,
      fleet: minimalFleet(),
      rpc: { ok: true, chainId: 8453, blockNumber: '1' },
      master: {
        address: '0x1111111111111111111111111111111111111111',
        error: 'rpc timeout',
      },
      pollIntervalMs: 5000,
      masterDailyEstimateWei: '1',
      serviceBalanceErrors: { 0: { agent: 'agent rpc fail' } },
      serviceBalances: { 0: { agentNativeWei: '0', safeNativeWei: '0', safeBondWei: '0' } },
    };
    const j = assembleStatusV1(raw);
    expect(j.balances.eth.master.error).toBe('rpc timeout');
    expect(j.balances.eth.master.balanceWei).toBeNull();
    expect(j.balances.eth.agent.error).toBe('agent rpc fail');
    expect(j.balances.eth.agent.balanceWei).toBe('0');
  });

  it('passes generic task-run status through when present', () => {
    const raw: GatheredStatusRaw = {
      shutdownState: 'running',
      dbPath: '/tmp/x.db',
      activityCounts: {},
      recentActivity: [],
      lastRewardClaimTickAt: null,
      rewardClaimIntervalMs: 0,
      fleet: minimalFleet(),
      rpc: { ok: true, chainId: 8453, blockNumber: '1' },
      master: { address: '0x1111111111111111111111111111111111111111' },
      pollIntervalMs: 5000,
      masterDailyEstimateWei: '1',
      taskRuns: {
        totals: { observedTasks: 1, activeTaskRuns: 1, completed: 0, solutions: 0, verdicts: 0, failed: 0 },
        inFlight: [{
          requestId: 'req-1',
          taskId: '15',
          taskCid: 'bafkre...',
          solverType: 'swe-rebench-v2.v1',
          state: 'RUNNING',
          taskRole: 'restoration',
          implName: 'codex',
          windowStartTs: 1,
          windowEndTs: 2,
          stateUpdatedAt: 100,
          manifestCid: null,
          deliveryTxHash: null,
          failureReason: null,
        }],
        recentTasks: [],
      },
    };
    const j = assembleStatusV1(raw);
    expect(j.taskRuns?.totals.activeTaskRuns).toBe(1);
    expect(j.taskRuns?.totals.solutions).toBe(0);
    expect(j.taskRuns?.totals.verdicts).toBe(0);
    expect(j.taskRuns?.inFlight[0]?.solverType).toBe('swe-rebench-v2.v1');
  });

  it('projects version + latestVersion (#641)', () => {
    const base: GatheredStatusRaw = {
      shutdownState: 'running',
      dbPath: '/tmp/x.db',
      activityCounts: {},
      recentActivity: [],
      lastRewardClaimTickAt: null,
      rewardClaimIntervalMs: 0,
      fleet: null,
      rpc: { ok: true },
      master: { address: null },
      pollIntervalMs: 5000,
      masterDailyEstimateWei: '1000',
    };
    // Explicit version + latestVersion pass through verbatim.
    const withBoth = assembleStatusV1({ ...base, version: '0.1.8', latestVersion: '0.2.0' });
    expect(withBoth.version).toBe('0.1.8');
    expect(withBoth.latestVersion).toBe('0.2.0');

    // Absent latestVersion → null; absent version → buildInfo fallback.
    const withNeither = assembleStatusV1(base);
    expect(withNeither.latestVersion).toBeNull();
    expect(withNeither.version).toBe(buildInfo.implVersion);
  });
});

describe('assembleStatusV1 → status.harness', () => {
  // Minimal raw shared across the three cases below — the rollup is independent
  // of fleet/RPC state, so we keep the fixture small.
  function rawForHarness(harnessRollup?: GatheredStatusRaw['harnessRollup']): GatheredStatusRaw {
    return {
      shutdownState: 'running',
      dbPath: '/tmp/x.db',
      activityCounts: {},
      recentActivity: [],
      lastRewardClaimTickAt: null,
      rewardClaimIntervalMs: 0,
      fleet: null,
      rpc: { ok: true },
      master: { address: null },
      pollIntervalMs: 5000,
      masterDailyEstimateWei: '1',
      ...(harnessRollup ? { harnessRollup } : {}),
    };
  }

  it('defaults to ready when raw.harnessRollup is omitted (backward-compat)', () => {
    const j = assembleStatusV1(rawForHarness());
    expect(j.harness).toEqual({ ready: true, name: null, reason: null });
  });

  it('propagates an unready rollup verbatim', () => {
    const j = assembleStatusV1(
      rawForHarness({ ready: false, name: 'claude-code', reason: 'subscription_expired' }),
    );
    expect(j.harness).toEqual({
      ready: false,
      name: 'claude-code',
      reason: 'subscription_expired',
    });
  });

  it('propagates an explicit ready rollup verbatim', () => {
    const j = assembleStatusV1(rawForHarness({ ready: true, name: null, reason: null }));
    expect(j.harness).toEqual({ ready: true, name: null, reason: null });
  });
});

describe('assembleStatusV1 — autoRestake observability (#651)', () => {
  it('emits autoRestake.enabled=false + checkIntervalMs=0 by default', () => {
    const raw: GatheredStatusRaw = {
      shutdownState: 'running',
      dbPath: '/tmp/x.db',
      activityCounts: {},
      recentActivity: [],
      lastRewardClaimTickAt: null,
      rewardClaimIntervalMs: 0,
      fleet: null,
      rpc: { ok: true },
      master: { address: null },
      pollIntervalMs: 5000,
      masterDailyEstimateWei: '1000',
    };
    const j = assembleStatusV1(raw);
    expect(j.autoRestake).toEqual({ enabled: false, checkIntervalMs: 0 });
  });

  it('emits autoRestake.enabled=true + checkIntervalMs when raw flags it on', () => {
    const raw: GatheredStatusRaw = {
      shutdownState: 'running',
      dbPath: '/tmp/x.db',
      activityCounts: {},
      recentActivity: [],
      lastRewardClaimTickAt: null,
      rewardClaimIntervalMs: 0,
      fleet: null,
      rpc: { ok: true },
      master: { address: null },
      pollIntervalMs: 5000,
      masterDailyEstimateWei: '1000',
      autoRestakeEnabled: true,
      evictionCheckIntervalMs: 60_000,
    };
    const j = assembleStatusV1(raw);
    expect(j.autoRestake).toEqual({ enabled: true, checkIntervalMs: 60_000 });
  });
});

describe('assembleStatusV1 l1MasterGas (issue #1296)', () => {
  function rawWithL1(over: Partial<GatheredStatusRaw> = {}): GatheredStatusRaw {
    return {
      shutdownState: 'running',
      dbPath: '/tmp/x.db',
      activityCounts: {},
      recentActivity: [],
      lastRewardClaimTickAt: null,
      rewardClaimIntervalMs: 0,
      fleet: minimalFleet(),
      rpc: { ok: true },
      master: { address: '0xL2MASTER', balanceWei: '10000000000000000' },
      pollIntervalMs: 5000,
      masterDailyEstimateWei: '500000000000000',
      minMasterEthWei: '1000000000000000',
      l1Master: { address: '0xL1MASTER', balanceWei: '2000000000000000' },
      minL1MasterEthWei: '1000000000000000',
      l1MasterDailyEstimateWei: '500000000000000',
      ...over,
    };
  }

  it('emits an l1MasterGas block with computed runway when raw.l1Master is present', () => {
    const body = assembleStatusV1(rawWithL1());
    expect(body.l1MasterGas).toBeDefined();
    expect(body.l1MasterGas!.address).toBe('0xL1MASTER');
    expect(body.l1MasterGas!.balanceWei).toBe('2000000000000000');
    expect(body.l1MasterGas!.minEthWei).toBe('1000000000000000');
    // (2e15 - 1e15) / 5e14 = 2 days
    expect(body.l1MasterGas!.runwayDaysExcess).toBe('2');
  });

  it('omits l1MasterGas when raw.l1Master is absent', () => {
    const body = assembleStatusV1(rawWithL1({ l1Master: undefined }));
    expect(body.l1MasterGas).toBeUndefined();
  });
});
