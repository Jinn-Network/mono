import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import solverNetsCommand from '@/cli/commands/solver-nets.js';
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
});
