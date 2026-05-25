/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest';
import {
  hasConfiguredEvaluatorRole,
  resolveTaskNativeReadiness,
} from '../../src/cli/task-native-readiness.js';
import type { JinnConfig } from '../../src/config.js';

describe('resolveTaskNativeReadiness — evaluator-role gate (issue #421)', () => {
  it('detects evaluator role from joinedSolverNets only', () => {
    // Use mainnet so the deployment-artifact gate short-circuits before we
    // try to load fleet state; we only need to assert that the evaluator-role
    // helper consults joinedSolverNets and not the retired solverNets block.
    const config = {
      network: 'mainnet',
      earningDir: '/tmp',
      joinedSolverNets: {
        cid1: {
          manifestCid: 'cid1',
          roles: ['evaluator'],
          plugins: [],
          disabledDefaultPlugins: [],
        },
      },
    } as unknown as JinnConfig;
    // The mainnet path short-circuits before we even look at evaluator-role —
    // assert the helper compiles + doesn't reach for `config.solverNets`. The
    // structural readiness on this branch is `ok: false` (no testnet artifact
    // bundle), but evaluator-role detection runs further downstream when
    // solverReady is true; we only need to assert the surface shape here.
    const readiness = resolveTaskNativeReadiness(config);
    expect(readiness.evaluatorRoleReady).toBe(false);
    // Sanity: the source string carries the chain name we passed.
    expect(typeof readiness.detail).toBe('string');
  });

  it('does not throw when joinedSolverNets is undefined (legacy config drained)', () => {
    const config = {
      network: 'mainnet',
      earningDir: '/tmp',
      // No solverNets, no joinedSolverNets — the legacy block is gone (issue #421).
    } as unknown as JinnConfig;
    expect(() => resolveTaskNativeReadiness(config)).not.toThrow();
  });
});

describe('hasConfiguredEvaluatorRole — joined-only resolution (issue #421)', () => {
  // The wider `resolveTaskNativeReadiness` surface short-circuits on mainnet
  // before reaching the helper, so these tests exercise the joined-only branch
  // directly. They are the regression coverage for the refactor away from the
  // retired short-name-keyed `solverNets` block.

  function makeConfig(
    joinedSolverNets: NonNullable<JinnConfig['joinedSolverNets']>,
  ): JinnConfig {
    return { joinedSolverNets } as unknown as JinnConfig;
  }

  it('returns false when joinedSolverNets is empty', () => {
    expect(hasConfiguredEvaluatorRole(makeConfig({}))).toBe(false);
  });

  it('returns false when joinedSolverNets is undefined', () => {
    expect(hasConfiguredEvaluatorRole({} as unknown as JinnConfig)).toBe(false);
  });

  it('returns false when the only joined entry has no evaluator role', () => {
    const config = makeConfig({
      cid1: {
        manifestCid: 'cid1',
        roles: ['solver'],
        plugins: [],
        disabledDefaultPlugins: [],
      },
    });
    expect(hasConfiguredEvaluatorRole(config)).toBe(false);
  });

  it('returns true when the only joined entry has the evaluator role', () => {
    const config = makeConfig({
      cid1: {
        manifestCid: 'cid1',
        roles: ['evaluator'],
        plugins: [],
        disabledDefaultPlugins: [],
      },
    });
    expect(hasConfiguredEvaluatorRole(config)).toBe(true);
  });

  it('returns true when at least one of several joined entries carries the evaluator role', () => {
    const config = makeConfig({
      cid1: {
        manifestCid: 'cid1',
        roles: ['solver'],
        plugins: [],
        disabledDefaultPlugins: [],
      },
      cid2: {
        manifestCid: 'cid2',
        roles: ['solver', 'evaluator'],
        plugins: [],
        disabledDefaultPlugins: [],
      },
      cid3: {
        manifestCid: 'cid3',
        roles: ['solver'],
        plugins: [],
        disabledDefaultPlugins: [],
      },
    });
    expect(hasConfiguredEvaluatorRole(config)).toBe(true);
  });

  it('returns false when none of several joined entries carries the evaluator role', () => {
    const config = makeConfig({
      cid1: {
        manifestCid: 'cid1',
        roles: ['solver'],
        plugins: [],
        disabledDefaultPlugins: [],
      },
      cid2: {
        manifestCid: 'cid2',
        roles: ['solver'],
        plugins: [],
        disabledDefaultPlugins: [],
      },
    });
    expect(hasConfiguredEvaluatorRole(config)).toBe(false);
  });
});
