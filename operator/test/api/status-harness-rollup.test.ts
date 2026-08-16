import { describe, expect, it } from 'vitest';
import { buildHarnessRollup } from '../../src/api/status-harness-rollup.js';
import type {
  HarnessReadinessSnapshot,
  JoinedHarnessSpec,
} from '../../src/harnesses/readiness-registry.js';

function snapshot(
  entries: HarnessReadinessSnapshot['harnesses'],
): HarnessReadinessSnapshot {
  return {
    lastRefreshedAt: '2026-05-26T00:00:00.000Z',
    harnesses: entries,
  };
}

describe('buildHarnessRollup', () => {
  it('returns default-ready when joinedSolverNets is empty', () => {
    const snap = snapshot([
      { harnessName: 'claude-code', manifestCids: [], ready: false, reason: 'not authenticated' },
    ]);
    const joined: Record<string, JoinedHarnessSpec> = {};
    expect(buildHarnessRollup(snap, joined)).toEqual({
      ready: true,
      name: null,
      reason: null,
    });
  });

  it('returns default-ready when snapshot.harnesses is empty (pre-first-refresh)', () => {
    const snap = snapshot([]);
    const joined: Record<string, JoinedHarnessSpec> = {
      'bafkre-a': { harnessName: 'claude-code', roles: ['solver'] },
    };
    expect(buildHarnessRollup(snap, joined)).toEqual({
      ready: true,
      name: null,
      reason: null,
    });
  });

  it('returns ready when every joined harness is ready', () => {
    const snap = snapshot([
      { harnessName: 'claude-code', manifestCids: ['bafkre-a'], ready: true },
      { harnessName: 'codex', manifestCids: ['bafkre-b'], ready: true },
    ]);
    const joined: Record<string, JoinedHarnessSpec> = {
      'bafkre-a': { harnessName: 'claude-code', roles: ['solver'] },
      'bafkre-b': { harnessName: 'codex', roles: ['evaluator'] },
    };
    expect(buildHarnessRollup(snap, joined)).toEqual({
      ready: true,
      name: null,
      reason: null,
    });
  });

  it('returns not-ready with name + reason when a joined harness is unready', () => {
    const snap = snapshot([
      { harnessName: 'claude-code', manifestCids: ['bafkre-a'], ready: true },
      {
        harnessName: 'codex',
        manifestCids: ['bafkre-b'],
        ready: false,
        reason: 'subscription_expired',
      },
    ]);
    const joined: Record<string, JoinedHarnessSpec> = {
      'bafkre-a': { harnessName: 'claude-code', roles: ['solver'] },
      'bafkre-b': { harnessName: 'codex', roles: ['solver'] },
    };
    expect(buildHarnessRollup(snap, joined)).toEqual({
      ready: false,
      name: 'codex',
      reason: 'subscription_expired',
    });
  });

  it('ignores unready harnesses that are registered but not joined', () => {
    // The registry's snapshot includes every registered harness — including
    // ones the operator has not joined — so the SPA join form can disable
    // not-ready options before any join exists. The rollup must filter
    // those out: an unjoined harness cannot drive harness_not_ready.
    const snap = snapshot([
      {
        harnessName: 'codex',
        manifestCids: [],
        ready: false,
        reason: 'not authenticated',
      },
    ]);
    const joined: Record<string, JoinedHarnessSpec> = {
      'bafkre-a': { harnessName: 'claude-code', roles: ['solver'] },
    };
    expect(buildHarnessRollup(snap, joined)).toEqual({
      ready: true,
      name: null,
      reason: null,
    });
  });

  it('picks the first unready joined harness by snapshot order when multiple are unready', () => {
    const snap = snapshot([
      {
        harnessName: 'claude-code',
        manifestCids: ['bafkre-a'],
        ready: false,
        reason: 'not authenticated',
      },
      {
        harnessName: 'codex',
        manifestCids: ['bafkre-b'],
        ready: false,
        reason: 'subscription_expired',
      },
    ]);
    const joined: Record<string, JoinedHarnessSpec> = {
      'bafkre-a': { harnessName: 'claude-code', roles: ['solver'] },
      'bafkre-b': { harnessName: 'codex', roles: ['solver'] },
    };
    expect(buildHarnessRollup(snap, joined)).toEqual({
      ready: false,
      name: 'claude-code',
      reason: 'not authenticated',
    });
  });

  it('normalises missing reason to null on an unready entry', () => {
    const snap = snapshot([
      { harnessName: 'claude-code', manifestCids: ['bafkre-a'], ready: false },
    ]);
    const joined: Record<string, JoinedHarnessSpec> = {
      'bafkre-a': { harnessName: 'claude-code', roles: ['solver'] },
    };
    expect(buildHarnessRollup(snap, joined)).toEqual({
      ready: false,
      name: 'claude-code',
      reason: null,
    });
  });
});
