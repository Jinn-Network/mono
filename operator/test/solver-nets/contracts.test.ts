import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { wiringFromJoined } from '../../src/config/migrate-shape-v2.js';
import {
  JINN_NETWORK_TOOLS_PLUGIN,
  loadSolverNets,
  taskRoleForOperatorRole,
  type JoinedSolverNetConfig,
} from '../../src/solver-nets/registry.js';
import { SOLVER_NET_CONTRACTS } from '../../src/solver-nets/contracts.js';
import { makePredictionV1Task } from '../harnesses/impls/prediction-v1-test-helpers.js';

function loadFromJoined(joined: Record<string, JoinedSolverNetConfig>) {
  return loadSolverNets({
    executionWiring: wiringFromJoined(joined, 'claude-haiku-4-5-20251001'),
  });
}

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

  it('does not migrate evaluator-only joined entries onto executionWiring', async () => {
    // Per `spec/2026-05-05-solvernet-creation-and-launch.md` §8/§9:
    // Runtime plugins are operator-configured. The bundled
    // `jinn-prediction-plugin` is no longer auto-loaded by the contract; it is
    // a quick-start default the launcher seeds into the local
    // joined config's `plugins` array (provenance: 'configured').
    // Network Tools remains auto-loaded as a runtime-scoped default
    // (`provenance: 'default'`, `supports: ['jinn.runtime']`).
    // `wiringFromJoined` drops evaluator-only entries (`roles` must include
    // `'solver'`), so this joined block never reaches the registry.
    const registry = await loadFromJoined({
      'legacy:prediction': {
        manifestCid: 'legacy:prediction',
        name: 'prediction',
        contract: { id: 'prediction', version: 'v1' },
        roles: ['evaluator'],
        harness: 'prediction-v1-baseline',
        model: 'claude-opus-test',
        plugins: ['bundled:jinn-prediction-plugin'],
      },
    });
    expect(registry.list()).toEqual([]);
    expect(registry.forSolverType('prediction.v1', 'restoration')).toBeUndefined();
    expect(registry.forSolverType('prediction.v1', 'evaluation')).toBeUndefined();
  });

  it('keeps only solving when a joined entry has both solver and evaluator roles', async () => {
    const registry = await loadFromJoined({
      'legacy:prediction': {
        manifestCid: 'legacy:prediction',
        name: 'prediction',
        contract: { id: 'prediction', version: 'v1' },
        roles: ['solver', 'evaluator'],
        harness: 'prediction-v1-baseline',
        plugins: ['bundled:jinn-prediction-plugin'],
      },
    });
    const restoreNet = registry.forSolverType('prediction.v1', 'restoration');
    const evalNet = registry.forSolverType('prediction.v1', 'evaluation');
    expect(restoreNet?.name).toBe('prediction.v1');
    expect(evalNet).toBeUndefined();
    expect(restoreNet?.roles).toEqual(['solving']);
  });

  it('loads manifest-joined SolverNets into the runtime registry', async () => {
    const registry = await loadFromJoined({
      bafyfixture: {
        manifestCid: 'bafyfixture',
        name: 'SWE-rebench v2',
        contract: { id: 'swe-rebench-v2', version: 'v1' },
        roles: ['solver', 'evaluator'],
        harness: 'claude-code-learner',
        model: 'claude-haiku-4-5-20251001',
        plugins: [],
        disabledDefaultPlugins: [],
      },
    });

    const restoreNet = registry.forSolverType('swe-rebench-v2.v1', 'restoration');
    const evalNet = registry.forSolverType('swe-rebench-v2.v1', 'evaluation');

    expect(restoreNet?.name).toBe('swe-rebench-v2.v1');
    expect(restoreNet?.harness).toBe('claude-code');
    expect(restoreNet?.model).toBe('claude-haiku-4-5-20251001');
    expect(restoreNet?.roles).toEqual(['solving']);
    expect(evalNet).toBeUndefined();
    expect(restoreNet?.runtimePlugins.map((plugin) => plugin.name)).toEqual([
      '@jinn-network/network-tools',
      'swe-rebench-v2-runtime',
    ]);
  });

  it('app-joined SolverNets resolve via the joined registry only', async () => {
    // Pre-issue-#421 this test asserted that a joined entry "won" over a
    // legacy short-name-keyed `solverNets` entry of the same display name.
    // With the legacy block retired, only the joined entry remains; the
    // assertion is that the joined block alone resolves the SolverNet.
    const registry = await loadFromJoined({
      bafyfixture: {
        manifestCid: 'bafyfixture',
        name: 'SWE-rebench v2',
        contract: { id: 'swe-rebench-v2', version: 'v1' },
        roles: ['solver'],
        harness: 'claude-code-learner',
        model: 'claude-haiku-4-5-20251001',
      },
    });

    const net = registry.forSolverType('swe-rebench-v2.v1', 'restoration');
    expect(net?.harness).toBe('claude-code');
    expect(net?.model).toBe('claude-haiku-4-5-20251001');
    expect(registry.harnessSelections()['swe-rebench-v2.v1']).toBe('claude-code');
    expect(registry.claudeModelSelections()['swe-rebench-v2.v1']).toBe(
      'claude-haiku-4-5-20251001',
    );
    expect(registry.list().filter((entry) => entry.name === 'swe-rebench-v2.v1')).toHaveLength(1);
  });

  it('does not migrate evaluator-only SWE-rebench joined entries onto executionWiring', async () => {
    const registry = await loadFromJoined({
      bafyfixture: {
        manifestCid: 'bafyfixture',
        name: 'SWE-rebench v2',
        contract: { id: 'swe-rebench-v2', version: 'v1' },
        roles: ['evaluator'],
      },
    });

    expect(registry.list()).toEqual([]);
    expect(registry.forSolverType('swe-rebench-v2.v1', 'restoration')).toBeUndefined();
    expect(registry.forSolverType('swe-rebench-v2.v1', 'evaluation')).toBeUndefined();
  });

  it('lets joined operators opt out of default SolverNet runtime plugins', async () => {
    // `disabledDefaultPlugins` is not on ExecutionWiringConfigEntry.
    // Empty `plugins` still auto-loads `swe-rebench-v2-runtime` via
    // `defaultRuntimePluginsForSolverType`.
    const registry = await loadFromJoined({
      bafyfixture: {
        manifestCid: 'bafyfixture',
        contract: { id: 'swe-rebench-v2', version: 'v1' },
        roles: ['solver'],
        plugins: [],
      },
    });

    expect(
      registry
        .forSolverType('swe-rebench-v2.v1', 'restoration')
        ?.runtimePlugins.map((plugin) => plugin.name),
    ).toEqual([
      '@jinn-network/network-tools',
      'swe-rebench-v2-runtime',
    ]);
  });

  it('returns the SolverNet only for restoration when only solving is active', async () => {
    const registry = await loadFromJoined({
      'legacy:prediction': {
        manifestCid: 'legacy:prediction',
        name: 'prediction',
        contract: { id: 'prediction', version: 'v1' },
        roles: ['solver'],
        harness: 'prediction-v1-baseline',
        plugins: ['bundled:jinn-prediction-plugin'],
      },
    });
    expect(registry.forSolverType('prediction.v1', 'restoration')?.name).toBe('prediction.v1');
    expect(registry.forSolverType('prediction.v1', 'evaluation')).toBeUndefined();
  });

  it('defaults a joined SolverNet to solver-only when only solver is configured', async () => {
    const registry = await loadFromJoined({
      'legacy:prediction': {
        manifestCid: 'legacy:prediction',
        name: 'prediction',
        contract: { id: 'prediction', version: 'v1' },
        roles: ['solver'],
        harness: 'prediction-v1-baseline',
        plugins: ['bundled:jinn-prediction-plugin'],
      },
    });
    const net = registry.forSolverType('prediction.v1', 'restoration');
    expect(net?.roles).toEqual(['solving']);
    expect(registry.forSolverType('prediction.v1', 'evaluation')).toBeUndefined();
  });

  it('does not duplicate Network Tools if it is configured explicitly', async () => {
    const registry = await loadFromJoined({
      'legacy:prediction': {
        manifestCid: 'legacy:prediction',
        name: 'prediction',
        contract: { id: 'prediction', version: 'v1' },
        roles: ['solver'],
        harness: 'prediction-v1-baseline',
        plugins: [JINN_NETWORK_TOOLS_PLUGIN],
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

  it('skips joined SolverNets whose contract is not registered', async () => {
    const registry = await loadFromJoined({
      'legacy:unknown': {
        manifestCid: 'legacy:unknown',
        name: 'unknown',
        contract: { id: 'unknown', version: 'v0' },
        roles: ['solver'],
        harness: 'prediction-v1-baseline',
        plugins: [],
      },
    });
    // Unknown contracts are silently skipped (`contractRefFromWorkKind`
    // fails for `unknown.v0`); the registry simply has no entry.
    expect(registry.list()).toEqual([]);
    expect(registry.forSolverType('unknown.v0')).toBeUndefined();
  });

  it('loads operator configured runtime plugins after defaults', async () => {
    const localPlugin = makeLocalPlugin(['prediction.v1']);
    const registry = await loadFromJoined({
      'legacy:prediction': {
        manifestCid: 'legacy:prediction',
        name: 'prediction',
        contract: { id: 'prediction', version: 'v1' },
        roles: ['solver'],
        harness: 'prediction-v1-baseline',
        plugins: [localPlugin],
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
      loadFromJoined({
        'legacy:prediction': {
          manifestCid: 'legacy:prediction',
          name: 'prediction',
          contract: { id: 'prediction', version: 'v1' },
          roles: ['solver'],
          harness: 'prediction-v1-baseline',
          plugins: ['npm:@jinn-network/definitely-missing-prediction-runtime-plugin'],
        },
      }),
    ).rejects.toThrow(
      /SolverPlugin source npm:@jinn-network\/definitely-missing-prediction-runtime-plugin is not vendored/,
    );
  });

  it('rejects runtime plugins whose supports list does not include the SolverNet solverType', async () => {
    await expect(
      loadFromJoined({
        'legacy:prediction': {
          manifestCid: 'legacy:prediction',
          name: 'prediction',
          contract: { id: 'prediction', version: 'v1' },
          roles: ['solver'],
          harness: 'prediction-v1-baseline',
          plugins: [makeLocalPlugin(['portfolio.v0'])],
        },
      }),
    ).rejects.toThrow(/runtime plugin .* solverType mismatch/);
  });

  it("taskRoleForOperatorRole maps solving/evaluating to their task roles", () => {
    expect(taskRoleForOperatorRole('solving')).toBe('restoration');
    expect(taskRoleForOperatorRole('evaluating')).toBe('evaluation');
  });
});
