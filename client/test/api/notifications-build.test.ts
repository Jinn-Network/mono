/**
 * Parity port of the (now-deleted) SPA `notifications/derive.test.ts` +
 * `notifications/useNotifications.test.ts` — same fixtures, same expected notifications,
 * against the server-side `buildNotifications` / `fundsChainFromGasBlock` in
 * `client/src/api/notifications-build.ts` (issue #2408, spec §6.5). Field names are flattened
 * to `NotificationsBuildInput`'s shape (no more `bootstrap.mode` / `status.funds` nesting) but
 * the fixtures and assertions are otherwise unchanged from the browser deriver's suite.
 */
import { describe, expect, it } from 'vitest';
import {
  buildNotifications,
  countRecentClaimFailures,
  fundsChainFromGasBlock,
  gasSeverity,
  type NotificationsBuildInput,
} from '../../src/api/notifications-build.js';

const baseInput: NotificationsBuildInput = {
  bootstrapMode: 'running',
  joinedSolverNets: { 'bafkreic-x': {} },
  funds: {
    chains: [{ chain: 'Base Sepolia', wallet: '0xM', runwayDays: 30, empty: false }],
  },
  harness: { ready: true, name: 'claude-code', reason: null },
  rpc: { reachable: true },
  restartRequired: false,
  daemonVersion: '0.1.5',
  latestVersion: '0.1.5',
  services: [{ safeBound: true }],
};

describe('buildNotifications', () => {
  it('returns empty when everything is healthy', () => {
    expect(buildNotifications(baseInput)).toEqual([]);
  });

  it('emits funding_low when runway < 3 days', () => {
    const out = buildNotifications({
      ...baseInput,
      funds: { chains: [{ chain: 'Base Sepolia', wallet: '0xM', runwayDays: 1, empty: false }] },
    });
    expect(out).toContainEqual(
      expect.objectContaining({ kind: 'funding_low', severity: 'warning', title: 'Gas runway low' }),
    );
  });

  it('emits harness_not_ready when harness is unavailable', () => {
    const out = buildNotifications({
      ...baseInput,
      harness: { ready: false, name: 'claude-code', reason: 'not authenticated' },
    });
    expect(out).toContainEqual(
      expect.objectContaining({
        kind: 'harness_not_ready',
        severity: 'blocking',
        message: expect.stringContaining('claude-code'),
      }),
    );
  });

  it('emits no_solvernets_joined when joinedSolverNets is empty', () => {
    const out = buildNotifications({ ...baseInput, joinedSolverNets: {} });
    expect(out.map((n) => n.kind)).toContain('no_solvernets_joined');
  });

  it('emits restart_required when restartRequired is true (config-file-newer-than-boot)', () => {
    const out = buildNotifications({ ...baseInput, restartRequired: true });
    expect(out).toContainEqual(expect.objectContaining({ kind: 'restart_required', severity: 'warning' }));
  });

  it('emits update_available when daemonVersion < latestVersion', () => {
    const out = buildNotifications({ ...baseInput, daemonVersion: '0.1.4', latestVersion: '0.1.5' });
    expect(out.map((n) => n.kind)).toContain('update_available');
  });

  it('does not emit update_available when latestVersion is undefined', () => {
    const { latestVersion: _drop, ...rest } = baseInput;
    const out = buildNotifications(rest);
    expect(out.map((n) => n.kind)).not.toContain('update_available');
  });

  it('does not emit update_available when latestVersion equals daemonVersion', () => {
    const out = buildNotifications({ ...baseInput, daemonVersion: '0.1.5', latestVersion: '0.1.5' });
    expect(out.map((n) => n.kind)).not.toContain('update_available');
  });

  it('does not duplicate categories (each canonical kind emits at most once)', () => {
    const out = buildNotifications({ ...baseInput, restartRequired: true });
    const kinds = out.map((n) => n.kind);
    expect(new Set(kinds).size).toBe(kinds.length);
  });

  it('emits bootstrap_blocked when mode is not running', () => {
    const out = buildNotifications({
      ...baseInput,
      bootstrapMode: 'setup',
      bootstrapBlockingReason: 'Wallet needs ETH',
    });
    expect(out).toContainEqual(
      expect.objectContaining({ kind: 'bootstrap_blocked', severity: 'blocking', message: 'Wallet needs ETH' }),
    );
  });

  it('emits bootstrap_blocked with fallback message when blockingReason is absent', () => {
    const out = buildNotifications({ ...baseInput, bootstrapMode: 'setup' });
    expect(out).toContainEqual(
      expect.objectContaining({ kind: 'bootstrap_blocked', message: 'Bootstrap incomplete' }),
    );
  });

  it('emits rpc_unreachable when rpc.reachable is false', () => {
    const out = buildNotifications({ ...baseInput, rpc: { reachable: false } });
    expect(out).toContainEqual(expect.objectContaining({ kind: 'rpc_unreachable', severity: 'blocking' }));
  });

  it('emits safe_binding_pending when at least one service has safeBound === false', () => {
    const out = buildNotifications({ ...baseInput, services: [{ safeBound: false }] });
    expect(out).toContainEqual(expect.objectContaining({ kind: 'safe_binding_pending', severity: 'warning' }));
  });

  it('emits password_rotation_due when password age exceeds 90 days', () => {
    const rotatedAt = new Date('2026-01-01T00:00:00Z').toISOString();
    const now = new Date('2026-05-01T00:00:00Z').getTime(); // 120 days after rotation
    const out = buildNotifications({ ...baseInput, now, passwordRotatedAt: rotatedAt });
    expect(out.map((n) => n.kind)).toContain('password_rotation_due');
  });

  it('does not emit password_rotation_due when password is fresh', () => {
    const rotatedAt = new Date('2026-05-15T00:00:00Z').toISOString();
    const now = new Date('2026-05-20T00:00:00Z').getTime(); // 5 days after rotation
    const out = buildNotifications({ ...baseInput, now, passwordRotatedAt: rotatedAt });
    expect(out.map((n) => n.kind)).not.toContain('password_rotation_due');
  });
});

describe('freshly-onboarded node (#983 AC5, ported)', () => {
  it('emits no no_solvernets_joined / harness_not_ready / restart_required residue', () => {
    const out = buildNotifications(baseInput);
    const kinds = out.map((n) => n.kind);
    expect(kinds).not.toContain('no_solvernets_joined');
    expect(kinds).not.toContain('harness_not_ready');
    expect(kinds).not.toContain('restart_required');
  });
});

describe('funding notifications (issue #1296, ported)', () => {
  function fundsInput(chains: NotificationsBuildInput['funds']['chains']): NotificationsBuildInput {
    return {
      bootstrapMode: 'running',
      joinedSolverNets: { cid1: {} },
      funds: { chains },
      harness: { ready: true, name: null, reason: null },
      rpc: { reachable: true },
      restartRequired: false,
      daemonVersion: '1.0.0',
      services: [],
    };
  }

  it('fires funding_low (warning) for a low-but-nonzero runway, naming wallet and chain', () => {
    const out = buildNotifications(
      fundsInput([{ chain: 'Base Sepolia', wallet: '0xMASTER', runwayDays: 1, empty: false }]),
    );
    const low = out.find((n) => n.kind === 'funding_low');
    expect(low).toBeDefined();
    expect(low!.severity).toBe('warning');
    expect(low!.message).toContain('Base Sepolia');
    expect(low!.message).toContain('0xMASTER');
  });

  it('fires funding_empty (blocking) when balance cannot cover the next tx, and suppresses funding_low for that chain', () => {
    const out = buildNotifications(
      fundsInput([{ chain: 'Base Sepolia', wallet: '0xMASTER', runwayDays: 0, empty: true }]),
    );
    const empty = out.find((n) => n.kind === 'funding_empty');
    expect(empty).toBeDefined();
    expect(empty!.severity).toBe('blocking');
    expect(empty!.message).toContain('Base Sepolia');
    expect(out.find((n) => n.kind === 'funding_low')).toBeUndefined();
  });

  it('fires a separate warning per chain (L1 + L2)', () => {
    const out = buildNotifications(
      fundsInput([
        { chain: 'Base Sepolia', wallet: '0xL2', runwayDays: 2, empty: false },
        { chain: 'Ethereum Sepolia', wallet: '0xL1', runwayDays: 1, empty: false },
      ]),
    );
    expect(out.filter((n) => n.kind === 'funding_low')).toHaveLength(2);
  });

  it('clears all funding notices when both chains are above threshold', () => {
    const out = buildNotifications(
      fundsInput([
        { chain: 'Base Sepolia', wallet: '0xL2', runwayDays: 99, empty: false },
        { chain: 'Ethereum Sepolia', wallet: '0xL1', runwayDays: 99, empty: false },
      ]),
    );
    expect(out.find((n) => n.kind === 'funding_low')).toBeUndefined();
    expect(out.find((n) => n.kind === 'funding_empty')).toBeUndefined();
  });
});

describe('gasSeverity boundary (#1296, ported)', () => {
  it('balance exactly equal to minEthWei is NOT blocking (strict less-than)', () => {
    expect(gasSeverity({ balanceWei: '1000000000000000', minEthWei: '1000000000000000', runwayDaysExcess: '1' })).toBe(
      'warning',
    );
  });

  it('balance one wei below minEthWei is blocking', () => {
    expect(gasSeverity({ balanceWei: '999999999999999', minEthWei: '1000000000000000', runwayDaysExcess: '1' })).toBe(
      'blocking',
    );
  });
});

describe('config_migrated (one-time shape-v2 migration, ported)', () => {
  it('raises config_migrated as informational when per-claim caps are unset', () => {
    const out = buildNotifications({
      ...baseInput,
      configMigration: { shapeVersion: 2, wiringEntries: 1, postingEntries: 0, capsUnset: true },
    });
    const migrated = out.find((n) => n.kind === 'config_migrated');
    expect(migrated).toEqual({
      kind: 'config_migrated',
      severity: 'info',
      title: 'Config migrated',
      message:
        'Claim policy and execution wiring were created from your SolverNet memberships. Per-claim caps are not set; the USD spend gates remain active.',
      jumpTo: '/operator/claim-policy',
      details: { wiringEntries: 1, postingEntries: 0 },
    });
  });

  it('raises config_migrated as info once caps are set', () => {
    const out = buildNotifications({
      ...baseInput,
      configMigration: { shapeVersion: 2, wiringEntries: 1, postingEntries: 1, capsUnset: false },
    });
    const migrated = out.find((n) => n.kind === 'config_migrated');
    expect(migrated).toEqual({
      kind: 'config_migrated',
      severity: 'info',
      title: 'Config migrated',
      message: 'Claim policy and execution wiring were created from your SolverNet memberships.',
      jumpTo: '/operator/claim-policy',
      details: { wiringEntries: 1, postingEntries: 1 },
    });
  });
});

// ── RPC-health kinds (spec §6.5 — newly implementable server-side, issue #2408) ────────────

describe('rpc_all_failed / rpc_primary_degraded (new — live-health class carries slot health)', () => {
  it('emits rpc_all_failed when every configured slot failed', () => {
    const out = buildNotifications({
      ...baseInput,
      rpcSlotHealth: [
        { ok: false, host: 'primary.example' },
        { ok: false, host: 'secondary.example' },
      ],
    });
    expect(out).toContainEqual(
      expect.objectContaining({ kind: 'rpc_all_failed', severity: 'blocking' }),
    );
    expect(out.map((n) => n.kind)).not.toContain('rpc_primary_degraded');
  });

  it('emits rpc_primary_degraded when slot 0 failed but a fallback slot served', () => {
    const out = buildNotifications({
      ...baseInput,
      rpcSlotHealth: [
        { ok: false, host: 'primary.example' },
        { ok: true, host: 'secondary.example' },
      ],
    });
    expect(out).toContainEqual(
      expect.objectContaining({ kind: 'rpc_primary_degraded', severity: 'info' }),
    );
    expect(out.map((n) => n.kind)).not.toContain('rpc_all_failed');
  });

  it('emits neither when the primary slot is healthy', () => {
    const out = buildNotifications({
      ...baseInput,
      rpcSlotHealth: [{ ok: true, host: 'primary.example' }],
    });
    expect(out.map((n) => n.kind)).not.toContain('rpc_all_failed');
    expect(out.map((n) => n.kind)).not.toContain('rpc_primary_degraded');
  });

  it('emits neither when no slot-health data is supplied', () => {
    const out = buildNotifications(baseInput);
    expect(out.map((n) => n.kind)).not.toContain('rpc_all_failed');
    expect(out.map((n) => n.kind)).not.toContain('rpc_primary_degraded');
  });
});

describe('evidence_indexing_failed (new — server-side driver state the browser never had)', () => {
  it('emits when the failure count is positive', () => {
    const out = buildNotifications({ ...baseInput, evidenceIndexingFailureCount: 2 });
    expect(out).toContainEqual(expect.objectContaining({ kind: 'evidence_indexing_failed', severity: 'info' }));
  });

  it('stays silent when the failure count is zero or absent', () => {
    expect(buildNotifications({ ...baseInput, evidenceIndexingFailureCount: 0 }).map((n) => n.kind)).not.toContain(
      'evidence_indexing_failed',
    );
    expect(buildNotifications(baseInput).map((n) => n.kind)).not.toContain('evidence_indexing_failed');
  });
});

describe('claim_failed (moved from the SSE-ring hook — issue #442, re-homed #2408)', () => {
  it('emits with the count + window in details when the server-side summary reports failures', () => {
    const out = buildNotifications({ ...baseInput, claimFailed: { count: 3, sinceMs: 1000 } });
    const cf = out.find((n) => n.kind === 'claim_failed');
    expect(cf).toBeDefined();
    expect(cf!.severity).toBe('warning');
    expect(cf!.message).toBe('3 claim attempts failed in the last 30 minutes. Check Tasks for details.');
    expect(cf!.details).toEqual({ count: 3, sinceMs: 1000 });
  });

  it('singular phrasing for exactly one failure', () => {
    const out = buildNotifications({ ...baseInput, claimFailed: { count: 1, sinceMs: 0 } });
    expect(out.find((n) => n.kind === 'claim_failed')!.message).toMatch(/^1 claim attempt /);
  });

  it('stays silent when the summary reports zero', () => {
    expect(
      buildNotifications({ ...baseInput, claimFailed: { count: 0, sinceMs: 0 } }).map((n) => n.kind),
    ).not.toContain('claim_failed');
  });
});

describe('countRecentClaimFailures', () => {
  const NOW = new Date('2026-05-20T00:00:00Z').getTime();

  it('counts only intent/claim_failed events within the 30-minute window', () => {
    const { count, sinceMs } = countRecentClaimFailures(
      [
        { kind: 'intent', errorCode: 'claim_failed', ts: new Date(NOW - 5 * 60 * 1000).toISOString() },
        { kind: 'intent', errorCode: 'claim_failed', ts: new Date(NOW - 31 * 60 * 1000).toISOString() }, // stale
        { kind: 'intent', errorCode: 'some_other_code', ts: new Date(NOW).toISOString() }, // wrong errorCode
        { kind: 'reward', errorCode: 'claim_failed', ts: new Date(NOW).toISOString() }, // wrong kind
      ],
      NOW,
    );
    expect(count).toBe(1);
    expect(sinceMs).toBe(NOW - 30 * 60 * 1000);
  });

  it('returns zero for an empty event list', () => {
    expect(countRecentClaimFailures([], NOW).count).toBe(0);
  });

  it('ignores events with an unparsable timestamp rather than throwing', () => {
    expect(
      countRecentClaimFailures([{ kind: 'intent', errorCode: 'claim_failed', ts: 'not-a-date' }], NOW).count,
    ).toBe(0);
  });
});

// ── funds-chain adapter (server-side twin of the pre-#2408 `gasChain`, ported) ─────────────

describe('fundsChainFromGasBlock — funds mapping (issue #1296, ported)', () => {
  it('maps a low-but-nonzero L2 runway to a low chain entry (not Infinity)', () => {
    const c = fundsChainFromGasBlock('Base Sepolia', {
      address: '0xL2MASTER',
      balanceWei: '5000000000000000', // 0.005 ETH, > 0
      runwayDaysExcess: '1',
      minEthWei: '1000000000000000',
    });
    expect(c).not.toBeNull();
    expect(c!.runwayDays).toBe(1); // NOT Infinity
    expect(c!.empty).toBe(false);
  });

  it('flags empty when balanceWei < minEthWei', () => {
    const c = fundsChainFromGasBlock('Base Sepolia', {
      address: '0xL2MASTER',
      balanceWei: '500000000000000', // 0.0005 ETH
      runwayDaysExcess: '0',
      minEthWei: '1000000000000000',
    });
    expect(c!.empty).toBe(true);
  });

  it('returns null when the gas block carries no balance', () => {
    expect(fundsChainFromGasBlock('Base Sepolia', { address: null })).toBeNull();
    expect(fundsChainFromGasBlock('Base Sepolia', undefined)).toBeNull();
  });

  it('defaults runwayDays to +Infinity when runwayDaysExcess is absent', () => {
    const c = fundsChainFromGasBlock('Base Sepolia', { address: '0xM', balanceWei: '1' });
    expect(c!.runwayDays).toBe(Number.POSITIVE_INFINITY);
  });
});

describe('fundsChainFromGasBlock gas gate boundary (#1296, handbook AI workflow rule 7 — boundary tests for numeric gates)', () => {
  it('balance exactly equal to minEthWei is NOT empty (strict less-than)', () => {
    const c = fundsChainFromGasBlock('Base Sepolia', {
      address: '0xL2MASTER',
      balanceWei: '1000000000000000',
      runwayDaysExcess: '1',
      minEthWei: '1000000000000000',
    });
    expect(c!.empty).toBe(false);
  });

  it('balance one wei below minEthWei is empty', () => {
    const c = fundsChainFromGasBlock('Base Sepolia', {
      address: '0xL2MASTER',
      balanceWei: '999999999999999',
      runwayDaysExcess: '1',
      minEthWei: '1000000000000000',
    });
    expect(c!.empty).toBe(true);
  });
});
