import { describe, expect, it } from 'vitest';
import { buildPredictionOperatorStatus } from '../../src/solver-nets/prediction-operator-ux.js';
import type { JinnConfig } from '../../src/config.js';
import type { JoinedSolverNetConfig } from '../../src/solver-nets/registry.js';

// Minimal stub deps: no harnesses needed for the missing-solvernet path.
const minimalDeps = {
  loadSolverNets: async () => ({ get: () => undefined }),
  loadExternalImpl: async () => ({ kind: 'error' as const, reason: 'not configured' }),
  buildHarnesses: () => [] as never[],
};

/** A minimal JinnConfig-shaped stub that satisfies the diagnostic loop. */
function minimalConfig(overrides: Partial<JinnConfig> = {}): JinnConfig {
  return {
    solverNets: {},
    joinedSolverNets: undefined,
    engine: {
      workingDirRoot: '/tmp',
      implStateDirRoot: '/tmp',
    },
    harnesses: undefined,
    trustedImplSigners: [],
    ...overrides,
  } as unknown as JinnConfig;
}

/** A non-prediction joined SolverNet entry (SWE-rebench v2). */
const sweRebenchJoined: JoinedSolverNetConfig = {
  manifestCid: 'bafkreichdzxtjav3rh5boyybgx6wolh7boqedxix4vvw44slfppwppshpi',
  name: 'SWE-rebench v2',
  contract: { id: 'swe-rebench-v2', version: 'v1' },
  roles: ['solver', 'evaluator'],
  harness: 'hermes-agent',
  plugins: [],
};

/** A genuine prediction-contract joined SolverNet entry. */
const predictionJoined: JoinedSolverNetConfig = {
  manifestCid: 'bafkreigenuineprediction0000000000000000000000000000000000',
  name: 'Prediction v1',
  contract: { id: 'prediction', version: 'v1' },
  roles: ['solver'],
  harness: 'hermes-agent',
  plugins: [],
};

describe('buildPredictionOperatorStatus — joinedSolverNets awareness (jinn-mono-hjex.2)', () => {
  it('emits prediction_solvernet_missing when both solverNets and joinedSolverNets are empty', async () => {
    const status = await buildPredictionOperatorStatus({
      config: minimalConfig({ solverNets: {}, joinedSolverNets: undefined }),
      configPath: '/tmp/config.json',
      daemonRunning: true,
      ...minimalDeps,
    });

    const codes = status.diagnostics.map((d) => d.code);
    expect(codes).toContain('prediction_solvernet_missing');
  });
});

describe('buildPredictionOperatorStatus — gate on real prediction participation', () => {
  it('returns the benign missing status when the operator joined ONLY a non-prediction SolverNet', async () => {
    // An operator on SWE-rebench v2 (hermes-agent) must not see prediction
    // diagnostics. Prediction is a deprecated SolverNet.
    const status = await buildPredictionOperatorStatus({
      config: minimalConfig({
        solverNets: {},
        joinedSolverNets: {
          [sweRebenchJoined.manifestCid]: sweRebenchJoined,
        },
      }),
      configPath: '/tmp/config.json',
      daemonRunning: true,
      ...minimalDeps,
    });

    const codes = status.diagnostics.map((d) => d.code);
    // No spurious harness-compat ATTENTION from mislabeling the SWE-rebench harness.
    expect(codes).not.toContain('prediction_harness_unsupported');
    // Only the benign missing diagnostic — deriveLiveNow filters this from the dashboard.
    expect(codes).toEqual(['prediction_solvernet_missing']);
    expect(status.ok).toBe(false);
  });

  it('does not synthesize a prediction net from a non-prediction joined entry', async () => {
    // The synthesized net would otherwise stamp prediction.v1 on the SWE-rebench
    // harness and run the prediction-harness-compat check against it.
    const status = await buildPredictionOperatorStatus({
      config: minimalConfig({
        solverNets: {},
        joinedSolverNets: {
          [sweRebenchJoined.manifestCid]: sweRebenchJoined,
        },
      }),
      configPath: '/tmp/config.json',
      daemonRunning: true,
      ...minimalDeps,
    });

    // The SWE-rebench harness must not leak into the prediction status.
    expect(status.harness).toBeUndefined();
    expect(status.solverNet.harness).toBeUndefined();
    expect(status.solverNet.enabled).toBe(false);
  });

  it('still produces real diagnostics for an operator genuinely on a prediction SolverNet', async () => {
    const status = await buildPredictionOperatorStatus({
      config: minimalConfig({
        solverNets: {},
        joinedSolverNets: {
          [predictionJoined.manifestCid]: predictionJoined,
        },
      }),
      configPath: '/tmp/config.json',
      daemonRunning: true,
      ...minimalDeps,
    });

    const codes = status.diagnostics.map((d) => d.code);
    // The prediction-contract joined net IS synthesized — the diagnostic loop
    // runs past the missing-solvernet guard.
    expect(codes).not.toContain('prediction_solvernet_missing');
    // With an empty harness list the synthesized net hits prediction_harness_unknown
    // (the configured 'hermes-agent' harness is not in the stub registry) — the
    // loop ran, which is what we're proving.
    expect(codes).toContain('prediction_harness_unknown');
    expect(status.kind).toBe('prediction.v1.operatorStatus');
  });

  it('picks the prediction-contract entry when joinedSolverNets mixes prediction and non-prediction nets', async () => {
    const status = await buildPredictionOperatorStatus({
      config: minimalConfig({
        solverNets: {},
        joinedSolverNets: {
          // Non-prediction entry first — must NOT be the one synthesized.
          [sweRebenchJoined.manifestCid]: sweRebenchJoined,
          [predictionJoined.manifestCid]: predictionJoined,
        },
      }),
      configPath: '/tmp/config.json',
      daemonRunning: true,
      ...minimalDeps,
    });

    const codes = status.diagnostics.map((d) => d.code);
    expect(codes).not.toContain('prediction_solvernet_missing');
    expect(status.kind).toBe('prediction.v1.operatorStatus');
  });
});
