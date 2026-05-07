import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  JINN_NETWORK_TOOLS_PLUGIN,
  loadSolverNets,
  taskRoleForOperatorRole,
} from '../../src/solver-nets/registry.js';
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
    expect(contract?.id).toBe('prediction');
    expect(contract?.version).toBe('v1');
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
    // Task 6 of `spec/2026-05-05-solvernet-creation-and-launch.md` removed
    // `defaultRuntimePlugins` from the contract — runtime plugins are
    // operator-configured via `solverNets.<name>.plugins`, not contract-bound.
    expect(contract).not.toHaveProperty('defaultRuntimePlugins');
    // Task 30: the legacy `solverType` field on SolverNetContract is gone.
    expect(contract).not.toHaveProperty('solverType');
    contract?.schemas.task.zod.parse(makePredictionV1Task());
  });

  it('loads enabled SolverNets with operator-configured runtime plugins', async () => {
    // Per `spec/2026-05-05-solvernet-creation-and-launch.md` §8/§9:
    // Runtime plugins are operator-configured. The bundled
    // `jinn-prediction-plugin` is no longer auto-loaded by the contract; it is
    // a quick-start default the launcher seeds into the local
    // `solverNets.prediction.plugins` config (provenance: 'configured').
    // Network Tools remains auto-loaded as a runtime-scoped default
    // (`provenance: 'default'`, `supports: ['jinn.runtime']`).
    const registry = await loadSolverNets({
      solverNets: {
        prediction: {
          enabled: true,
          solverType: 'prediction.v1',
          roles: ['evaluating'],
          harness: 'prediction-v1-baseline',
          model: 'claude-opus-test',
          plugins: ['bundled:jinn-prediction-plugin'],
          taskGenerator: { enabled: true },
        },
      },
    });
    const net = registry.forSolverType('prediction.v1', 'evaluation');
    // Evaluator-only nets must NOT be returned for restoration tasks —
    // the daemon's task acceptance gate relies on this filter.
    expect(registry.forSolverType('prediction.v1', 'restoration')).toBeUndefined();
    expect(net).toMatchObject({
      roles: ['evaluating'],
      model: 'claude-opus-test',
    });
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
      provenance: 'configured',
      supports: ['prediction.v1'],
    });
  });

  it('returns the SolverNet for both restoration and evaluation when both roles are active', async () => {
    const registry = await loadSolverNets({
      solverNets: {
        prediction: {
          enabled: true,
          solverType: 'prediction.v1',
          roles: ['solving', 'evaluating'],
          harness: 'prediction-v1-baseline',
          plugins: ['bundled:jinn-prediction-plugin'],
          taskGenerator: { enabled: true },
        },
      },
    });
    const restoreNet = registry.forSolverType('prediction.v1', 'restoration');
    const evalNet = registry.forSolverType('prediction.v1', 'evaluation');
    expect(restoreNet?.name).toBe('prediction');
    expect(evalNet?.name).toBe('prediction');
    expect(restoreNet?.roles).toEqual(['solving', 'evaluating']);
    expect(evalNet?.roles).toEqual(['solving', 'evaluating']);
  });

  it('returns the SolverNet only for restoration when only solving is active', async () => {
    const registry = await loadSolverNets({
      solverNets: {
        prediction: {
          enabled: true,
          solverType: 'prediction.v1',
          roles: ['solving'],
          harness: 'prediction-v1-baseline',
          plugins: ['bundled:jinn-prediction-plugin'],
          taskGenerator: { enabled: true },
        },
      },
    });
    expect(registry.forSolverType('prediction.v1', 'restoration')?.name).toBe('prediction');
    expect(registry.forSolverType('prediction.v1', 'evaluation')).toBeUndefined();
  });

  it('falls back to roles=[solving] when neither roles nor role is set', async () => {
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
    const net = registry.forSolverType('prediction.v1', 'restoration');
    expect(net?.roles).toEqual(['solving']);
    expect(registry.forSolverType('prediction.v1', 'evaluation')).toBeUndefined();
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
    // Network Tools is auto-loaded as a runtime default. When the operator
    // also lists it in `plugins`, dedupe (by source/name) keeps a single
    // entry and the prediction plugin is absent because the operator did
    // not configure it (Task 6 removed contract-bound default plugins).
    expect(net?.runtimePlugins.map((plugin) => plugin.name)).toEqual([
      '@jinn-network/network-tools',
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
    // Network Tools (default, runtime-scoped) is followed by the operator's
    // configured plugin. The bundled prediction plugin is no longer
    // contract-default — operators wire it up themselves through `plugins`.
    expect(net?.runtimePlugins.map((plugin) => plugin.name)).toEqual([
      '@jinn-network/network-tools',
      '@example/runtime-plugin',
    ]);
    expect(net?.runtimePlugins[1]).toMatchObject({
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

  it("taskRoleForOperatorRole maps solving/evaluating to their task roles", () => {
    expect(taskRoleForOperatorRole('solving')).toBe('restoration');
    expect(taskRoleForOperatorRole('evaluating')).toBe('evaluation');
  });
});
