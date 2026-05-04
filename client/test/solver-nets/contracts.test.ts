import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { JINN_NETWORK_TOOLS_PLUGIN, loadSolverNets } from '../../src/solver-nets/registry.js';
import { SOLVER_NET_CONTRACTS } from '../../src/solver-nets/contracts.js';
import { makePredictionV1Task } from '../harnesses/impls/prediction-v1-test-helpers.js';

function makeLocalPlugin(supports: string[]): string {
  const root = mkdtempSync(join(tmpdir(), 'jinn-runtime-plugin-'));
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'jinn.plugin.json'), JSON.stringify({
    name: '@example/runtime-plugin',
    version: '0.1.0',
    jinn: { supports },
  }, null, 2));
  return `path:${root}`;
}

describe('SolverNet contracts', () => {
  it('registers prediction.v1 contract authority', () => {
    const contract = SOLVER_NET_CONTRACTS['prediction.v1'];
    expect(contract?.solverType).toBe('prediction.v1');
    expect(contract?.claimPolicyDefaults).toMatchObject({
      mode: 'parallel',
      maxClaims: 25,
      maxClaimsPerOperator: 1,
    });
    expect(contract?.credentialRequirements.creator[0]?.id).toBe('polymarket.public.market-data.read');
    expect(contract?.credentialRequirements.solver).toEqual([]);
    expect(contract?.credentialRequirements.evaluator[0]?.id).toBe('polymarket.public.resolution.read');
    expect(contract?.evaluationFunction.id).toBe('prediction.brier-loss.v1');
    expect(contract?.aggregationFunction).toMatchObject({
      id: 'prediction.trailing-mean-brier-spread.v1',
      windowDays: 84,
    });
    expect(contract?.defaultRuntimePlugins).toEqual(['bundled:jinn-prediction-plugin']);
    contract?.schemas.task.parse(makePredictionV1Task());
  });

  it('loads enabled SolverNets with default runtime plugins', async () => {
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
    expect(net?.runtimePlugins.map((plugin) => plugin.name)).toEqual([
      '@jinn-network/network-tools',
      '@jinn-network/prediction-plugin',
    ]);
    expect(net?.runtimePlugins[0]).toMatchObject({
      provenance: 'default',
      supports: ['jinn.runtime'],
    });
    expect(net?.runtimePlugins[0]?.root).toContain('network-tools');
    expect(net?.runtimePlugins[1]).toMatchObject({
      provenance: 'default',
      supports: ['prediction.v1'],
    });
  });

  it('does not duplicate Network Tools if it is configured explicitly', async () => {
    const registry = await loadSolverNets({
      solverNets: {
        prediction: {
          enabled: true,
          solverType: 'prediction.v1',
          harness: 'prediction-v1-baseline',
          plugins: [JINN_NETWORK_TOOLS_PLUGIN],
          taskGenerator: { enabled: true },
        },
      },
    });
    const net = registry.forSolverType('prediction.v1');
    expect(net?.runtimePlugins.map((plugin) => plugin.name)).toEqual([
      '@jinn-network/network-tools',
      '@jinn-network/prediction-plugin',
    ]);
  });

  it('skips legacy-disabled SolverNets before resolving contracts', async () => {
    const registry = await loadSolverNets({
      solverNets: {
        disabled: {
          enabled: false,
          solverType: 'unknown.v0',
          harness: 'prediction-v1-baseline',
          plugins: [],
          taskGenerator: { enabled: true },
        },
      },
    });

    expect(registry.list()).toEqual([]);
    expect(registry.forSolverType('unknown.v0')).toBeUndefined();
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

  it('loads operator configured runtime plugins after defaults', async () => {
    const localPlugin = makeLocalPlugin(['prediction.v1']);
    const registry = await loadSolverNets({
      solverNets: {
        prediction: {
          enabled: true,
          solverType: 'prediction.v1',
          harness: 'prediction-v1-baseline',
          plugins: [localPlugin],
          taskGenerator: { enabled: true },
        },
      },
    });
    const net = registry.forSolverType('prediction.v1');
    expect(net?.runtimePlugins.map((plugin) => plugin.name)).toEqual([
      '@jinn-network/network-tools',
      '@jinn-network/prediction-plugin',
      '@example/runtime-plugin',
    ]);
    expect(net?.runtimePlugins[2]).toMatchObject({
      provenance: 'configured',
      supports: ['prediction.v1'],
    });
  });

  it('reports a clear error when an operator configured runtime plugin is not available', async () => {
    await expect(
      loadSolverNets({
        solverNets: {
          prediction: {
            enabled: true,
            solverType: 'prediction.v1',
            harness: 'prediction-v1-baseline',
            plugins: ['npm:@jinn-network/definitely-missing-prediction-runtime-plugin'],
            taskGenerator: { enabled: true },
          },
        },
      }),
    ).rejects.toThrow(
      /SolverPlugin source npm:@jinn-network\/definitely-missing-prediction-runtime-plugin is not vendored/,
    );
  });

  it('rejects runtime plugins whose supports list does not include the SolverNet solverType', async () => {
    await expect(
      loadSolverNets({
        solverNets: {
          prediction: {
            enabled: true,
            solverType: 'prediction.v1',
            harness: 'prediction-v1-baseline',
            plugins: [makeLocalPlugin(['portfolio.v0'])],
            taskGenerator: { enabled: true },
          },
        },
      }),
    ).rejects.toThrow(/runtime plugin .* solverType mismatch/);
  });
});
