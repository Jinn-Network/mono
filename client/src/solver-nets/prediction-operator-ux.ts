import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PredictionV1RestorationPayloadSchema,
} from '@jinn-network/sdk/solvernets/prediction-v1';
import type { JinnConfig } from '../config.js';
import { DEFAULT_DISABLED_HARNESSES } from '../harnesses/engine/registry.js';
import {
  loadExternalImpl as defaultLoadExternalImpl,
  type LoadExternalImplArgs,
} from '../harnesses/external-impls/index.js';
import { buildHarnesses as defaultBuildHarnesses } from '../harnesses/impls/index.js';
import { PredictionV1BaselineImpl } from '../harnesses/impls/prediction-v1-baseline/index.js';
import type { Harness, ReadyStatus, RuntimePlugin } from '../harnesses/types.js';
import { TrajectoryCollector } from '../trajectory/collector.js';
import { PredictionV1TaskSchema, type PredictionV1Task } from '../types/prediction-v1.js';
import type { SolverPluginEntry } from '../plugins/types.js';
import {
  loadSolverNets as defaultLoadSolverNets,
  type LoadedSolverNet,
  type SolverNetConfig,
} from './registry.js';

export type PredictionOperatorDiagnosticSeverity = 'error' | 'warning' | 'info';

export interface PredictionOperatorDiagnostic {
  code: string;
  severity: PredictionOperatorDiagnosticSeverity;
  message: string;
  configField?: string;
  nextAction?: {
    description: string;
    cli?: string;
    url?: string;
  };
}

export interface PredictionOperatorStatus {
  kind: 'prediction.v1.operatorStatus';
  ok: boolean;
  configPath: string;
  solverNet: {
    name: string;
    enabled: boolean;
    solverType: string;
    harness?: string;
    taskGeneratorEnabled: boolean;
  };
  canonicalPlugin?: PredictionPluginStatus;
  extraPlugins: PredictionPluginStatus[];
  harness?: {
    name: string;
    version: string;
    supportsPredictionV1Restoration: boolean;
    readiness: ReadyStatus;
  };
  diagnostics: PredictionOperatorDiagnostic[];
  nextAction: {
    description: string;
    cli?: string;
    url?: string;
  };
}

export interface PredictionPluginStatus {
  role: RuntimePlugin['role'];
  source: string | null;
  name?: string;
  version?: string;
  supports?: string[];
  root?: string;
  manifestPath?: string;
  sha256?: string;
  cid?: string;
}

export interface PredictionSampleRun {
  kind: 'prediction.v1.sampleRun';
  ok: boolean;
  task: {
    id: string;
    question: string;
    window: PredictionV1Task['window'];
  };
  harness: {
    name: string;
    version: string;
  };
  solution?: {
    probabilityYes?: unknown;
    submittedAt?: unknown;
    modelId?: unknown;
    payload: Record<string, unknown>;
    artifactPath: string;
    workingDir: string;
  };
  diagnostics: PredictionOperatorDiagnostic[];
}

type BuildHarnesses = typeof defaultBuildHarnesses;
type LoadExternalImpl = typeof defaultLoadExternalImpl;
type LoadSolverNets = typeof defaultLoadSolverNets;

export interface BuildPredictionOperatorStatusOptions {
  config: JinnConfig;
  configPath: string;
  name?: string;
  buildHarnesses?: BuildHarnesses;
  loadExternalImpl?: LoadExternalImpl;
  loadSolverNets?: LoadSolverNets;
}

export interface RunPredictionSampleOptions {
  now?: number;
  closedWindow?: boolean;
  workingRoot?: string;
  harness?: PredictionV1BaselineImpl;
}

function sourceOf(entry: SolverPluginEntry | undefined): string | null {
  if (!entry) return null;
  return typeof entry === 'string' ? entry : entry.source;
}

function pluginStatus(
  role: RuntimePlugin['role'],
  source: string | null,
  plugin?: RuntimePlugin,
): PredictionPluginStatus {
  return {
    role,
    source,
    ...(plugin
      ? {
          name: plugin.name,
          version: plugin.version,
          supports: plugin.supports,
          root: plugin.root,
          manifestPath: plugin.manifestPath,
          sha256: plugin.sha256,
          ...(plugin.cid ? { cid: plugin.cid } : {}),
        }
      : {}),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function diagnosticNextAction(
  diagnostics: PredictionOperatorDiagnostic[],
): PredictionOperatorStatus['nextAction'] {
  const firstError = diagnostics.find((d) => d.severity === 'error' && d.nextAction);
  if (firstError?.nextAction) return firstError.nextAction;
  const firstWarning = diagnostics.find((d) => d.severity === 'warning' && d.nextAction);
  if (firstWarning?.nextAction) return firstWarning.nextAction;
  return {
    description: 'Prediction SolverNet is configured; start the daemon to watch shared Tasks.',
    cli: 'jinn run',
  };
}

function missingSolverNetStatus(
  configPath: string,
  name: string,
): PredictionOperatorStatus {
  const diagnostics: PredictionOperatorDiagnostic[] = [
    {
      code: 'prediction_solvernet_missing',
      severity: 'error',
      message: `No SolverNet named '${name}' is configured.`,
      configField: `solverNets.${name}`,
      nextAction: {
        description: name === 'prediction'
          ? 'Enable the default Prediction SolverNet.'
          : 'Choose a configured SolverNet or add it to config.',
        cli: name === 'prediction' ? 'jinn solver-nets enable prediction' : 'jinn solver-nets list',
      },
    },
  ];
  return {
    kind: 'prediction.v1.operatorStatus',
    ok: false,
    configPath,
    solverNet: {
      name,
      enabled: false,
      solverType: 'prediction.v1',
      taskGeneratorEnabled: false,
    },
    extraPlugins: [],
    diagnostics,
    nextAction: diagnosticNextAction(diagnostics),
  };
}

export async function buildPredictionOperatorStatus({
  config,
  configPath,
  name = 'prediction',
  buildHarnesses = defaultBuildHarnesses,
  loadExternalImpl = defaultLoadExternalImpl,
  loadSolverNets = defaultLoadSolverNets,
}: BuildPredictionOperatorStatusOptions): Promise<PredictionOperatorStatus> {
  const net = config.solverNets[name];
  if (!net) return missingSolverNetStatus(configPath, name);

  const diagnostics: PredictionOperatorDiagnostic[] = [];
  let loadedNet: LoadedSolverNet | undefined;
  let pluginLoadError: string | null = null;

  if (!net.enabled) {
    diagnostics.push({
      code: 'prediction_solvernet_disabled',
      severity: 'error',
      message: 'Prediction SolverNet is disabled.',
      configField: `solverNets.${name}.enabled`,
      nextAction: {
        description: 'Enable the Prediction SolverNet before participating.',
        cli: `jinn solver-nets enable ${name}`,
      },
    });
  }

  if (net.solverType !== 'prediction.v1') {
    diagnostics.push({
      code: 'prediction_solver_type_mismatch',
      severity: 'error',
      message: `SolverNet '${name}' is configured for ${net.solverType}, not prediction.v1.`,
      configField: `solverNets.${name}.solverType`,
      nextAction: {
        description: 'Set the SolverNet solverType to prediction.v1.',
      },
    });
  }

  if (net.enabled) {
    try {
      const registry = await loadSolverNets({
        solverNets: {
          [name]: net as SolverNetConfig,
        },
      });
      loadedNet = registry.get(name);
    } catch (error) {
      pluginLoadError = errorMessage(error);
      diagnostics.push({
        code: 'prediction_plugin_unavailable',
        severity: 'error',
        message: pluginLoadError,
        configField: `solverNets.${name}.canonicalPlugin`,
        nextAction: {
          description: 'Fix the Prediction SolverPlugin source or restore the bundled plugin.',
          cli: `jinn solver-nets show ${name}`,
        },
      });
    }
  }

  const externalHarnesses: Harness[] = [];
  const selectedExternalEntry = config.harnesses?.externalImpls?.find((entry) => entry.name === net.harness);
  let selectedExternalUnavailable = false;
  for (const entry of config.harnesses?.externalImpls ?? []) {
    const result = await loadExternalImpl({
      entry,
      trustedSigners: config.trustedImplSigners ?? [],
      env: {
        implName: entry.name,
        implVersion: '0.0.0',
        network: config.network,
        implStateDir: join(config.engine.implStateDirRoot, entry.name),
        secrets: Object.freeze({}),
        log: () => {},
        stub: true,
      },
    } satisfies LoadExternalImplArgs);
    if (result.kind === 'ok') {
      externalHarnesses.push(result.impl);
    } else if (entry.name === net.harness) {
      selectedExternalUnavailable = true;
      diagnostics.push({
        code: 'prediction_harness_external_unavailable',
        severity: 'error',
        message: `Selected external Harness '${entry.name}' could not be loaded: ${result.reason}${result.detail ? ` (${result.detail})` : ''}.`,
        configField: `harnesses.externalImpls.${entry.name}`,
        nextAction: {
          description: 'Fix the configured external Harness package or select an installed Harness.',
          cli: `jinn harnesses list`,
        },
      });
    }
  }

  const disabledHarnesses = config.harnesses?.disabled ?? [...DEFAULT_DISABLED_HARNESSES];
  const selectedHarnessDisabled = Boolean(net.harness && disabledHarnesses.includes(net.harness));
  const harnesses = buildHarnesses({
    stub: true,
    rpcUrl: config.rpcUrl,
    archiveRpcUrl: config.archiveRpcUrl,
    claudePath: config.claudePath,
    claudeModel: config.claudeModel,
    implStateDirRoot: config.engine.implStateDirRoot,
    externalImpls: externalHarnesses,
    disabledNames: disabledHarnesses,
  });
  const selectedHarness = net.harness
    ? harnesses.find((candidate) => candidate.name === net.harness)
    : undefined;
  const harnessStatus = selectedHarness
    ? await buildHarnessStatus(selectedHarness)
    : undefined;

  if (!net.harness) {
    diagnostics.push({
      code: 'prediction_harness_missing',
      severity: 'error',
      message: 'No Harness is selected for the Prediction SolverNet.',
      configField: `solverNets.${name}.harness`,
      nextAction: {
        description: 'Select a Harness for prediction.v1 Tasks.',
        cli: `jinn solver-nets set-harness ${name} prediction-v1-baseline`,
      },
    });
  } else if (selectedHarnessDisabled) {
    diagnostics.push({
      code: 'prediction_harness_disabled',
      severity: 'error',
      message: `Selected Harness '${net.harness}' is disabled in operator config.`,
      configField: `harnesses.disabled`,
      nextAction: {
        description: 'Remove the selected Harness from the disabled list or select a different Harness.',
        cli: `jinn harnesses list`,
      },
    });
  } else if (!selectedHarness && !selectedExternalUnavailable) {
    diagnostics.push({
      code: 'prediction_harness_unknown',
      severity: 'error',
      message: selectedExternalEntry
        ? `Selected external Harness '${net.harness}' is configured but not available.`
        : `Selected Harness '${net.harness}' is not installed.`,
      configField: `solverNets.${name}.harness`,
      nextAction: {
        description: 'Select an installed Harness.',
        cli: `jinn harnesses list`,
      },
    });
  } else if (selectedHarness && !harnessStatus?.supportsPredictionV1Restoration) {
    diagnostics.push({
      code: 'prediction_harness_unsupported',
      severity: 'error',
      message: `Selected Harness '${selectedHarness.name}' does not support prediction.v1 restoration Tasks.`,
      configField: `solverNets.${name}.harness`,
      nextAction: {
        description: 'Select a Harness that supports prediction.v1.',
        cli: `jinn solver-nets set-harness ${name} prediction-v1-baseline`,
      },
    });
  } else if (selectedHarness && harnessStatus && !harnessStatus.readiness.ready) {
    diagnostics.push({
      code: 'prediction_harness_not_ready',
      severity: 'warning',
      message: harnessStatus.readiness.reason ?? `Selected Harness '${selectedHarness.name}' is not ready.`,
      configField: `solverNets.${name}.harness`,
      nextAction: harnessStatus.readiness.nextStep ?? {
        description: 'Start the daemon with a configured operator fleet.',
        cli: 'jinn run',
      },
    });
  }

  if (!net.taskGenerator.enabled) {
    diagnostics.push({
      code: 'prediction_task_generator_disabled',
      severity: 'warning',
      message: 'Prediction Task generator is disabled; this node can still solve shared Tasks but will not post new rounds.',
      configField: `solverNets.${name}.taskGenerator.enabled`,
      nextAction: {
        description: 'Enable the Prediction Task generator if this operator should post shared Tasks.',
      },
    });
  }

  const extraPluginSources = net.plugins.map(sourceOf);
  const status: PredictionOperatorStatus = {
    kind: 'prediction.v1.operatorStatus',
    ok: diagnostics.every((diagnostic) => diagnostic.severity !== 'error'),
    configPath,
    solverNet: {
      name,
      enabled: net.enabled,
      solverType: net.solverType,
      harness: net.harness,
      taskGeneratorEnabled: net.taskGenerator.enabled,
    },
    canonicalPlugin: pluginStatus(
      'canonical',
      sourceOf(net.canonicalPlugin),
      loadedNet?.canonicalPlugin,
    ),
    extraPlugins: loadedNet
      ? loadedNet.plugins.map((plugin, index) => pluginStatus('extra', extraPluginSources[index] ?? null, plugin))
      : extraPluginSources.map((source) => pluginStatus('extra', source)),
    ...(harnessStatus ? { harness: harnessStatus } : {}),
    diagnostics,
    nextAction: diagnosticNextAction(diagnostics),
  };

  if (pluginLoadError && !status.canonicalPlugin?.source) {
    status.canonicalPlugin = pluginStatus('canonical', sourceOf(net.canonicalPlugin));
  }

  return status;
}

async function buildHarnessStatus(harness: Harness): Promise<NonNullable<PredictionOperatorStatus['harness']>> {
  const supportsPredictionV1Restoration = harness.supports({
    solverType: 'prediction.v1',
    role: 'restoration',
  });
  const readiness = harness.isReady
    ? await harness.isReady({ solverType: 'prediction.v1', role: 'restoration' })
    : { ready: true };
  return {
    name: harness.name,
    version: harness.version,
    supportsPredictionV1Restoration,
    readiness,
  };
}

export function buildSamplePredictionV1Task(
  options: { now?: number; closedWindow?: boolean } = {},
): PredictionV1Task {
  const now = options.now ?? Date.now();
  const sampledAt = new Date(now).toISOString();
  const endTs = options.closedWindow ? now - 1_000 : now + 60 * 60 * 1000;
  const task: PredictionV1Task = {
    id: 'prediction-v1-local-sample',
    description: 'Local no-funds Prediction SolverNet sample.',
    solverType: 'prediction.v1',
    role: 'restoration',
    window: {
      startTs: now - 60_000,
      endTs,
    },
    claimPolicy: {
      mode: 'parallel',
      maxClaims: 25,
      maxClaimsPerOperator: 1,
      claimLeaseTtlSeconds: 30 * 60,
    },
    spec: {
      question: {
        kind: 'binary',
        text: 'Will this local Prediction SolverNet sample complete successfully?',
        yesLabel: 'YES',
        noLabel: 'NO',
      },
      source: {
        type: 'prediction-market',
        venue: 'polymarket',
        url: 'https://polymarket.com/event/jinn-local-sample',
        identifiers: {
          marketId: 'jinn-local-sample',
          conditionId: '0xlocal-sample',
          yesTokenId: 'yes-local-sample',
          noTokenId: 'no-local-sample',
        },
      },
      resolution: {
        expectedResolutionTime: new Date(now + 24 * 60 * 60 * 1000).toISOString(),
        rulesText: 'Local sample only; no live market resolution is used.',
        rulesUrl: 'https://polymarket.com/event/jinn-local-sample',
        timezone: 'UTC',
      },
      consensusSnapshot: {
        sampledAt,
        probabilityYes: '0.6200',
        method: 'best-bid-ask-midpoint',
        bestBidYes: '0.6000',
        bestAskYes: '0.6400',
        spread: '0.0400',
        source: 'polymarket-clob',
      },
      eligibilitySnapshot: {
        sampledAt,
        timeToResolutionHours: 24,
        liquidityUsd: '10000',
        volume24hUsd: '2500',
        orderbookAgeSeconds: 0,
        selectionReason: 'local-no-funds-sample',
      },
    },
    eligibility: {
      dedupKey: 'polymarket:jinn-local-sample',
    },
  };
  return PredictionV1TaskSchema.parse(task);
}

export async function runPredictionSample({
  now,
  closedWindow = false,
  workingRoot,
  harness = new PredictionV1BaselineImpl(),
}: RunPredictionSampleOptions = {}): Promise<PredictionSampleRun> {
  const task = buildSamplePredictionV1Task({ now, closedWindow });
  const diagnostics: PredictionOperatorDiagnostic[] = [];
  const canAttempt = await harness.canAttempt?.(task);
  if (canAttempt && !canAttempt.ok) {
    diagnostics.push({
      code: 'prediction_sample_cannot_attempt',
      severity: 'error',
      message: canAttempt.reason,
      nextAction: {
        description: 'Regenerate the sample with an active task window.',
      },
    });
    return {
      kind: 'prediction.v1.sampleRun',
      ok: false,
      task: sampleTaskSummary(task),
      harness: { name: harness.name, version: harness.version },
      diagnostics,
    };
  }

  const root = workingRoot ?? mkdtempSync(join(tmpdir(), 'jinn-prediction-sample-'));
  const workingDir = join(root, 'work');
  const implStateDir = join(root, 'state');
  mkdirSync(workingDir, { recursive: true, mode: 0o700 });
  mkdirSync(implStateDir, { recursive: true, mode: 0o700 });

  const solution = await harness.run({
    task,
    solverNet: { name: 'prediction', solverType: 'prediction.v1' },
    runtimePlugins: [],
    solverPluginRoots: [],
    taskCid: 'local-sample-task-cid',
    implStateDir,
    workingDir,
    log: () => {},
    abort: new AbortController().signal,
    msUntilEndTs: () => Math.max(0, task.window.endTs - Date.now()),
    trajectory: new TrajectoryCollector({ taskCid: 'local-sample-task-cid', runId: 'local-sample' }),
  });
  const payload = solution.solutionPayload ?? {};
  const parsedPayload = PredictionV1RestorationPayloadSchema.safeParse(payload);
  if (!parsedPayload.success) {
    diagnostics.push({
      code: 'prediction_sample_solution_invalid',
      severity: 'error',
      message: `Sample Harness produced an invalid prediction.v1 Solution: ${parsedPayload.error.message}`,
      nextAction: {
        description: 'Inspect the baseline Harness output before running live Tasks.',
      },
    });
  }

  return {
    kind: 'prediction.v1.sampleRun',
    ok: diagnostics.every((diagnostic) => diagnostic.severity !== 'error'),
    task: sampleTaskSummary(task),
    harness: { name: harness.name, version: harness.version },
    solution: {
      probabilityYes: payload['probabilityYes'],
      submittedAt: payload['submittedAt'],
      modelId: payload['modelId'],
      payload,
      artifactPath: join(workingDir, 'prediction-v1-solution.json'),
      workingDir,
    },
    diagnostics,
  };
}

function sampleTaskSummary(task: PredictionV1Task): PredictionSampleRun['task'] {
  return {
    id: task.id,
    question: task.spec.question.text,
    window: task.window,
  };
}
