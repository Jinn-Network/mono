import { describe, expect, it } from 'vitest';
import { assembleStatusRollupV1, assembleStatusDetailV1 } from '../../src/api/status-rollup-build.js';
import type { GatheredStatusRaw } from '../../src/api/status-build.js';

function makeRaw(): GatheredStatusRaw {
  return {
    shutdownState: 'running',
    dbPath: '/tmp/x',
    activityCounts: {},
    recentActivity: [],
    lastRewardClaimTickAt: null,
    rewardClaimIntervalMs: 600_000,
    fleet: {
      master_address: '0xM',
      chain: 'base-sepolia',
      staking_mode: 'standard',
      updated_at: '2026-04-14T12:00:00.000Z',
      services: [
        {
          index: 1,
          agent_address: '0x',
          safe_address: null,
          service_id: 42,
          mech_address: null,
          staking_address: null,
          step: 'complete',
          error: null,
        },
        {
          index: 2,
          agent_address: '0x',
          safe_address: null,
          service_id: 43,
          mech_address: null,
          staking_address: null,
          step: 'service_staked',
          error: null,
        },
      ],
    },
    rpc: { ok: true, chainId: 84532, blockNumber: '999' },
    master: { address: '0xM', balanceWei: '1' },
    pollIntervalMs: 5000,
    masterDailyEstimateWei: '1',
  };
}

describe('assembleStatusRollupV1', () => {
  it('emits the §4.1 roll-up shape with daemon/rpc/fleet/exit', () => {
    const parsed = assembleStatusRollupV1(makeRaw());
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.daemon.state).toBe('running');
    expect(parsed.daemon.network).toBe('testnet');
    expect(parsed.rpc.ok).toBe(true);
    expect(parsed.rpc.chainId).toBe(84532);
    expect(parsed.fleet.size).toBe(2);
    expect(parsed.fleet.complete).toBe(1);
    expect(parsed.fleet.needsAttention).toBe(1);
    expect(parsed.exit.blocking).toBe(true);
    expect(parsed.exit.hint).toContain('fleet');
  });

  it('does not report running when persisted state is stale and the pid is dead', () => {
    const raw = makeRaw();
    raw.daemonRuntime = {
      pidPath: '/tmp/earning/daemon.pid',
      pid: 99999,
      alive: false,
      stale: true,
    };

    const parsed = assembleStatusRollupV1(raw);

    expect(parsed.daemon.state).toBe('stopped');
  });

  it('exit.blocking when rpc is not ok', () => {
    const raw = makeRaw();
    raw.rpc = { ok: false, error: 'rpc down' };
    const parsed = assembleStatusRollupV1(raw);
    expect(parsed.exit.blocking).toBe(true);
    expect(parsed.exit.hint).toContain('rpc');
  });

  it('exit not blocking when fleet is fully complete and master above minimum', () => {
    const raw = makeRaw();
    raw.fleet!.services = raw.fleet!.services.map(s => ({ ...s, step: 'complete' as const }));
    raw.minMasterEthWei = '1';
    raw.master.balanceWei = '100';
    const parsed = assembleStatusRollupV1(raw);
    expect(parsed.exit.blocking).toBe(false);
  });

  it('counts complete services with preserved setup errors as needing attention', () => {
    const raw = makeRaw();
    raw.fleet!.services = raw.fleet!.services.map(s => ({
      ...s,
      step: 'complete' as const,
      error: s.index === 1 ? 'Existing setup was preserved for recovery.' : null,
    }));
    raw.minMasterEthWei = '1';
    raw.master.balanceWei = '100';
    const parsed = assembleStatusRollupV1(raw, { includeDetail: true });
    expect(parsed.fleet.needsAttention).toBe(1);
    expect(parsed.exit.blocking).toBe(true);
    expect(parsed.detail?.nextActions.some(a => a.includes('preserved for recovery'))).toBe(true);
  });

  it('low master ETH is a warning hint, not a blocking exit', () => {
    const raw = makeRaw();
    raw.fleet!.services = raw.fleet!.services.map(s => ({ ...s, step: 'complete' as const }));
    raw.minMasterEthWei = '100';
    raw.master.balanceWei = '1';
    const parsed = assembleStatusRollupV1(raw);
    expect(parsed.exit.blocking).toBe(false);
    expect(parsed.exit.hint).toContain('runway is low');
  });

  // ── U4 fix: exit.hint must not surface raw viem errors ───────────────────

  it('wraps ECONNREFUSED in a friendly hint, preserves raw error in rpc.error', () => {
    const raw = makeRaw();
    raw.rpc = {
      ok: false,
      error: 'FetchError: request to http://127.0.0.1:1 failed, reason: connect ECONNREFUSED 127.0.0.1:1',
    };
    const parsed = assembleStatusRollupV1(raw);
    expect(parsed.exit.blocking).toBe(true);
    // hint must be friendly — no raw viem/fetch text
    expect(parsed.exit.hint).toContain('RPC unreachable');
    expect(parsed.exit.hint).toContain('connection refused');
    // raw error preserved in rpc.error for structured consumers
    expect(parsed.rpc.error).toContain('ECONNREFUSED');
  });

  it('wraps timeout errors in a friendly hint', () => {
    const raw = makeRaw();
    raw.rpc = { ok: false, error: 'Error: request timed out after 5000ms' };
    const parsed = assembleStatusRollupV1(raw);
    expect(parsed.exit.hint).toContain('timed out');
    expect(parsed.exit.hint).toContain('RPC unreachable');
  });

  it('truncates long generic viem errors in hint to first line', () => {
    const raw = makeRaw();
    raw.rpc = {
      ok: false,
      error: 'JsonRpcError: some obscure error message\n    at RpcClient.call (rpc.js:100)\n    at async Provider.send',
    };
    const parsed = assembleStatusRollupV1(raw);
    expect(parsed.exit.hint).not.toContain('at RpcClient');
    expect(parsed.exit.hint).toContain('RPC unreachable');
  });

  // ── --detail aggregation ──────────────────────────────────────────────────

  it('detail absent when includeDetail is false (default)', () => {
    const parsed = assembleStatusRollupV1(makeRaw());
    expect(parsed.detail).toBeUndefined();
  });

  it('detail present when includeDetail is true', () => {
    const parsed = assembleStatusRollupV1(makeRaw(), { includeDetail: true });
    expect(parsed.detail).toBeDefined();
  });

  it('detail.lastBootstrapStep reports first incomplete service step', () => {
    const raw = makeRaw();
    // services: index 1 = complete, index 2 = service_staked (incomplete)
    const detail = assembleStatusDetailV1(raw);
    expect(detail.lastBootstrapStep).toBe('service_staked');
  });

  it('detail.lastBootstrapStep is "complete" when all services complete', () => {
    const raw = makeRaw();
    raw.fleet!.services = raw.fleet!.services.map(s => ({ ...s, step: 'complete' as const }));
    const detail = assembleStatusDetailV1(raw);
    expect(detail.lastBootstrapStep).toBe('complete');
  });

  it('detail.lastBootstrapStep is null when no fleet exists', () => {
    const raw = makeRaw();
    raw.fleet = null;
    const detail = assembleStatusDetailV1(raw);
    expect(detail.lastBootstrapStep).toBeNull();
  });

  it('detail.lastDaemonEvent is null when no activity', () => {
    const raw = makeRaw();
    raw.recentActivity = [];
    const detail = assembleStatusDetailV1(raw);
    expect(detail.lastDaemonEvent).toBeNull();
  });

  it('detail.lastDaemonEvent reflects most recent activity row', () => {
    const raw = makeRaw();
    raw.recentActivity = [
      { id: 10, ts: '2026-04-28T10:00:00Z', kind: 'delivered', requestId: 'req-1', serviceIndex: 1, txHash: '0xabc', solverType: null, outcome: 'success' },
      { id: 9, ts: '2026-04-28T09:00:00Z', kind: 'created', requestId: 'req-0', serviceIndex: null, txHash: null, solverType: null, outcome: null },
    ];
    const detail = assembleStatusDetailV1(raw);
    expect(detail.lastDaemonEvent?.kind).toBe('delivered');
    expect(detail.lastDaemonEvent?.txHash).toBe('0xabc');
    expect(detail.lastChainTx).toBe('0xabc');
  });

  it('detail.lastChainTx is null when no tx hashes in activity', () => {
    const raw = makeRaw();
    raw.recentActivity = [
      { id: 1, ts: '2026-04-28T10:00:00Z', kind: 'created', requestId: 'r', serviceIndex: null, txHash: null, solverType: null, outcome: null },
    ];
    const detail = assembleStatusDetailV1(raw);
    expect(detail.lastChainTx).toBeNull();
  });

  it('detail.latestSetupArchive reflects the most recent setup migration archive', () => {
    const raw = makeRaw();
    raw.migrationArchive = {
      schemaVersion: 1,
      updated_at: '2026-05-01T00:00:03.000Z',
      entries: [
        {
          migration_id: 'old',
          kind: 'base-sepolia-standard-setup',
          chain: 'base-sepolia',
          service_index: 1,
          created_at: '2026-05-01T00:00:00.000Z',
          updated_at: '2026-05-01T00:00:01.000Z',
          backup_state_path: '/tmp/old.bak',
          from: { service_id: 1, safe_address: null, mech_address: null, staking_address: null, step: 'complete', agent_id: '7' },
          to: { staking_address: '0x1111111111111111111111111111111111111111' },
          retire_status: 'retired',
        },
        {
          migration_id: 'new',
          kind: 'base-sepolia-standard-setup',
          chain: 'base-sepolia',
          service_index: 2,
          created_at: '2026-05-01T00:00:02.000Z',
          updated_at: '2026-05-01T00:00:03.000Z',
          backup_state_path: '/tmp/new.bak',
          from: { service_id: 2, safe_address: null, mech_address: null, staking_address: null, step: 'complete', agent_id: '8' },
          to: { staking_address: '0x2222222222222222222222222222222222222222' },
          retire_status: 'failed',
        },
      ],
    };
    const detail = assembleStatusDetailV1(raw);
    expect(detail.latestSetupArchive?.backupStatePath).toBe('/tmp/new.bak');
    expect(detail.latestSetupArchive?.serviceIndexes).toEqual([2]);
  });

  it('detail.lastClaudeSession is null when no portfolioV0 outcomes', () => {
    const raw = makeRaw();
    raw.portfolioV0 = undefined;
    const detail = assembleStatusDetailV1(raw);
    expect(detail.lastClaudeSession).toBeNull();
  });

  it('detail.lastClaudeSession reflects most recent outcome', () => {
    const raw = makeRaw();
    raw.portfolioV0 = {
      totals: { delivered: 0, failed: 0, active: 0 },
      inFlight: [],
      recentVerdicts: [],
      recentSnapshots: [],
      recentClaudeOutcomes: [
        {
          requestId: 'req-abc',
          sessionId: 'sess-123',
          startedAt: 1714000000000,
          endedAt: 1714003600000,
          durationMs: 3600000,
          aborted: false,
          fillsInSessionWindow: 0,
          coinCounts: {},
        },
      ],
    };
    const detail = assembleStatusDetailV1(raw);
    expect(detail.lastClaudeSession?.requestId).toBe('req-abc');
    expect(detail.lastClaudeSession?.aborted).toBe(false);
    expect(detail.lastClaudeSession?.durationMs).toBe(3600000);
  });

  it('detail.nextActions prompts bootstrap when no fleet', () => {
    const raw = makeRaw();
    raw.fleet = null;
    const detail = assembleStatusDetailV1(raw);
    expect(detail.nextActions.some(a => a.includes('bootstrap'))).toBe(true);
  });

  it('detail.nextActions shows no-urgent when all healthy', () => {
    const raw = makeRaw();
    raw.fleet!.services = raw.fleet!.services.map(s => ({ ...s, step: 'complete' as const }));
    raw.rpc = { ok: true, chainId: 84532, blockNumber: '999' };
    const detail = assembleStatusDetailV1(raw);
    expect(detail.nextActions.some(a => a.includes('No urgent'))).toBe(true);
  });

  it('detail.fleetUpdatedAt reflects fleet updated_at', () => {
    const raw = makeRaw();
    const detail = assembleStatusDetailV1(raw);
    expect(detail.fleetUpdatedAt).toBe('2026-04-14T12:00:00.000Z');
  });
});
