import { describe, expect, it } from 'vitest';
import { deriveNotifications, gasSeverity, type DeriveInput } from './derive.js';

const baseState = {
  bootstrap: { mode: 'running' as const },
  status: {
    funds: {
      eth: '1.0',
      chains: [
        { chain: 'Base Sepolia', wallet: '0xM', runwayDays: 30, empty: false },
      ],
    },
    harness: { ready: true, name: 'claude-code', reason: null },
    rpc: { reachable: true },
    restartPending: false,
    daemonVersion: '0.1.5',
    latestVersion: '0.1.5',
    services: [{ safeBound: true }],
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
      status: {
        ...baseState.status,
        funds: {
          eth: '0.001',
          chains: [
            { chain: 'Base Sepolia', wallet: '0xM', runwayDays: 1, empty: false },
          ],
        },
      },
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

  it('does not emit update_available when latestVersion is undefined (null on the wire)', () => {
    const { latestVersion: _drop, ...rest } = baseState.status;
    const out = deriveNotifications({
      ...baseState,
      status: rest,
    });
    expect(out.map(n => n.kind)).not.toContain('update_available');
  });

  it('does not emit update_available when latestVersion equals daemonVersion', () => {
    const out = deriveNotifications({
      ...baseState,
      status: { ...baseState.status, daemonVersion: '0.1.5', latestVersion: '0.1.5' },
    });
    expect(out.map(n => n.kind)).not.toContain('update_available');
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

  it('emits safe_binding_pending when at least one service has safeBound === false', () => {
    const out = deriveNotifications({
      ...baseState,
      status: {
        ...baseState.status,
        services: [{ safeBound: false }],
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

describe('freshly-onboarded node (#983 AC5)', () => {
  it('emits no no_solvernets_joined / harness_not_ready / restart_required residue', () => {
    // A node that finished onboarding has ≥1 joined SolverNet, a ready harness,
    // and no pending restart. The 5-step guided flow gates entry to <Operating>
    // on exactly these conditions, so the derivation must produce none of the
    // three residue notifications for this state. baseState already models a
    // genuinely-clean running node.
    const out = deriveNotifications(baseState);
    const kinds = out.map((n) => n.kind);
    expect(kinds).not.toContain('no_solvernets_joined');
    expect(kinds).not.toContain('harness_not_ready');
    expect(kinds).not.toContain('restart_required');
  });
});

describe('funding notifications (issue #1296)', () => {
  function fundsStatus(chains: DeriveInput['status']['funds']['chains']): DeriveInput {
    return {
      bootstrap: { mode: 'running' },
      status: {
        funds: { eth: '0.01', chains },
        harness: { ready: true, name: null, reason: null },
        rpc: { reachable: true },
        restartPending: false,
        daemonVersion: '1.0.0',
        latestVersion: undefined,
        services: [],
        joinedSolverNets: { cid1: {} },
        passwordRotatedAt: undefined,
      },
    };
  }

  it('fires funding_low (warning) for a low-but-nonzero runway, naming wallet and chain', () => {
    const out = deriveNotifications(
      fundsStatus([
        { chain: 'Base Sepolia', wallet: '0xMASTER', runwayDays: 1, empty: false },
      ]),
    );
    const low = out.find((n) => n.kind === 'funding_low');
    expect(low).toBeDefined();
    expect(low!.severity).toBe('warning');
    expect(low!.message).toContain('Base Sepolia');
    expect(low!.message).toContain('0xMASTER');
  });

  it('fires funding_empty (blocking) when balance cannot cover the next tx, and suppresses funding_low for that chain', () => {
    const out = deriveNotifications(
      fundsStatus([
        { chain: 'Base Sepolia', wallet: '0xMASTER', runwayDays: 0, empty: true },
      ]),
    );
    const empty = out.find((n) => n.kind === 'funding_empty');
    expect(empty).toBeDefined();
    expect(empty!.severity).toBe('blocking');
    expect(empty!.message).toContain('Base Sepolia');
    expect(out.find((n) => n.kind === 'funding_low')).toBeUndefined();
  });

  it('fires a separate warning per chain (L1 + L2)', () => {
    const out = deriveNotifications(
      fundsStatus([
        { chain: 'Base Sepolia', wallet: '0xL2', runwayDays: 2, empty: false },
        { chain: 'Ethereum Sepolia', wallet: '0xL1', runwayDays: 1, empty: false },
      ]),
    );
    expect(out.filter((n) => n.kind === 'funding_low')).toHaveLength(2);
  });

  it('clears all funding notices when both chains are above threshold', () => {
    const out = deriveNotifications(
      fundsStatus([
        { chain: 'Base Sepolia', wallet: '0xL2', runwayDays: 99, empty: false },
        { chain: 'Ethereum Sepolia', wallet: '0xL1', runwayDays: 99, empty: false },
      ]),
    );
    expect(out.find((n) => n.kind === 'funding_low')).toBeUndefined();
    expect(out.find((n) => n.kind === 'funding_empty')).toBeUndefined();
  });

  it('clears funding_low and funding_empty after a top-up above threshold (AC#3)', () => {
    const before = deriveNotifications(
      fundsStatus([{ chain: 'Base Sepolia', wallet: '0xM', runwayDays: 0, empty: true }]),
    );
    expect(before.some((n) => n.kind === 'funding_empty')).toBe(true);

    const after = deriveNotifications(
      fundsStatus([{ chain: 'Base Sepolia', wallet: '0xM', runwayDays: 99, empty: false }]),
    );
    expect(after.some((n) => n.kind === 'funding_empty' || n.kind === 'funding_low')).toBe(false);
  });
});

describe('gasSeverity boundary (#1296, handbook AI workflow rule 7 — boundary tests for numeric gates)', () => {
  it('balance exactly equal to minEthWei is NOT blocking (strict less-than)', () => {
    expect(
      gasSeverity({
        balanceWei: '1000000000000000',
        minEthWei: '1000000000000000',
        runwayDaysExcess: '1',
      }),
    ).toBe('warning');
  });

  it('balance one wei below minEthWei is blocking', () => {
    expect(
      gasSeverity({
        balanceWei: '999999999999999',
        minEthWei: '1000000000000000',
        runwayDaysExcess: '1',
      }),
    ).toBe('blocking');
  });
});

describe('deriveNotifications — eviction (#773)', () => {
  it('does not emit service_evicted (removed from taxonomy)', () => {
    const out = deriveNotifications({
      ...baseState,
      status: {
        ...baseState.status,
        services: [{ safeBound: true }, { safeBound: true }],
      },
    });
    expect(out.map(n => n.kind)).not.toContain('service_evicted');
  });
});

// Coordinator amendment 1 (F7 reversed — no claim-nothing migration): the
// one-time shape-v2 migration message is always informational, never
// action-required — the host's USD spend gates remain the operative bound
// whether or not per-claim caps are set. `capsUnset` only changes the
// message copy, never the severity.
describe('deriveNotifications — config_migrated (one-time shape-v2 migration)', () => {
  it('raises config_migrated as informational when per-claim caps are unset', () => {
    const out = deriveNotifications({
      ...baseState,
      status: {
        ...baseState.status,
        configMigration: { shapeVersion: 2, wiringEntries: 1, postingEntries: 0, capsUnset: true },
      },
    });
    const migrated = out.find((n) => n.kind === 'config_migrated');
    expect(migrated).toEqual({
      kind: 'config_migrated',
      severity: 'info',
      message:
        'Claim policy and execution wiring were created from your SolverNet memberships. Per-claim caps are not set; the USD spend gates remain active.',
      jumpTo: '/operator/claim-policy',
      details: { wiringEntries: 1, postingEntries: 0 },
    });
  });

  it('raises config_migrated as info once caps are set', () => {
    const out = deriveNotifications({
      ...baseState,
      status: {
        ...baseState.status,
        configMigration: { shapeVersion: 2, wiringEntries: 1, postingEntries: 1, capsUnset: false },
      },
    });
    const migrated = out.find((n) => n.kind === 'config_migrated');
    expect(migrated).toEqual({
      kind: 'config_migrated',
      severity: 'info',
      message: 'Claim policy and execution wiring were created from your SolverNet memberships.',
      jumpTo: '/operator/claim-policy',
      details: { wiringEntries: 1, postingEntries: 1 },
    });
  });
});
