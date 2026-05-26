import { describe, expect, it } from 'vitest';
import { deriveNotifications } from './derive.js';

const baseState = {
  bootstrap: { mode: 'running' as const },
  status: {
    funds: { eth: '1.0', runwayDays: 30 },
    harness: { ready: true, name: 'claude-code', reason: null },
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

  it('emits bootstrap_blocked when mode is not running', () => {
    const out = deriveNotifications({
      ...baseState,
      bootstrap: { mode: 'awaiting_funding', blockingReason: 'Wallet needs ETH' },
    });
    expect(out).toContainEqual(expect.objectContaining({
      kind: 'bootstrap_blocked',
      severity: 'blocking',
      message: 'Wallet needs ETH',
    }));
  });

  it('emits bootstrap_blocked with fallback message when blockingReason is absent', () => {
    const out = deriveNotifications({
      ...baseState,
      bootstrap: { mode: 'awaiting_funding' },
    });
    expect(out).toContainEqual(expect.objectContaining({
      kind: 'bootstrap_blocked',
      message: 'Bootstrap incomplete',
    }));
  });

  it('emits rpc_unreachable when rpc.reachable is false', () => {
    const out = deriveNotifications({
      ...baseState,
      status: { ...baseState.status, rpc: { reachable: false } },
    });
    expect(out).toContainEqual(expect.objectContaining({
      kind: 'rpc_unreachable',
      severity: 'blocking',
    }));
  });

  it('emits service_evicted when at least one service has evicted === true', () => {
    const out = deriveNotifications({
      ...baseState,
      status: {
        ...baseState.status,
        services: [
          { evicted: false, safeBound: true },
          { evicted: true, safeBound: true },
        ],
      },
    });
    expect(out.map(n => n.kind)).toContain('service_evicted');
  });

  it('emits safe_binding_pending when at least one service has safeBound === false', () => {
    const out = deriveNotifications({
      ...baseState,
      status: {
        ...baseState.status,
        services: [{ evicted: false, safeBound: false }],
      },
    });
    expect(out).toContainEqual(expect.objectContaining({
      kind: 'safe_binding_pending',
      severity: 'warning',
    }));
  });

  it('emits password_rotation_due when password age exceeds 90 days', () => {
    const rotatedAt = new Date('2026-01-01T00:00:00Z').toISOString();
    // 120 days after rotation
    const now = new Date('2026-05-01T00:00:00Z').getTime();
    const out = deriveNotifications({
      ...baseState,
      now,
      status: { ...baseState.status, passwordRotatedAt: rotatedAt },
    });
    expect(out.map(n => n.kind)).toContain('password_rotation_due');
  });

  it('does not emit password_rotation_due when password is fresh', () => {
    const rotatedAt = new Date('2026-05-15T00:00:00Z').toISOString();
    // only 5 days after rotation
    const now = new Date('2026-05-20T00:00:00Z').getTime();
    const out = deriveNotifications({
      ...baseState,
      now,
      status: { ...baseState.status, passwordRotatedAt: rotatedAt },
    });
    expect(out.map(n => n.kind)).not.toContain('password_rotation_due');
  });

  it('does not emit claim_available from collector reward claimableWei', () => {
    const out = deriveNotifications({
      ...baseState,
      status: { ...baseState.status, rewards: { claimableWei: '1' } },
    } as Parameters<typeof deriveNotifications>[0] & {
      status: { rewards: { claimableWei: string } };
    });
    expect(out.map(n => n.kind)).not.toContain('claim_available');
  });

  it('ignores malformed collector claimableWei without throwing', () => {
    const out = deriveNotifications({
      ...baseState,
      status: { ...baseState.status, rewards: { claimableWei: 'not-a-number' } },
    } as Parameters<typeof deriveNotifications>[0] & {
      status: { rewards: { claimableWei: string } };
    });
    expect(out.map(n => n.kind)).not.toContain('claim_available');
  });
});
