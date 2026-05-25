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
        harness: 'prediction-v1-baseline',
        // Mirrors the launcher's quick-start defaults: the bundled
        // prediction plugin is operator-configured per
        // `spec/2026-05-05-solvernet-creation-and-launch.md` §8/§9 (Task 6
        // dropped contract-default runtime plugins).
        plugins: ['bundled:jinn-prediction-plugin'],
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
  provenance: 'default',
  source: 'bundled:jinn-prediction-plugin',
  sourceKind: 'bundled',
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

// Issue #421: on-disk legacy `solverNets.prediction.X` blocks are migrated to
// `joinedSolverNets['legacy:prediction']` synthetic entries; the
// `prediction-operator-ux` configField strings carry that synthetic key.
const LEGACY_PREDICTION_CID = 'legacy:prediction';

const operatorStatusDeps = {
  loadSolverNets: async () => ({
    get: (name: string) => name === 'prediction'
      ? {
          name: 'prediction',
          enabled: true,
          solverType: 'prediction.v1',
          runtimePlugins: [predictionPlugin],
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
      harness: 'prediction-v1-baseline',
      // Issue #421: operator config no longer carries the task-generator
      // flag — generator ownership is launched-record-driven.
      taskGeneratorEnabled: false,
    });
    expect(envelope['runtimePlugins']).toEqual(expect.arrayContaining([
      expect.objectContaining({
        // Operator-configured (no longer a contract default — see Task 6 of
        // `spec/2026-05-05-solvernet-creation-and-launch.md`).
        provenance: 'configured',
        source: 'bundled:jinn-prediction-plugin',
        name: '@jinn-network/prediction-plugin',
        version: '0.2.0',
        supports: ['prediction.v1'],
      }),
    ]));
    expect(envelope['harness']).toMatchObject({
      name: 'prediction-v1-baseline',
      supportsPredictionV1Restoration: true,
      readiness: { ready: false, reason: 'requires live daemon' },
    });
  });

  it('surfaces Prediction runtime plugin load failures as operator diagnostics', async () => {
    const configPath = tempConfig(predictionConfig({
      plugins: ['npm:@jinn-network/definitely-missing-prediction-runtime-plugin'],
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
          configField: `joinedSolverNets.${LEGACY_PREDICTION_CID}.plugins`,
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
    // Issue #421 F4: sample resolves the SolverNet via joinedSolverNets
    // (legacy:prediction after migration); an empty config now errors with
    // Unknown SolverNet rather than silently synthesizing a default.
    const configPath = tempConfig(predictionConfig());
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
    const configPath = tempConfig(predictionConfig());
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
      label: 'invalid runtime plugin',
      fatalForSolvingNow: true,
      warningForGeneratorOrDashboardCompleteness: false,
      expectedOk: false,
      expected: {
        code: 'prediction_plugin_unavailable',
        severity: 'error' as const,
        configField: `joinedSolverNets.${LEGACY_PREDICTION_CID}.plugins`,
      },
      deps: {
        loadSolverNets: async () => {
          throw new Error('Cannot resolve SolverPlugin npm:@jinn-network/missing-prediction-plugin');
        },
      },
      config: () => loadPredictionTestConfig({
        plugins: ['npm:@jinn-network/missing-prediction-plugin'],
      }),
    },
    {
      label: 'unsupported runtime plugin solverType mismatch',
      fatalForSolvingNow: true,
      warningForGeneratorOrDashboardCompleteness: false,
      expectedOk: false,
      expected: {
        code: 'prediction_plugin_unavailable',
        severity: 'error' as const,
        configField: `joinedSolverNets.${LEGACY_PREDICTION_CID}.plugins`,
      },
      deps: {
        loadSolverNets: async () => {
          throw new Error('SolverNet prediction runtime plugin example solverType mismatch: config=prediction.v1 plugin supports=portfolio.v0');
        },
      },
      config: () => loadPredictionTestConfig({
        plugins: ['bundled:portfolio-v0-plugin'],
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
        configField: `joinedSolverNets.${LEGACY_PREDICTION_CID}.contract`,
      },
      // The legacy `solverType: 'portfolio.v0'` migrates to
      // `contract: { id: 'portfolio', version: 'v0' }`. The joined entry
      // is keyed by `legacy:prediction` but its contract is portfolio.v0,
      // which is not prediction. To trigger the mismatch diagnostic the
      // join must still be found (contract.id === 'prediction') — so we
      // hand-mutate the joined entry to point at a non-prediction contract
      // while keeping the prediction-contract entry's display name.
      config: () => loadPredictionTestConfig({}, (config) => {
        const entry = config.joinedSolverNets?.[LEGACY_PREDICTION_CID];
        if (entry?.contract) {
          // Keep contract.id === 'prediction' so findPredictionJoined picks
          // it up, but advance the version so the solverType check fails.
          entry.contract = { id: 'prediction', version: 'v2' };
        }
      }),
    },
    {
      label: 'missing Harness selection',
      fatalForSolvingNow: true,
      warningForGeneratorOrDashboardCompleteness: false,
      expectedOk: false,
      expected: {
        code: 'prediction_harness_missing',
        severity: 'error' as const,
        configField: `joinedSolverNets.${LEGACY_PREDICTION_CID}.harness`,
      },
      config: () => loadPredictionTestConfig({}, (config) => {
        const entry = config.joinedSolverNets?.[LEGACY_PREDICTION_CID];
        if (entry) entry.harness = undefined;
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
        configField: `joinedSolverNets.${LEGACY_PREDICTION_CID}.harness`,
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
        configField: `joinedSolverNets.${LEGACY_PREDICTION_CID}.harness`,
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
        configField: `joinedSolverNets.${LEGACY_PREDICTION_CID}.harness`,
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
      label: 'task generator info (post-#421 informational diagnostic)',
      fatalForSolvingNow: false,
      warningForGeneratorOrDashboardCompleteness: true,
      expectedOk: true,
      expected: {
        // Synthesized joined entries always set taskGenerator.enabled: false;
        // the diagnostic surface emits an informational note (not a warning)
        // explaining that generator ownership lives on the launcher.
        code: 'prediction_task_generator_disabled',
        severity: 'info' as const,
        configField: `joinedSolverNets.${LEGACY_PREDICTION_CID}`,
      },
      config: () => loadPredictionTestConfig({}),
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

  it('reports a generic operator recovery path when no joined prediction SolverNet exists', async () => {
    // Issue #421: the legacy `solverNets` block is retired; the "missing"
    // path now fires when no joinedSolverNets entry has contract.id ===
    // 'prediction'. Empty joinedSolverNets is the canonical "no SolverNet
    // joined" shape.
    const configPath = tempConfig({});
    const config = loadConfig(configPath);

    const status = await buildPredictionOperatorStatus({
      config,
      configPath,
      ...operatorStatusDeps,
      loadSolverNets: async () => ({
        get: () => undefined,
      }),
    });

    const diagnostic = status.diagnostics.find((candidate) => candidate.code === 'prediction_solvernet_missing');
    expect(status.ok).toBe(false);
    expect(diagnostic?.message).toBe('No active SolverNet configured.');
    expect(diagnostic?.configField).toBe('joinedSolverNets');
    expect(diagnostic?.nextAction).toEqual({
      description: 'Open Operator > SolverNets to join or configure a SolverNet.',
      url: '/operator#solvernets',
    });
    expect(status.nextAction).toEqual(diagnostic?.nextAction);
    expect(JSON.stringify(status)).not.toContain("No SolverNet named 'prediction'");
    expect(JSON.stringify(status)).not.toContain('jinn solver-nets enable prediction');
  });

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

  it('does not say "start the daemon" in nextAction when daemonRunning is true', async () => {
    const { config, configPath } = loadPredictionTestConfig({});
    const status = await buildPredictionOperatorStatus({
      config,
      configPath,
      ...operatorStatusDeps,
      daemonRunning: true,
    });
    const text = JSON.stringify(status);
    expect(text).not.toMatch(/start the daemon/i);
    expect(text).toMatch(/waiting for tasks/i);
  });

  describe('legacy canonical-plugin config sanitization', () => {
    it('strips canonicalPlugin and referencePlugins from solver-nets show output for legacy SolverNet entries', async () => {
      const legacyConfig = {
        solverNets: {
          legacy: {
            enabled: true,
            solverType: 'prediction.v0',
            harness: 'claude-code-learner',
            canonicalPlugin: { source: 'bundled:jinn-prediction-plugin' },
            referencePlugins: ['npm:@example/old-reference-plugin'],
            plugins: [],
            taskGenerator: { enabled: true },
          },
        },
      };
      const configPath = tempConfig(legacyConfig);
      const result = await runSolverNets(['show', 'legacy', '--config', configPath]);

      expect(result.exits).toEqual([]);
      const envelope = result.envelope;
      expect(envelope['solverNet']).not.toHaveProperty('canonicalPlugin');
      expect(envelope['solverNet']).not.toHaveProperty('referencePlugins');
      // Legacy source was promoted into plugins[] so display sanitization does
      // not silently discard operator intent.
      expect(envelope['solverNet']['plugins']).toContain('bundled:jinn-prediction-plugin');
      // referencePlugins entries are dropped — they were never live runtime
      // substrate and the abandoned reference-plugin concept must not surface.
      expect(envelope['solverNet']['plugins']).not.toContain('npm:@example/old-reference-plugin');
    });

    it('returns a safe minimal shape when a SolverNet entry is malformed (not an object)', async () => {
      const malformedConfig = {
        solverNets: {
          broken: 42 as unknown as object,
        },
      };
      const configPath = tempConfig(malformedConfig);
      const result = await runSolverNets(['show', 'broken', '--config', configPath]);

      expect(result.exits).toEqual([]);
      const envelope = result.envelope;
      // Sanitizer must not emit the raw scalar — that would propagate
      // malformed config into operator-facing surfaces.
      expect(typeof envelope['solverNet']).toBe('object');
      expect(envelope['solverNet']).not.toBe(null);
    });

    it('strips canonicalPlugin from solver-nets doctor output for non-prediction.v1 SolverNets', async () => {
      const legacyConfig = {
        solverNets: {
          legacy: {
            enabled: true,
            solverType: 'prediction.v0',
            harness: 'claude-code-learner',
            canonicalPlugin: { source: 'bundled:jinn-prediction-plugin' },
            referencePlugins: ['bundled:jinn-prediction-plugin'],
            plugins: [],
            taskGenerator: { enabled: true },
          },
        },
      };
      const configPath = tempConfig(legacyConfig);
      const result = await runSolverNets(['doctor', 'legacy', '--config', configPath]);

      expect(result.exits).toEqual([]);
      const envelope = result.envelope;
      expect(envelope['verb']).toBe('solver-nets doctor');
      expect(envelope['solverNet']).not.toHaveProperty('canonicalPlugin');
      expect(envelope['solverNet']).not.toHaveProperty('referencePlugins');
    });

    it('does not duplicate plugins when canonicalPlugin.source already appears in plugins[]', async () => {
      const legacyConfig = {
        solverNets: {
          legacy: {
            enabled: true,
            solverType: 'prediction.v0',
            harness: 'claude-code-learner',
            canonicalPlugin: { source: 'bundled:jinn-prediction-plugin' },
            plugins: ['bundled:jinn-prediction-plugin'],
            taskGenerator: { enabled: true },
          },
        },
      };
      const configPath = tempConfig(legacyConfig);
      const result = await runSolverNets(['show', 'legacy', '--config', configPath]);

      const plugins = result.envelope['solverNet']['plugins'] as unknown[];
      const occurrences = plugins.filter((entry) => entry === 'bundled:jinn-prediction-plugin').length;
      expect(occurrences).toBe(1);
    });
  });

  describe('--human output mode', () => {
    it('solver-nets doctor --human emits readable text, not JSON, for prediction.v1', async () => {
      const configPath = tempConfig(predictionConfig());
      const made = makeCommandCtx({ argv: ['doctor', 'prediction', '--human', '--config', configPath] });
      await solverNetsCommand.run(made.ctx);
      const raw = made.writes.join('');

      expect(made.exits).toEqual([]);
      // First write must not be a JSON object header (which is what `--human`
      // is meant to suppress per docs/runbooks operator dogfood evidence).
      expect(raw.trim().startsWith('{')).toBe(false);
      expect(raw).toContain('SolverNet: prediction');
      expect(raw).toContain('solverType: prediction.v1');
    });

    it('solver-nets show --human emits readable text for arbitrary SolverNet entries', async () => {
      const legacyConfig = {
        solverNets: {
          legacy: {
            enabled: true,
            solverType: 'prediction.v0',
            harness: 'claude-code-learner',
            plugins: ['bundled:jinn-prediction-plugin'],
            taskGenerator: { enabled: true },
          },
        },
      };
      const configPath = tempConfig(legacyConfig);
      const made = makeCommandCtx({ argv: ['show', 'legacy', '--human', '--config', configPath] });
      await solverNetsCommand.run(made.ctx);
      const raw = made.writes.join('');

      expect(made.exits).toEqual([]);
      expect(raw.trim().startsWith('{')).toBe(false);
      expect(raw).toContain('SolverNet: legacy');
      expect(raw).toContain('plugins: bundled:jinn-prediction-plugin');
    });

    it('solver-nets doctor without --human keeps JSON output (default behaviour)', async () => {
      const configPath = tempConfig(predictionConfig());
      const result = await runSolverNets(['doctor', 'prediction', '--config', configPath]);

      expect(result.exits).toEqual([]);
      // runSolverNets already JSON.parses the writes — proves output remains JSON.
      expect(result.envelope['verb']).toBe('solver-nets doctor');
    });

    it('solver-nets list --human emits readable text, not JSON', async () => {
      const configPath = tempConfig(predictionConfig());
      const made = makeCommandCtx({ argv: ['list', '--human', '--config', configPath] });
      await solverNetsCommand.run(made.ctx);
      const raw = made.writes.join('');

      expect(made.exits).toEqual([]);
      // Help text advertises --human for list as well — verify it is honored.
      expect(raw.trim().startsWith('{')).toBe(false);
      expect(raw).toContain('prediction');
      expect(raw).toContain('prediction.v1');
    });
  });

  describe('solver-nets list — joinedSolverNets enumeration (issue #421)', () => {
    it('surfaces migrated legacy entries with source: joined and synthetic cid', async () => {
      // After issue #421, the legacy `solverNets.prediction` block on disk
      // is auto-migrated by loadConfig into a joinedSolverNets entry under
      // the synthetic key `legacy:prediction`. The list output surfaces it
      // with source='joined'.
      const configPath = tempConfig(predictionConfig());
      const result = await runSolverNets(['list', '--config', configPath]);

      expect(result.exits).toEqual([]);
      const nets = result.envelope['solverNets'] as Array<Record<string, unknown>>;
      expect(nets.length).toBeGreaterThan(0);
      const entry = nets.find((n) => n['name'] === 'prediction');
      expect(entry).toBeDefined();
      expect(entry?.['source']).toBe('joined');
      expect(entry?.['manifestCid']).toBe(LEGACY_PREDICTION_CID);
    });

    it('enumerates joinedSolverNets entries with source: joined', async () => {
      const configPath = tempConfig({
        joinedSolverNets: {
          'bafkreichdzxtjav3rh5boyybgx6wolh7boqedxix4vvw44slfppwppshpi': {
            manifestCid: 'bafkreichdzxtjav3rh5boyybgx6wolh7boqedxix4vvw44slfppwppshpi',
            name: 'SWE-rebench v2',
            roles: ['solver', 'evaluator'],
            harness: 'claude-code',
            plugins: [],
          },
        },
      });
      const result = await runSolverNets(['list', '--config', configPath]);

      expect(result.exits).toEqual([]);
      const nets = result.envelope['solverNets'] as Array<Record<string, unknown>>;
      expect(nets.length).toBe(1);
      expect(nets[0]?.['source']).toBe('joined');
      expect(nets[0]?.['name']).toBe('SWE-rebench v2');
      expect(nets[0]?.['manifestCid']).toBe('bafkreichdzxtjav3rh5boyybgx6wolh7boqedxix4vvw44slfppwppshpi');
    });

    it('returns one entry per joinedSolverNets membership (migrated + native)', async () => {
      const configPath = tempConfig({
        ...predictionConfig(),
        joinedSolverNets: {
          'bafkreichdzxtjav3rh5boyybgx6wolh7boqedxix4vvw44slfppwppshpi': {
            manifestCid: 'bafkreichdzxtjav3rh5boyybgx6wolh7boqedxix4vvw44slfppwppshpi',
            name: 'SWE-rebench v2',
            roles: ['solver'],
            harness: 'claude-code',
            plugins: [],
          },
        },
      });
      const result = await runSolverNets(['list', '--config', configPath]);

      expect(result.exits).toEqual([]);
      const nets = result.envelope['solverNets'] as Array<Record<string, unknown>>;
      expect(nets.length).toBe(2);
      // Both entries surface as source='joined' (one migrated, one native).
      for (const n of nets) {
        expect(n['source']).toBe('joined');
      }
      const cids = nets.map((n) => n['manifestCid']);
      expect(cids).toContain(LEGACY_PREDICTION_CID);
      expect(cids).toContain('bafkreichdzxtjav3rh5boyybgx6wolh7boqedxix4vvw44slfppwppshpi');
    });

    it('solver-nets list --human includes joined SolverNet name in output', async () => {
      const configPath = tempConfig({
        joinedSolverNets: {
          'bafkreichdzxtjav3rh5boyybgx6wolh7boqedxix4vvw44slfppwppshpi': {
            manifestCid: 'bafkreichdzxtjav3rh5boyybgx6wolh7boqedxix4vvw44slfppwppshpi',
            name: 'SWE-rebench v2',
            roles: ['solver'],
            harness: 'claude-code',
            plugins: [],
          },
        },
      });
      const made = makeCommandCtx({ argv: ['list', '--human', '--config', configPath] });
      await solverNetsCommand.run(made.ctx);
      const raw = made.writes.join('');

      expect(made.exits).toEqual([]);
      expect(raw.trim().startsWith('{')).toBe(false);
      expect(raw).toContain('SWE-rebench v2');
      expect(raw).toContain('joined');
    });
  });

  describe('solver-nets show/doctor/sample — joined-first resolution (issue #421 F4)', () => {
    // F4: after loadConfig migration, `jinn solver-nets show prediction` for
    // an operator who has rejoined via the SPA returned a synthetic
    // predictionDefault() stub via readConfig → ensureSolverNets, ignoring
    // their actual joinedSolverNets membership. The fix prefers the joined
    // config and falls back to legacy on-disk only when nothing matches.

    it('show resolves prediction from a migrated legacy:prediction joined entry', async () => {
      // Legacy on-disk solverNets.prediction triggers loadConfig migration to
      // joinedSolverNets['legacy:prediction']; `show prediction` must find it
      // via the joined view, not fall through to the synthetic default.
      const configPath = tempConfig(predictionConfig({
        harness: 'prediction-v1-baseline',
        plugins: ['bundled:jinn-prediction-plugin'],
      }));
      const result = await runSolverNets(['show', 'prediction', '--config', configPath]);

      expect(result.exits).toEqual([]);
      const envelope = result.envelope;
      expect(envelope['name']).toBe('prediction');
      expect(envelope['solverNet']).toMatchObject({
        solverType: 'prediction.v1',
        harness: 'prediction-v1-baseline',
      });
      expect((envelope['solverNet'] as { plugins: unknown }).plugins).toContain('bundled:jinn-prediction-plugin');
    });

    it('show resolves prediction from a real (non-legacy) joinedSolverNets entry by display name', async () => {
      // The SPA join flow writes a real manifestCid entry — `show prediction`
      // must match it via the entry's `name` field rather than synthesizing a
      // default stub.
      const configPath = tempConfig({
        joinedSolverNets: {
          'bafkreigenuineprediction0000000000000000000000000000000000': {
            manifestCid: 'bafkreigenuineprediction0000000000000000000000000000000000',
            name: 'prediction',
            contract: { id: 'prediction', version: 'v1' },
            roles: ['solver'],
            harness: 'prediction-v1-baseline',
            plugins: ['bundled:jinn-prediction-plugin'],
          },
        },
      });
      const result = await runSolverNets(['show', 'prediction', '--config', configPath]);

      expect(result.exits).toEqual([]);
      const envelope = result.envelope;
      expect(envelope['solverNet']).toMatchObject({
        solverType: 'prediction.v1',
        harness: 'prediction-v1-baseline',
      });
    });

    it('show prints Unknown SolverNet when name has no legacy file entry and no joined entry', async () => {
      // Empty config — no legacy on-disk solverNets block, no joinedSolverNets
      // entry. The synthetic predictionDefault() path used to mask this; the
      // fix surfaces it as an unambiguous error.
      const configPath = tempConfig({});
      const result = await runSolverNets(['show', 'prediction', '--config', configPath]);

      expect(result.exits).toEqual([1]);
      expect(result.envelope['error']).toMatchObject({
        code: 'invalid_invocation',
        message: 'Unknown SolverNet: prediction',
      });
    });

    it('doctor on a migrated legacy entry reaches prediction.v1 status (no synthetic default fallback)', async () => {
      // The doctor subverb is the operator's structured diagnostic surface;
      // it must run the prediction.v1 status branch against the migrated
      // joined entry rather than a synthetic stub.
      const configPath = tempConfig(predictionConfig());
      const result = await runSolverNets(['doctor', 'prediction', '--config', configPath]);

      expect(result.exits).toEqual([]);
      expect(result.envelope['verb']).toBe('solver-nets doctor');
      expect(result.envelope['kind']).toBe('prediction.v1.operatorStatus');
    });

    it('doctor prints Unknown SolverNet when neither legacy nor joined match', async () => {
      const configPath = tempConfig({});
      const result = await runSolverNets(['doctor', 'prediction', '--config', configPath]);

      expect(result.exits).toEqual([1]);
      expect(result.envelope['error']).toMatchObject({
        code: 'invalid_invocation',
        message: 'Unknown SolverNet: prediction',
      });
    });
  });
});
