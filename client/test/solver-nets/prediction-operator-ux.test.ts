import { describe, expect, it } from 'vitest';
import { buildPredictionOperatorStatus } from '../../src/solver-nets/prediction-operator-ux.js';
import type { JinnConfig } from '../../src/config.js';
import { wiringFromJoined } from '../../src/config/migrate-shape-v2.js';
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
    executionWiring: undefined,
    engine: {
      workingDirRoot: '/tmp',
      implStateDirRoot: '/tmp',
    },
    harnesses: undefined,
    trustedImplSigners: [],
    ...overrides,
  } as JinnConfig;
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

const sweRebenchWiring = wiringFromJoined(
  { [sweRebenchJoined.manifestCid]: sweRebenchJoined },
  undefined,
);
const predictionWiring = wiringFromJoined(
  { [predictionJoined.manifestCid]: predictionJoined },
  undefined,
);

describe('buildPredictionOperatorStatus — executionWiring awareness (jinn-mono-hjex.2)', () => {
  it('emits prediction_solvernet_missing when executionWiring is empty', async () => {
    const status = await buildPredictionOperatorStatus({
      config: minimalConfig({ executionWiring: undefined }),
      configPath: '/tmp/config.json',
      daemonRunning: true,
      ...minimalDeps,
    });

    const codes = status.diagnostics.map((d) => d.code);
    expect(codes).toContain('prediction_solvernet_missing');
    const missing = status.diagnostics.find((d) => d.code === 'prediction_solvernet_missing');
    expect(missing?.configField).toBe('executionWiring');
  });
});

describe('buildPredictionOperatorStatus — gate on real prediction participation', () => {
  it('returns the benign missing status when the operator wired ONLY a non-prediction workKind', async () => {
    // An operator on SWE-rebench v2 (hermes-agent) must not see prediction
    // diagnostics. Prediction is a deprecated SolverNet.
    const status = await buildPredictionOperatorStatus({
      config: minimalConfig({
        executionWiring: sweRebenchWiring,
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

  it('does not synthesize a prediction net from a non-prediction wiring entry', async () => {
    // The synthesized net would otherwise stamp prediction.v1 on the SWE-rebench
    // harness and run the prediction-harness-compat check against it.
    const status = await buildPredictionOperatorStatus({
      config: minimalConfig({
        executionWiring: sweRebenchWiring,
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
        executionWiring: predictionWiring,
      }),
      configPath: '/tmp/config.json',
      daemonRunning: true,
      ...minimalDeps,
    });

    const codes = status.diagnostics.map((d) => d.code);
    // The prediction-contract wiring IS synthesized — the diagnostic loop
    // runs past the missing-solvernet guard.
    expect(codes).not.toContain('prediction_solvernet_missing');
    // With an empty harness list the synthesized net hits prediction_harness_unknown
    // (the configured 'hermes-agent' harness is not in the stub registry) — the
    // loop ran, which is what we're proving.
    expect(codes).toContain('prediction_harness_unknown');
    expect(status.kind).toBe('prediction.v1.operatorStatus');
  });

  it('picks the prediction workKind when executionWiring mixes prediction and non-prediction rows', async () => {
    const status = await buildPredictionOperatorStatus({
      config: minimalConfig({
        executionWiring: [...sweRebenchWiring, ...predictionWiring],
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

describe('buildPredictionOperatorStatus — wiring-only resolution (issue #421)', () => {
  it('uses the workKind as the operator-status display name', async () => {
    const status = await buildPredictionOperatorStatus({
      config: minimalConfig({
        executionWiring: predictionWiring,
      }),
      configPath: '/tmp/config.json',
      daemonRunning: true,
      ...minimalDeps,
    });
    expect(status.solverNet.name).toBe('prediction.v1');
  });

  it('emits configField strings keyed by executionWiring digest', async () => {
    const status = await buildPredictionOperatorStatus({
      config: minimalConfig({
        executionWiring: predictionWiring,
      }),
      configPath: '/tmp/config.json',
      daemonRunning: true,
      ...minimalDeps,
    });
    const fields = status.diagnostics
      .map((d) => d.configField)
      .filter((f): f is string => typeof f === 'string');
    expect(fields.length).toBeGreaterThan(0);
    for (const field of fields) {
      expect(field).not.toMatch(/^solverNets\./);
      expect(field).not.toMatch(/^joinedSolverNets\./);
    }
  });
});
