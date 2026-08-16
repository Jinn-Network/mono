/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest';
import {
  hasConfiguredEvaluatorRole,
  resolveTaskNativeReadiness,
} from '../../src/cli/task-native-readiness.js';
import type { JinnConfig } from '../../src/config.js';

const SOLVER_WIRING = {
  workKind: 'prediction.v1',
  harness: 'claude-code',
  model: 'claude-haiku-4-5-20251001',
  plugins: [],
  credentialRef: 'claude-code-default',
  isolationPolicy: 'process' as const,
};

const EVALUATOR_WIRING = {
  workKind: 'swe-rebench-v2.v1',
  harness: 'swe-rebench-v2-evaluator',
  model: 'claude-haiku-4-5-20251001',
  plugins: [],
  credentialRef: 'swe-rebench-v2-evaluator-default',
  isolationPolicy: 'process' as const,
};

describe('resolveTaskNativeReadiness — evaluator-role gate (issue #421)', () => {
  it('does not treat evaluator config as ready when mainnet short-circuits first', () => {
    // Use mainnet so the deployment-artifact gate short-circuits before we
    // try to load fleet state; we only need to assert that the helper does
    // not reach for retired solverNets / joinedSolverNets fields.
    const config = {
      network: 'mainnet',
      earningDir: '/tmp',
      evaluator: { enabled: true },
      executionWiring: [EVALUATOR_WIRING],
    } as unknown as JinnConfig;
    // The mainnet path short-circuits before we even look at evaluator-role —
    // structural readiness on this branch is `ok: false` (no testnet artifact
    // bundle), but evaluator-role detection runs further downstream when
    // solverReady is true; we only need to assert the surface shape here.
    const readiness = resolveTaskNativeReadiness(config);
    expect(readiness.evaluatorRoleReady).toBe(false);
    expect(typeof readiness.detail).toBe('string');
  });

  it('does not throw when executionWiring is undefined (legacy config drained)', () => {
    const config = {
      network: 'mainnet',
      earningDir: '/tmp',
    } as unknown as JinnConfig;
    expect(() => resolveTaskNativeReadiness(config)).not.toThrow();
  });
});

describe('hasConfiguredEvaluatorRole', () => {
  function makeConfig(partial: {
    evaluator?: { enabled?: boolean };
    executionWiring?: JinnConfig['executionWiring'];
  }): JinnConfig {
    return partial as unknown as JinnConfig;
  }

  it('returns false when executionWiring is empty', () => {
    expect(hasConfiguredEvaluatorRole(makeConfig({ executionWiring: [] }))).toBe(false);
  });

  it('returns false when executionWiring is undefined', () => {
    expect(hasConfiguredEvaluatorRole({} as unknown as JinnConfig)).toBe(false);
  });

  it('returns false when the only wiring harness is solver-only', () => {
    expect(hasConfiguredEvaluatorRole(makeConfig({ executionWiring: [SOLVER_WIRING] }))).toBe(false);
  });

  it('returns true when evaluator.enabled is true', () => {
    expect(hasConfiguredEvaluatorRole(makeConfig({ evaluator: { enabled: true } }))).toBe(true);
  });

  it('returns true when a wiring harness includes evaluator', () => {
    expect(hasConfiguredEvaluatorRole(makeConfig({ executionWiring: [EVALUATOR_WIRING] }))).toBe(true);
  });

  it('returns true when at least one of several wiring entries has an evaluator harness', () => {
    const config = makeConfig({
      executionWiring: [SOLVER_WIRING, EVALUATOR_WIRING, { ...SOLVER_WIRING, workKind: 'other.v1' }],
    });
    expect(hasConfiguredEvaluatorRole(config)).toBe(true);
  });

  it('returns false when none of several wiring harnesses include evaluator', () => {
    const config = makeConfig({
      executionWiring: [
        SOLVER_WIRING,
        { ...SOLVER_WIRING, workKind: 'other.v1' },
      ],
    });
    expect(hasConfiguredEvaluatorRole(config)).toBe(false);
  });
});
