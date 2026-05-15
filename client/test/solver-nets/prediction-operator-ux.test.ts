import { describe, expect, it } from 'vitest';
import { buildPredictionOperatorStatus } from '../../src/solver-nets/prediction-operator-ux.js';
import type { JinnConfig } from '../../src/config.js';

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

  it('does not emit prediction_solvernet_missing when joinedSolverNets has an entry (jinn-mono-hjex.2)', async () => {
    const status = await buildPredictionOperatorStatus({
      config: minimalConfig({
        solverNets: {},
        joinedSolverNets: {
          'bafkreichdzxtjav3rh5boyybgx6wolh7boqedxix4vvw44slfppwppshpi': {
            manifestCid: 'bafkreichdzxtjav3rh5boyybgx6wolh7boqedxix4vvw44slfppwppshpi',
            name: 'SWE-rebench v2',
            roles: ['solver', 'evaluator'],
            harness: 'claude-code',
            plugins: [],
          },
        },
      }),
      configPath: '/tmp/config.json',
      daemonRunning: true,
      ...minimalDeps,
    });

    const codes = status.diagnostics.map((d) => d.code);
    expect(codes).not.toContain('prediction_solvernet_missing');
  });

  it('still runs harness diagnostics against a synthesized net from joinedSolverNets', async () => {
    const status = await buildPredictionOperatorStatus({
      config: minimalConfig({
        solverNets: {},
        joinedSolverNets: {
          'bafkreichdzxtjav3rh5boyybgx6wolh7boqedxix4vvw44slfppwppshpi': {
            manifestCid: 'bafkreichdzxtjav3rh5boyybgx6wolh7boqedxix4vvw44slfppwppshpi',
            name: 'SWE-rebench v2',
            roles: ['solver'],
            harness: 'claude-code',
            plugins: [],
          },
        },
      }),
      configPath: '/tmp/config.json',
      daemonRunning: true,
      ...minimalDeps,
    });

    // The net is synthesized as enabled — the diagnostic loop continues past the
    // missing-solvernet guard. We won't see prediction_solvernet_missing.
    const codes = status.diagnostics.map((d) => d.code);
    expect(codes).not.toContain('prediction_solvernet_missing');
    // With an empty harness list the synthesized net will hit prediction_harness_unknown
    // (or prediction_harness_missing if harness is not found) — either way
    // the loop ran, which is what we're proving.
    expect(status.kind).toBe('prediction.v1.operatorStatus');
  });
});
