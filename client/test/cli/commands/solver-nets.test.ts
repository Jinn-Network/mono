import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import solverNetsCommand from '@/cli/commands/solver-nets.js';
import { loadConfig, type JinnConfig } from '@/config.js';
import type { Harness, RuntimePlugin } from '@/harnesses/types.js';
import {
  buildPredictionOperatorStatus,
  runPredictionSample,
  type PredictionOperatorDiagnostic,
} from '@/solver-nets/prediction-operator-ux.js';
import { makeCommandCtx } from '@test/cli.js';

function tempConfig(values: Record<string, unknown> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'jinn-solver-nets-test-'));
  const path = join(dir, 'config.json');
  writeFileSync(path, JSON.stringify(values, null, 2), 'utf-8');
  return path;
}

function predictionConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    solverNets: {
      prediction: {
        enabled: true,
        solverType: 'prediction.v1',
        canonicalPlugin: 'bundled:jinn-prediction-plugin',
        harness: 'claude-code-learner',
        plugins: [],
        taskGenerator: { enabled: true },
        ...overrides,
      },
    },
  };
}

async function runSolverNets(argv: string[]): Promise<{ envelope: Record<string, any>; exits: number[] }> {
  const made = makeCommandCtx({ argv });
  await solverNetsCommand.run(made.ctx);
  return {
    envelope: JSON.parse(made.writes.join('')) as Record<string, any>,
    exits: made.exits,
  };
}

const predictionPlugin: RuntimePlugin = {
  role: 'canonical',
  name: '@jinn-network/prediction-plugin',
  version: '0.2.0',
  supports: ['prediction.v1'],
  root: '/test/prediction-plugin',
  manifestPath: '/test/prediction-plugin/plugin.json',
  sha256: '0'.repeat(64),
};

function stubHarness(
  overrides: Partial<Harness> & Pick<Harness, 'name'>,
): Harness {
  return {
    name: overrides.name,
    version: overrides.version ?? '1.0.0',
    supports: overrides.supports ?? (() => true),
    isReady: overrides.isReady,
    async run() {
      throw new Error('stub Harness should not run in operator status tests');
    },
  };
}

function loadPredictionTestConfig(
  overrides: Record<string, unknown> = {},
  mutate?: (config: JinnConfig) => void,
): { config: JinnConfig; configPath: string } {
  const configPath = tempConfig(predictionConfig(overrides));
  const config = loadConfig(configPath);
  mutate?.(config);
  return { config, configPath };
}

const operatorStatusDeps = {
  loadSolverNets: async () => ({
    get: (name: string) => name === 'prediction'
      ? {
          name: 'prediction',
          enabled: true,
          solverType: 'prediction.v1',
          canonicalPlugin: predictionPlugin,
          plugins: [],
          taskGenerator: { enabled: true },
        }
      : undefined,
  }),
  loadExternalImpl: async () => ({ kind: 'error', reason: 'not configured' }),
  buildHarnesses: () => [
    stubHarness({ name: 'claude-code-learner' }),
    stubHarness({ name: 'prediction-v1-baseline' }),
  ],
} satisfies Partial<Parameters<typeof buildPredictionOperatorStatus>[0]>;

function expectDiagnosticContract(
  diagnostic: PredictionOperatorDiagnostic,
  expected: { code: string; severity: PredictionOperatorDiagnostic['severity']; configField?: string },
): void {
  expect(diagnostic).toEqual(expect.objectContaining({
    code: expected.code,
    severity: expected.severity,
    message: expect.any(String),
    nextAction: expect.objectContaining({
      description: expect.any(String),
    }),
  }));
  expect(diagnostic.message.length).toBeGreaterThan(0);
  expect(diagnostic.nextAction?.description.length).toBeGreaterThan(0);
  if (expected.configField) {
    expect(diagnostic.configField).toBe(expected.configField);
  } else {
    expect(diagnostic).not.toHaveProperty('configField');
  }
}

describe('solver-nets command', () => {
  it('diagnoses Prediction SolverNet status with plugin and Harness details', async () => {
    const configPath = tempConfig(predictionConfig());
    const result = await runSolverNets(['doctor', 'prediction', '--config', configPath]);

    expect(result.exits).toEqual([]);
    const envelope = result.envelope;
    expect(envelope['verb']).toBe('solver-nets doctor');
    expect(envelope['kind']).toBe('prediction.v1.operatorStatus');
    expect(envelope['ok']).toBe(true);
    expect(envelope['solverNet']).toMatchObject({
      name: 'prediction',
      enabled: true,
      solverType: 'prediction.v1',
      harness: 'claude-code-learner',
      taskGeneratorEnabled: true,
    });
    expect(envelope['canonicalPlugin']).toMatchObject({
      role: 'canonical',
      source: 'bundled:jinn-prediction-plugin',
      name: '@jinn-network/prediction-plugin',
      version: '0.2.0',
      supports: ['prediction.v1'],
    });
    expect(envelope['harness']).toMatchObject({
      name: 'claude-code-learner',
      supportsPredictionV1Restoration: true,
      readiness: { ready: true },
    });
  });

  it('surfaces Prediction SolverPlugin load failures as operator diagnostics', async () => {
    const configPath = tempConfig(predictionConfig({
      canonicalPlugin: 'npm:@jinn-network/definitely-missing-prediction-canonical-plugin',
    }));
    const result = await runSolverNets(['doctor', 'prediction', '--config', configPath]);

    expect(result.exits).toEqual([]);
    const envelope = result.envelope;
    expect(envelope['ok']).toBe(false);
    expect(envelope['diagnostics']).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'prediction_plugin_unavailable',
          severity: 'error',
          configField: 'solverNets.prediction.canonicalPlugin',
        }),
      ]),
    );
  });

  it('reports selected Prediction Harnesses disabled in operator config', async () => {
    const configPath = tempConfig({
      ...predictionConfig({ harness: 'prediction-v1-baseline' }),
      harnesses: { disabled: ['prediction-v1-baseline'] },
    });
    const result = await runSolverNets(['doctor', 'prediction', '--config', configPath]);

    expect(result.exits).toEqual([]);
    const envelope = result.envelope;
    expect(envelope['ok']).toBe(false);
    expect(envelope['harness']).toBeUndefined();
    expect(envelope['diagnostics']).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'prediction_harness_disabled',
          severity: 'error',
          configField: 'harnesses.disabled',
        }),
      ]),
    );
  });

  it('honors daemon default-disabled Prediction Harnesses when config omits disabled names', async () => {
    const configPath = tempConfig(predictionConfig({ harness: 'claude-mcp-hyperliquid' }));
    const result = await runSolverNets(['doctor', 'prediction', '--config', configPath]);

    expect(result.exits).toEqual([]);
    const envelope = result.envelope;
    expect(envelope['ok']).toBe(false);
    expect(envelope['harness']).toBeUndefined();
    expect(envelope['diagnostics']).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'prediction_harness_disabled',
          severity: 'error',
          configField: 'harnesses.disabled',
        }),
      ]),
    );
  });

  it('surfaces selected external Prediction Harness load failures', async () => {
    const configPath = tempConfig({
      ...predictionConfig({ harness: '@example/prediction-harness' }),
      harnesses: {
        externalImpls: [
          {
            name: '@example/prediction-harness',
            entry: join(tmpdir(), 'jinn-missing-external-prediction-harness'),
          },
        ],
      },
    });
    const result = await runSolverNets(['doctor', 'prediction', '--config', configPath]);

    expect(result.exits).toEqual([]);
    const envelope = result.envelope;
    expect(envelope['ok']).toBe(false);
    expect(envelope['diagnostics']).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'prediction_harness_external_unavailable',
          severity: 'error',
          configField: 'harnesses.externalImpls.@example/prediction-harness',
        }),
      ]),
    );
  });

  it('runs a local no-funds Prediction sample through the baseline Harness', async () => {
    const configPath = tempConfig({});
    const result = await runSolverNets(['sample', 'prediction', '--config', configPath]);

    expect(result.exits).toEqual([]);
    const envelope = result.envelope;
    expect(envelope['verb']).toBe('solver-nets sample');
    expect(envelope['kind']).toBe('prediction.v1.sampleRun');
    expect(envelope['ok']).toBe(true);
    expect(envelope['task']).toMatchObject({
      id: 'prediction-v1-local-sample',
      question: 'Will this local Prediction SolverNet sample complete successfully?',
    });
    expect(envelope['harness']).toMatchObject({
      name: 'prediction-v1-baseline',
      version: '1.0.0',
    });
    expect(envelope['solution']).toMatchObject({
      probabilityYes: '0.6200',
      modelId: 'prediction-v1-baseline/consensus',
    });
    expect(envelope['solution']['artifactPath']).toContain('prediction-v1-solution.json');
  });

  it('reports closed sample windows before running the Harness', async () => {
    const configPath = tempConfig({});
    const result = await runSolverNets(['sample', 'prediction', '--closed-window', '--config', configPath]);

    expect(result.exits).toEqual([]);
    const envelope = result.envelope;
    expect(envelope['ok']).toBe(false);
    expect(envelope['solution']).toBeUndefined();
    expect(envelope['diagnostics']).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'prediction_sample_cannot_attempt',
          severity: 'error',
          message: 'window already closed',
        }),
      ]),
    );
  });

  it.each([
    {
      label: 'disabled SolverNet',
      fatalForSolvingNow: true,
      warningForGeneratorOrDashboardCompleteness: false,
      expectedOk: false,
      expected: {
        code: 'prediction_solvernet_disabled',
        severity: 'error' as const,
        configField: 'solverNets.prediction.enabled',
      },
      config: () => loadPredictionTestConfig({ enabled: false }),
    },
    {
      label: 'invalid canonical plugin',
      fatalForSolvingNow: true,
      warningForGeneratorOrDashboardCompleteness: false,
      expectedOk: false,
      expected: {
        code: 'prediction_plugin_unavailable',
        severity: 'error' as const,
        configField: 'solverNets.prediction.canonicalPlugin',
      },
      deps: {
        loadSolverNets: async () => {
          throw new Error('Cannot resolve SolverPlugin npm:@jinn-network/missing-prediction-plugin');
        },
      },
      config: () => loadPredictionTestConfig({
        canonicalPlugin: 'npm:@jinn-network/missing-prediction-plugin',
      }),
    },
    {
      label: 'missing canonical plugin',
      fatalForSolvingNow: true,
      warningForGeneratorOrDashboardCompleteness: false,
      expectedOk: false,
      expected: {
        code: 'prediction_plugin_unavailable',
        severity: 'error' as const,
        configField: 'solverNets.prediction.canonicalPlugin',
      },
      deps: {
        loadSolverNets: async () => {
          throw new Error('Prediction SolverNet canonicalPlugin is missing');
        },
      },
      config: () => loadPredictionTestConfig({}, (config) => {
        config.solverNets.prediction.canonicalPlugin = undefined as unknown as string;
      }),
    },
    {
      label: 'unsupported canonical plugin solverType mismatch',
      fatalForSolvingNow: true,
      warningForGeneratorOrDashboardCompleteness: false,
      expectedOk: false,
      expected: {
        code: 'prediction_plugin_unavailable',
        severity: 'error' as const,
        configField: 'solverNets.prediction.canonicalPlugin',
      },
      deps: {
        loadSolverNets: async () => {
          throw new Error('SolverNet prediction solverType mismatch: config=prediction.v1 plugin supports=portfolio.v0');
        },
      },
      config: () => loadPredictionTestConfig({
        canonicalPlugin: 'bundled:portfolio-v0-plugin',
      }),
    },
    {
      label: 'SolverNet solverType mismatch',
      fatalForSolvingNow: true,
      warningForGeneratorOrDashboardCompleteness: false,
      expectedOk: false,
      expected: {
        code: 'prediction_solver_type_mismatch',
        severity: 'error' as const,
        configField: 'solverNets.prediction.solverType',
      },
      config: () => loadPredictionTestConfig({ solverType: 'portfolio.v0' }),
    },
    {
      label: 'missing Harness selection',
      fatalForSolvingNow: true,
      warningForGeneratorOrDashboardCompleteness: false,
      expectedOk: false,
      expected: {
        code: 'prediction_harness_missing',
        severity: 'error' as const,
        configField: 'solverNets.prediction.harness',
      },
      config: () => loadPredictionTestConfig({}, (config) => {
        config.solverNets.prediction.harness = undefined as unknown as string;
      }),
    },
    {
      label: 'unknown Harness selection',
      fatalForSolvingNow: true,
      warningForGeneratorOrDashboardCompleteness: false,
      expectedOk: false,
      expected: {
        code: 'prediction_harness_unknown',
        severity: 'error' as const,
        configField: 'solverNets.prediction.harness',
      },
      config: () => loadPredictionTestConfig({ harness: 'not-installed-prediction-harness' }),
    },
    {
      label: 'unsupported Harness selection',
      fatalForSolvingNow: true,
      warningForGeneratorOrDashboardCompleteness: false,
      expectedOk: false,
      expected: {
        code: 'prediction_harness_unsupported',
        severity: 'error' as const,
        configField: 'solverNets.prediction.harness',
      },
      deps: {
        buildHarnesses: () => [
          stubHarness({
            name: 'prediction-v1-evaluator-only',
            supports: () => false,
          }),
        ],
      },
      config: () => loadPredictionTestConfig({ harness: 'prediction-v1-evaluator-only' }),
    },
    {
      label: 'non-ready Harness selection',
      fatalForSolvingNow: false,
      warningForGeneratorOrDashboardCompleteness: true,
      expectedOk: true,
      expected: {
        code: 'prediction_harness_not_ready',
        severity: 'warning' as const,
        configField: 'solverNets.prediction.harness',
      },
      deps: {
        buildHarnesses: () => [
          stubHarness({
            name: 'prediction-v1-needs-daemon',
            isReady: async () => ({
              ready: false,
              reason: 'requires live daemon',
              nextStep: { description: 'Start the daemon.', cli: 'jinn run' },
            }),
          }),
        ],
      },
      config: () => loadPredictionTestConfig({ harness: 'prediction-v1-needs-daemon' }),
    },
    {
      label: 'disabled task generator',
      fatalForSolvingNow: false,
      warningForGeneratorOrDashboardCompleteness: true,
      expectedOk: true,
      expected: {
        code: 'prediction_task_generator_disabled',
        severity: 'warning' as const,
        configField: 'solverNets.prediction.taskGenerator.enabled',
      },
      config: () => loadPredictionTestConfig({ taskGenerator: { enabled: false } }),
    },
  ])(
    'documents Prediction operator diagnostic matrix row: $label',
    async ({ config: load, deps, expected, expectedOk, fatalForSolvingNow, warningForGeneratorOrDashboardCompleteness }) => {
      expect(typeof fatalForSolvingNow).toBe('boolean');
      expect(typeof warningForGeneratorOrDashboardCompleteness).toBe('boolean');

      const { config, configPath } = load();
      const status = await buildPredictionOperatorStatus({
        config,
        configPath,
        ...operatorStatusDeps,
        ...deps,
      });
      const diagnostic = status.diagnostics.find((candidate) => candidate.code === expected.code);

      expect(status.ok).toBe(expectedOk);
      expect(diagnostic).toBeDefined();
      expectDiagnosticContract(diagnostic!, expected);
    },
  );

  it('reports insufficient sample task windows with a complete non-config diagnostic', async () => {
    const sample = await runPredictionSample({ closedWindow: true });
    const diagnostic = sample.diagnostics.find((candidate) => candidate.code === 'prediction_sample_cannot_attempt');

    expect(sample.ok).toBe(false);
    expect(sample.solution).toBeUndefined();
    expectDiagnosticContract(diagnostic!, {
      code: 'prediction_sample_cannot_attempt',
      severity: 'error',
    });
  });
});
