import { describe, expect, it } from 'vitest';
import { loadSolverNets } from '../../src/solver-nets/registry.js';
import { SOLVER_NET_CONTRACTS } from '../../src/solver-nets/contracts.js';
import { makePredictionV1Task } from '../harnesses/impls/prediction-v1-test-helpers.js';

describe('SolverNet contracts', () => {
  it('registers prediction.v1 contract authority', () => {
    const contract = SOLVER_NET_CONTRACTS['prediction.v1'];
    expect(contract?.solverType).toBe('prediction.v1');
    expect(contract?.claimPolicyDefaults).toMatchObject({
      kind: 'parallel',
      maxClaims: 25,
      maxClaimsPerSolver: 1,
    });
    expect(contract?.credentialRequirements.creator[0]?.id).toBe('polymarket.public.market-data.read');
    expect(contract?.credentialRequirements.solver).toEqual([]);
    expect(contract?.credentialRequirements.evaluator[0]?.id).toBe('polymarket.public.resolution.read');
    expect(contract?.evaluationFunction.id).toBe('prediction.brier-loss.v1');
    expect(contract?.aggregationFunction).toMatchObject({
      id: 'prediction.trailing-mean-brier-spread.v1',
      windowDays: 84,
    });
    expect(contract?.referencePlugins).toEqual(['bundled:jinn-prediction-plugin']);
    contract?.schemas.task.parse(makePredictionV1Task());
  });

  it('loads enabled SolverNets from the contract registry and runtime packs', async () => {
    const registry = await loadSolverNets({
      solverNets: {
        prediction: {
          enabled: true,
          solverType: 'prediction.v1',
          harness: 'prediction-v1-baseline',
          plugins: ['bundled:jinn-prediction-plugin'],
          taskGenerator: { enabled: true },
        },
      },
    });
    const net = registry.forSolverType('prediction.v1');
    expect(net?.contract.evaluationFunction.id).toBe('prediction.brier-loss.v1');
    expect(net?.plugins[0]?.supports).toEqual(['prediction.v1']);
  });

  it('rejects enabled SolverNets without a registered contract', async () => {
    await expect(
      loadSolverNets({
        solverNets: {
          unknown: {
            enabled: true,
            solverType: 'unknown.v0',
            harness: 'prediction-v1-baseline',
            plugins: [],
            taskGenerator: { enabled: true },
          },
        },
      }),
    ).rejects.toThrow(/no registered SolverNetContract/);
  });
});
