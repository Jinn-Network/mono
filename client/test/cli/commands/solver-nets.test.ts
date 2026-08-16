import { mkdtempSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { keccak256, toBytes } from 'viem';
import { describe, expect, it, vi } from 'vitest';
import solverNetsCommand, { parseMintTaskCandidates } from '@/cli/commands/solver-nets.js';
import { loadConfig, type JinnConfig } from '@/config.js';
import type { ExecutionWiringConfigEntry } from '@/config/shape-v2.js';
import type { Harness, RuntimePlugin } from '@/harnesses/types.js';
import {
  buildPredictionOperatorStatus,
  runPredictionSample,
  type PredictionOperatorDiagnostic,
} from '@/solver-nets/prediction-operator-ux.js';
import { makeCommandCtx } from '@test/cli.js';
import { JINN_MONO_VITEST_JSON_PARSER_CONTRACT_FIXTURE } from '@/task-creator/proofs/public-repo-fixtures.js';
import { runPublicRepoParityFixture } from '@/task-creator/proofs/vitest-json-fixture.js';
import {
  createDifferentialAdmissionReceiptV2,
  hashDifferentialAdmissionReceiptV2,
} from '@/solver-types/_swe-rebench-v2-differential-admission.js';
import { runMintTasksPipeline } from '@/solver-types/_swe-rebench-v2-mint-cli.js';
import { MintedPoolStore } from '@/solver-types/_swe-rebench-v2-minted-pool.js';
import { ValidatedPoolStore } from '@/solver-types/_swe-rebench-v2-validated-pool.js';
import { jinnDifferentialReceiptContractFixture } from '../../task-creator/jinn-differential-receipt-contract-fixture.js';

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

// On-disk legacy `solverNets.prediction` migrates to executionWiring with
// `workKind: 'prediction.v1'` and `legacyManifestDigest` = keccak of
// `legacy:prediction`. Doctor configField strings use that digest.
const LEGACY_PREDICTION_CID = 'legacy:prediction';
const LEGACY_PREDICTION_DIGEST = keccak256(toBytes(LEGACY_PREDICTION_CID));

function predictionWiring(config: JinnConfig): ExecutionWiringConfigEntry | undefined {
  return config.executionWiring?.find((entry) => entry.workKind.startsWith('prediction.'));
}

const SWE_REBENCH_CID = 'bafkreichdzxtjav3rh5boyybgx6wolh7boqedxix4vvw44slfppwppshpi';
const SWE_REBENCH_DIGEST = keccak256(toBytes(SWE_REBENCH_CID));

function executionWiringEntry(
  overrides: Partial<ExecutionWiringConfigEntry> & Pick<ExecutionWiringConfigEntry, 'workKind'>,
): ExecutionWiringConfigEntry {
  return {
    harness: 'claude-code',
    model: 'claude-haiku-4-5-20251001',
    plugins: [],
    credentialRef: 'claude-code-default',
    isolationPolicy: 'process',
    ...overrides,
  };
}

const operatorStatusDeps = {
  loadSolverNets: async () => ({
    get: (name: string) => name === 'prediction.v1'
      ? {
          name: 'prediction.v1',
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
  it('preserves a receipt-bound differential admission candidate through the mint CLI edge', () => {
    const fixture = jinnDifferentialReceiptContractFixture();
    const [candidate] = parseMintTaskCandidates({
      poolTask: {
        instance_id: fixture.receipt.task.instanceId,
        repo: fixture.receipt.task.repo,
        base_commit: fixture.receipt.task.baseCommit,
        language: 'typescript',
        test_patch: fixture.testPatch,
      },
      goldPatch: 'local-only-gold',
      fixCommit: fixture.receipt.task.fixCommit,
      provenance: { synthetic: true, mintFamily: 'commit-echo', sourceLineageHash: 'sha256:fixture' },
      environment: fixture.environment,
      differentialAdmission: {
        receipt: fixture.receipt,
        receiptHash: hashDifferentialAdmissionReceiptV2(fixture.receipt),
        receiptCid: 'bafy-test-only-jinn-differential-receipt',
      },
    });

    expect(candidate?.fixCommit).toBe(fixture.receipt.task.fixCommit);
    expect(candidate?.differentialAdmission).toEqual({
      receipt: fixture.receipt,
      receiptHash: hashDifferentialAdmissionReceiptV2(fixture.receipt),
      receiptCid: 'bafy-test-only-jinn-differential-receipt',
    });
  });

  it('keeps an explicit public-repository environment binding at the mint CLI edge', () => {
    const fixture = runPublicRepoParityFixture(JINN_MONO_VITEST_JSON_PARSER_CONTRACT_FIXTURE);
    const [candidate] = parseMintTaskCandidates({
      poolTask: { instance_id: fixture.proof.instanceId },
      goldPatch: 'local-only-gold',
      provenance: { synthetic: true, mintFamily: 'commit-echo', sourceLineageHash: 'sha256:fixture' },
      environment: fixture.environment,
    });

    expect(candidate?.environment).toEqual(fixture.environment);
    expect(candidate?.publish).toBeUndefined();
    expect(parseMintTaskCandidates({
      poolTask: { instance_id: fixture.proof.instanceId },
      goldPatch: 'local-only-gold',
      provenance: { synthetic: true, mintFamily: 'commit-echo', sourceLineageHash: 'sha256:fixture' },
      environment: fixture.environment,
      publish: true,
    }, true)[0]?.publish).toBe(false);
  });

  it('admits the documented receipt-bound fresh v2 CLI candidate shape without fetching its local IPFS placeholder', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jinn-cli-mint-v2-'));
    const digest = `sha256:${'a'.repeat(64)}`;
    const environment = {
      environmentSpecCid: 'bafy-environment', environmentHash: `sha256:${'c'.repeat(64)}`,
      attestation: {
        scheme: 'eip191' as const, algo: 'secp256k1' as const, environmentHash: `sha256:${'c'.repeat(64)}`,
        operatorSafe: `0x${'1'.repeat(40)}`, signer: `0x${'2'.repeat(40)}`, signature: `0x${'3'.repeat(130)}`,
      },
      parser: { id: 'vitest-json.v1', version: 'v1', digest, bundleId: 'jinn.swe-rebench-v2.patch-bundle.v1' },
      image: { reference: `ghcr.io/jinn-network/task-environment@${digest}`, digest },
      platform: 'linux/amd64' as const,
    };
    const environmentSpec = {
      source: { repo: 'acme/widget', baseCommit: 'b'.repeat(40) },
      attestation: { environmentHash: environment.environmentHash },
      execution: {
        platform: environment.platform,
        image: environment.image,
        parser: environment.parser,
        testCommands: [{ bin: 'yarn', args: ['vitest', 'run'] }],
      },
    } as unknown as import('@/task-creator/environment/contracts.js').TaskEnvironmentSpecV1;
    const receipt = createDifferentialAdmissionReceiptV2({
      task: { instanceId: 'acme__widget__echo-123', repo: 'acme/widget', baseCommit: 'b'.repeat(40), fixCommit: 'f'.repeat(40) },
      goldPatchHash: `sha256:${createHash('sha256').update('local-only-gold').digest('hex')}`,
      testPatchHash: `sha256:${createHash('sha256').update('diff --git a/test/widget.test.ts b/test/widget.test.ts').digest('hex')}`,
      environment: environmentSpec,
      evalSemanticsVersion: '4',
      testPaths: [{
        testPath: 'test/widget.test.ts',
        broken: [{ passed: [], failed: ['public regression'], passed_match: false }, { passed: [], failed: ['public regression'], passed_match: false }],
        fixed: [{ passed: ['public regression'], failed: [], passed_match: true }, { passed: ['public regression'], failed: [], passed_match: true }],
      }],
    });
    const [candidate] = parseMintTaskCandidates({
      poolTask: {
        instance_id: 'acme__widget__echo-123', repo: 'acme/widget', base_commit: 'b'.repeat(40),
        language: 'typescript', test_patch: 'diff --git a/test/widget.test.ts b/test/widget.test.ts',
      },
      goldPatch: 'local-only-gold',
      fixCommit: 'f'.repeat(40),
      provenance: { synthetic: true, mintFamily: 'commit-echo', sourceLineageHash: 'sha256:fixture' },
      environment,
      differentialAdmission: {
        receipt,
        receiptHash: hashDifferentialAdmissionReceiptV2(receipt),
        receiptCid: 'QmYwAPJzv5CZsnAzt8auVTLF9rYx8S1R52eX5GJH2RGfZp',
      },
      publish: false,
    });
    const fallbackFetcher = { fetchTaskRow: vi.fn().mockRejectedValue(new Error('must not fetch ipfs://local-minted-pending')) };
    const runner = {
      runEval: vi.fn()
        .mockResolvedValueOnce({ passed_match: true, passed: ['public regression'], failed: [], log: '', exitCode: 0, imageDigest: digest })
        .mockResolvedValueOnce({ passed_match: false, passed: [], failed: ['public regression'], log: '', exitCode: 0 }),
    };

    const result = await runMintTasksPipeline({
      candidates: [candidate!], stateDir: dir,
      ipfsRegistryUrl: 'https://registry.example', ipfsGatewayUrl: 'https://gateway.example',
      validatedStore: new ValidatedPoolStore({ stateDir: dir }), mintedStore: new MintedPoolStore({ stateDir: dir }),
      fetcher: fallbackFetcher, runner, upstreamRepoDir: dir,
      publicRepoChecker: { isPublic: async () => true },
      environmentVerifier: {
        verify: async () => ({
          ...environmentSpec,
        }),
      },
    });

    expect(result.admitted).toEqual(['acme__widget__echo-123']);
    expect(fallbackFetcher.fetchTaskRow).not.toHaveBeenCalled();
    expect(runner.runEval).toHaveBeenCalledTimes(2);
  });

  it('diagnoses Prediction SolverNet status with plugin and Harness details', async () => {
    const configPath = tempConfig(predictionConfig());
    const result = await runSolverNets(['doctor', 'prediction.v1', '--config', configPath]);

    expect(result.exits).toEqual([]);
    const envelope = result.envelope;
    expect(envelope['verb']).toBe('solver-nets doctor');
    expect(envelope['kind']).toBe('prediction.v1.operatorStatus');
    expect(envelope['ok']).toBe(true);
    expect(envelope['solverNet']).toMatchObject({
      name: 'prediction.v1',
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
    const result = await runSolverNets(['doctor', 'prediction.v1', '--config', configPath]);

    expect(result.exits).toEqual([]);
    const envelope = result.envelope;
    expect(envelope['ok']).toBe(false);
    expect(envelope['diagnostics']).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'prediction_plugin_unavailable',
          severity: 'error',
          configField: `executionWiring.${LEGACY_PREDICTION_DIGEST}.plugins`,
        }),
      ]),
    );
  });

  it('reports selected Prediction Harnesses disabled in operator config', async () => {
    const configPath = tempConfig({
      ...predictionConfig({ harness: 'prediction-v1-baseline' }),
      harnesses: { disabled: ['prediction-v1-baseline'] },
    });
    const result = await runSolverNets(['doctor', 'prediction.v1', '--config', configPath]);

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
    const result = await runSolverNets(['doctor', 'prediction.v1', '--config', configPath]);

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
    const result = await runSolverNets(['doctor', 'prediction.v1', '--config', configPath]);

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
    // Sample resolves via findWiringByName against executionWiring
    // (workKind prediction.v1 after migrating solverNets.prediction).
    const configPath = tempConfig(predictionConfig());
    const result = await runSolverNets(['sample', 'prediction.v1', '--config', configPath]);

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
    const result = await runSolverNets(['sample', 'prediction.v1', '--closed-window', '--config', configPath]);

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
        configField: `executionWiring.${LEGACY_PREDICTION_DIGEST}.plugins`,
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
        configField: `executionWiring.${LEGACY_PREDICTION_DIGEST}.plugins`,
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
        configField: `executionWiring.${LEGACY_PREDICTION_DIGEST}.workKind`,
      },
      // findPredictionWiring matches workKind.startsWith('prediction.');
      // advancing the version keeps the row visible while failing the
      // prediction.v1 solverType check.
      config: () => loadPredictionTestConfig({}, (config) => {
        const entry = predictionWiring(config);
        if (entry) entry.workKind = 'prediction.v2';
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
        configField: `executionWiring.${LEGACY_PREDICTION_DIGEST}.harness`,
      },
      config: () => loadPredictionTestConfig({}, (config) => {
        const entry = predictionWiring(config);
        if (entry) (entry as { harness?: string }).harness = undefined;
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
        configField: `executionWiring.${LEGACY_PREDICTION_DIGEST}.harness`,
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
        configField: `executionWiring.${LEGACY_PREDICTION_DIGEST}.harness`,
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
        configField: `executionWiring.${LEGACY_PREDICTION_DIGEST}.harness`,
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
        configField: `executionWiring.${LEGACY_PREDICTION_DIGEST}`,
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

  it('reports a generic operator recovery path when no prediction executionWiring row exists', async () => {
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
    expect(diagnostic?.configField).toBe('executionWiring');
    expect(diagnostic?.nextAction).toEqual({
      description: 'Add a prediction.v1 executionWiring row in Settings > Claim policy.',
      url: '/operator/claim-policy',
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
      const result = await runSolverNets(['show', 'prediction.v0', '--config', configPath]);

      expect(result.exits).toEqual([]);
      const envelope = result.envelope;
      expect(envelope['solverNet']).not.toHaveProperty('canonicalPlugin');
      expect(envelope['solverNet']).not.toHaveProperty('referencePlugins');
      // Shape-v2 migration copies plugins[] only; canonicalPlugin is not
      // promoted into executionWiring.
      expect(envelope['solverNet']['plugins']).not.toContain('bundled:jinn-prediction-plugin');
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

      expect(result.exits).toEqual([1]);
      expect(result.envelope['error']).toMatchObject({
        code: 'invalid_invocation',
        message: 'Unknown SolverNet: broken',
      });
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
      const result = await runSolverNets(['doctor', 'prediction.v0', '--config', configPath]);

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
      const result = await runSolverNets(['show', 'prediction.v0', '--config', configPath]);

      const plugins = result.envelope['solverNet']['plugins'] as unknown[];
      const occurrences = plugins.filter((entry) => entry === 'bundled:jinn-prediction-plugin').length;
      expect(occurrences).toBe(1);
    });
  });

  describe('--human output mode', () => {
    it('solver-nets doctor --human emits readable text, not JSON, for prediction.v1', async () => {
      const configPath = tempConfig(predictionConfig());
      const made = makeCommandCtx({ argv: ['doctor', 'prediction.v1', '--human', '--config', configPath] });
      await solverNetsCommand.run(made.ctx);
      const raw = made.writes.join('');

      expect(made.exits).toEqual([]);
      // First write must not be a JSON object header (which is what `--human`
      // is meant to suppress per docs/runbooks operator dogfood evidence).
      expect(raw.trim().startsWith('{')).toBe(false);
      expect(raw).toContain('SolverNet: prediction.v1');
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
      const made = makeCommandCtx({ argv: ['show', 'prediction.v0', '--human', '--config', configPath] });
      await solverNetsCommand.run(made.ctx);
      const raw = made.writes.join('');

      expect(made.exits).toEqual([]);
      expect(raw.trim().startsWith('{')).toBe(false);
      expect(raw).toContain('SolverNet: prediction.v0');
      expect(raw).toContain('plugins: bundled:jinn-prediction-plugin');
    });

    it('solver-nets doctor without --human keeps JSON output (default behaviour)', async () => {
      const configPath = tempConfig(predictionConfig());
      const result = await runSolverNets(['doctor', 'prediction.v1', '--config', configPath]);

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
      expect(raw).toContain('prediction.v1');
      expect(raw).toContain('executionWiring');
    });
  });

  describe('solver-nets list — executionWiring enumeration', () => {
    it('surfaces migrated legacy entries with source: executionWiring and keccak digest', async () => {
      const configPath = tempConfig(predictionConfig());
      const result = await runSolverNets(['list', '--config', configPath]);

      expect(result.exits).toEqual([]);
      const nets = result.envelope['solverNets'] as Array<Record<string, unknown>>;
      expect(nets.length).toBeGreaterThan(0);
      const entry = nets.find((n) => n['name'] === 'prediction.v1');
      expect(entry).toBeDefined();
      expect(entry?.['source']).toBe('executionWiring');
      expect(entry?.['manifestCid']).toBe(LEGACY_PREDICTION_DIGEST);
      expect(entry?.['taskGeneratorEnabled']).toBe(false);
    });

    it('enumerates executionWiring entries with source: executionWiring', async () => {
      const configPath = tempConfig({
        configShapeVersion: 2,
        executionWiring: [
          executionWiringEntry({
            workKind: 'swe-rebench-v2.v1',
            harness: 'claude-code',
            legacyManifestDigest: SWE_REBENCH_DIGEST,
          }),
        ],
      });
      const result = await runSolverNets(['list', '--config', configPath]);

      expect(result.exits).toEqual([]);
      const nets = result.envelope['solverNets'] as Array<Record<string, unknown>>;
      expect(nets.length).toBe(1);
      expect(nets[0]?.['source']).toBe('executionWiring');
      expect(nets[0]?.['name']).toBe('swe-rebench-v2.v1');
      expect(nets[0]?.['manifestCid']).toBe(SWE_REBENCH_DIGEST);
    });

    it('returns one entry per executionWiring row', async () => {
      const configPath = tempConfig({
        configShapeVersion: 2,
        executionWiring: [
          executionWiringEntry({
            workKind: 'prediction.v1',
            harness: 'prediction-v1-baseline',
            plugins: ['bundled:jinn-prediction-plugin'],
            credentialRef: 'prediction-v1-baseline-default',
            legacyManifestDigest: LEGACY_PREDICTION_DIGEST,
          }),
          executionWiringEntry({
            workKind: 'swe-rebench-v2.v1',
            harness: 'claude-code',
            legacyManifestDigest: SWE_REBENCH_DIGEST,
          }),
        ],
      });
      const result = await runSolverNets(['list', '--config', configPath]);

      expect(result.exits).toEqual([]);
      const nets = result.envelope['solverNets'] as Array<Record<string, unknown>>;
      expect(nets.length).toBe(2);
      for (const n of nets) {
        expect(n['source']).toBe('executionWiring');
      }
      const cids = nets.map((n) => n['manifestCid']);
      expect(cids).toContain(LEGACY_PREDICTION_DIGEST);
      expect(cids).toContain(SWE_REBENCH_DIGEST);
    });

    it('solver-nets list --human includes workKind and executionWiring source', async () => {
      const configPath = tempConfig({
        configShapeVersion: 2,
        executionWiring: [
          executionWiringEntry({
            workKind: 'swe-rebench-v2.v1',
            harness: 'claude-code',
            legacyManifestDigest: SWE_REBENCH_DIGEST,
          }),
        ],
      });
      const made = makeCommandCtx({ argv: ['list', '--human', '--config', configPath] });
      await solverNetsCommand.run(made.ctx);
      const raw = made.writes.join('');

      expect(made.exits).toEqual([]);
      expect(raw.trim().startsWith('{')).toBe(false);
      expect(raw).toContain('swe-rebench-v2.v1');
      expect(raw).toContain('executionWiring');
    });
  });

  describe('solver-nets mutation subverbs', () => {
    it.each(['enable', 'disable', 'set-harness', 'add-plugin', 'remove-plugin'] as const)(
      'retires solver-nets %s with a non-zero exit',
      async (subverb) => {
        const configPath = tempConfig(predictionConfig());
        const result = await runSolverNets([subverb, 'prediction.v1', '--config', configPath]);
        expect(result.exits).toEqual([1]);
        expect(result.envelope['error']).toMatchObject({
          code: 'invalid_invocation',
          message: `solver-nets ${subverb} was retired. Edit executionWiring in the operator config and restart.`,
        });
      },
    );
  });

  describe('solver-nets show/doctor/sample — executionWiring resolution', () => {
    it('show resolves prediction.v1 from a migrated legacy solverNets.prediction block', async () => {
      const configPath = tempConfig(predictionConfig({
        harness: 'prediction-v1-baseline',
        plugins: ['bundled:jinn-prediction-plugin'],
      }));
      const result = await runSolverNets(['show', 'prediction.v1', '--config', configPath]);

      expect(result.exits).toEqual([]);
      const envelope = result.envelope;
      expect(envelope['name']).toBe('prediction.v1');
      expect(envelope['solverNet']).toMatchObject({
        solverType: 'prediction.v1',
        harness: 'prediction-v1-baseline',
      });
      expect((envelope['solverNet'] as { plugins: unknown }).plugins).toContain('bundled:jinn-prediction-plugin');
    });

    it('show resolves prediction.v1 from an executionWiring row by workKind', async () => {
      const configPath = tempConfig({
        configShapeVersion: 2,
        executionWiring: [
          executionWiringEntry({
            workKind: 'prediction.v1',
            harness: 'prediction-v1-baseline',
            plugins: ['bundled:jinn-prediction-plugin'],
            credentialRef: 'prediction-v1-baseline-default',
            legacyManifestDigest: keccak256(toBytes('bafkreigenuineprediction0000000000000000000000000000000000')),
          }),
        ],
      });
      const result = await runSolverNets(['show', 'prediction.v1', '--config', configPath]);

      expect(result.exits).toEqual([]);
      const envelope = result.envelope;
      expect(envelope['solverNet']).toMatchObject({
        solverType: 'prediction.v1',
        harness: 'prediction-v1-baseline',
      });
    });

    it('show prints Unknown SolverNet when no executionWiring row matches', async () => {
      const configPath = tempConfig({});
      const result = await runSolverNets(['show', 'prediction.v1', '--config', configPath]);

      expect(result.exits).toEqual([1]);
      expect(result.envelope['error']).toMatchObject({
        code: 'invalid_invocation',
        message: 'Unknown SolverNet: prediction.v1',
      });
    });

    it('doctor on a migrated legacy entry reaches prediction.v1 status (no synthetic default fallback)', async () => {
      // The doctor subverb is the operator's structured diagnostic surface;
      // it must run the prediction.v1 status branch against the migrated
      // joined entry rather than a synthetic stub.
      const configPath = tempConfig(predictionConfig());
      const result = await runSolverNets(['doctor', 'prediction.v1', '--config', configPath]);

      expect(result.exits).toEqual([]);
      expect(result.envelope['verb']).toBe('solver-nets doctor');
      expect(result.envelope['kind']).toBe('prediction.v1.operatorStatus');
    });

    it('doctor prints Unknown SolverNet when no executionWiring row matches', async () => {
      const configPath = tempConfig({});
      const result = await runSolverNets(['doctor', 'prediction.v1', '--config', configPath]);

      expect(result.exits).toEqual([1]);
      expect(result.envelope['error']).toMatchObject({
        code: 'invalid_invocation',
        message: 'Unknown SolverNet: prediction.v1',
      });
    });
  });
});
