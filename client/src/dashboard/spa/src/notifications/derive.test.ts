import { describe, expect, it } from 'vitest';
import { deriveNotifications } from './derive.js';

const baseState = {
  bootstrap: { mode: 'running' as const },
  status: {
    funds: { eth: '1.0', runwayDays: 30 },
    rewards: { claimableWei: '0' },
    harness: { ready: true, name: 'claude-code' },
    rpc: { reachable: true },
    restartPending: false,
    daemonVersion: '0.1.5',
    latestVersion: '0.1.5',
    services: [{ evicted: false, safeBound: true }],
    joinedSolverNets: { 'bafkreic-x': {} },
  },
};

describe('deriveNotifications', () => {
  it('returns empty when everything is healthy', () => {
    expect(deriveNotifications(baseState)).toEqual([]);
  });

  it('emits funding_low when runway < 3 days', () => {
    const out = deriveNotifications({
      ...baseState,
      status: { ...baseState.status, funds: { eth: '0.001', runwayDays: 1 } },
    });
    expect(out).toContainEqual(expect.objectContaining({
      kind: 'funding_low',
      severity: 'warning',
    }));
  });

  it('emits harness_not_ready when harness is unavailable', () => {
    const out = deriveNotifications({
      ...baseState,
      status: { ...baseState.status, harness: { ready: false, name: 'claude-code', reason: 'not authenticated' } },
    });
    expect(out).toContainEqual(expect.objectContaining({
      kind: 'harness_not_ready',
      severity: 'blocking',
      message: expect.stringContaining('claude-code'),
    }));
  });

  it('emits no_solvernets_joined when joinedSolverNets is empty', () => {
    const out = deriveNotifications({
      ...baseState,
      status: { ...baseState.status, joinedSolverNets: {} },
    });
    expect(out.map(n => n.kind)).toContain('no_solvernets_joined');
  });

  it('emits restart_required when restartPending is true', () => {
    const out = deriveNotifications({
      ...baseState,
      status: { ...baseState.status, restartPending: true },
    });
    expect(out).toContainEqual(expect.objectContaining({
      kind: 'restart_required',
      severity: 'warning',
    }));
  });

  it('emits update_available when daemonVersion < latestVersion', () => {
    const out = deriveNotifications({
      ...baseState,
      status: { ...baseState.status, daemonVersion: '0.1.4', latestVersion: '0.1.5' },
    });
    expect(out.map(n => n.kind)).toContain('update_available');
  });

  it('does not duplicate categories (each canonical kind emits at most once)', () => {
    const out = deriveNotifications({
      ...baseState,
      status: { ...baseState.status, restartPending: true },
    });
    const kinds = out.map(n => n.kind);
    expect(new Set(kinds).size).toBe(kinds.length);
  });
});
