import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { LauncherGeneratorStateSnapshot } from '../api/launcher-status.js';
import type { TaskGenerator } from '../tasks/sources.js';
import type { PredictionV1GeneratorRuntimeConfig } from '../solver-types/prediction-v1-auto.js';
import type {
  MakeSweRebenchV2GeneratorForLaunchedRecordOpts,
  SweRebenchV2GeneratorRuntimeConfig,
} from '../solver-types/swe-rebench-v2.js';
import type { PendingGeneratorSpawn } from './daemon-init.js';
import type { LaunchedSolverNetRecord } from './store.js';

export interface LaunchedRecordContractRef {
  id: string;
  version: string;
  solverType: string;
  source: 'manifest' | 'solverNetId';
}

export interface LaunchedRecordGeneratorStaticConfig {
  agentEoa?: `0x${string}`;
  safeAddress?: `0x${string}`;
  agentPrivateKey?: `0x${string}`;
}

export interface LaunchedRecordGeneratorFactories {
  predictionV1: (opts: {
    recordRef: { current: LaunchedSolverNetRecord };
    configRef: { current: PredictionV1GeneratorRuntimeConfig };
    staticConfig?: LaunchedRecordGeneratorStaticConfig;
  }) => TaskGenerator;
  sweRebenchV2: (opts: MakeSweRebenchV2GeneratorForLaunchedRecordOpts) => TaskGenerator;
}

export interface LaunchedRecordGeneratorLogger {
  info?: (message: string) => void;
  warn?: (message: string) => void;
}

export interface WireLaunchedRecordGeneratorsOpts {
  pendingGenerators: PendingGeneratorSpawn[];
  staticConfig: LaunchedRecordGeneratorStaticConfig;
  launchedDir?: string;
  factories?: LaunchedRecordGeneratorFactories;
  logger?: LaunchedRecordGeneratorLogger;
}

export interface WiredLaunchedRecordGenerator {
  solverType: string;
  generator: TaskGenerator;
  getLauncherState?: () => LauncherGeneratorStateSnapshot | undefined;
}

export interface WireLaunchedRecordGeneratorsResult {
  generators: WiredLaunchedRecordGenerator[];
  predictionGeneratorRef?: TaskGenerator;
  generatorStatesBySolverType: Map<string, () => LauncherGeneratorStateSnapshot | undefined>;
}

function solverTypeFor(id: string, version: string): string {
  return `${id}.${version}`;
}

export function resolveContractFromSolverNetId(
  solverNetId: string,
): LaunchedRecordContractRef | null {
  const match = /^[^_]+_(.+)_[^_]+$/u.exec(solverNetId);
  const contractAndVersion = match?.[1];
  if (!contractAndVersion) return null;
  const splitAt = contractAndVersion.lastIndexOf('-');
  if (splitAt <= 0 || splitAt === contractAndVersion.length - 1) return null;
  const id = contractAndVersion.slice(0, splitAt);
  const version = contractAndVersion.slice(splitAt + 1);
  return {
    id,
    version,
    solverType: solverTypeFor(id, version),
    source: 'solverNetId',
  };
}

function contractFromManifest(raw: unknown): LaunchedRecordContractRef | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const manifest = raw as { contract?: { id?: unknown; version?: unknown } };
  const id = manifest.contract?.id;
  const version = manifest.contract?.version;
  if (typeof id !== 'string' || typeof version !== 'string') return null;
  if (!id || !version) return null;
  return {
    id,
    version,
    solverType: solverTypeFor(id, version),
    source: 'manifest',
  };
}

async function tryReadManifestContract(path: string): Promise<LaunchedRecordContractRef | null> {
  try {
    const raw = await readFile(path, 'utf8');
    return contractFromManifest(JSON.parse(raw));
  } catch {
    return null;
  }
}

export async function resolveLaunchedRecordContract(
  record: LaunchedSolverNetRecord,
  opts: { launchedDir?: string } = {},
): Promise<LaunchedRecordContractRef | null> {
  const manifestPaths = [
    record.manifestPath,
    opts.launchedDir ? join(opts.launchedDir, `${record.solverNetId}.manifest.json`) : undefined,
  ].filter((p): p is string => typeof p === 'string' && p.length > 0);

  for (const manifestPath of manifestPaths) {
    const fromManifest = await tryReadManifestContract(manifestPath);
    if (fromManifest) return fromManifest;
  }

  return resolveContractFromSolverNetId(record.solverNetId);
}

async function defaultFactories(): Promise<LaunchedRecordGeneratorFactories> {
  const [
    { makePredictionV1GeneratorForLaunchedRecord },
    { makeSweRebenchV2GeneratorForLaunchedRecord },
  ] = await Promise.all([
    import('../solver-types/prediction-v1-auto.js'),
    import('../solver-types/swe-rebench-v2.js'),
  ]);
  return {
    predictionV1: makePredictionV1GeneratorForLaunchedRecord,
    sweRebenchV2: makeSweRebenchV2GeneratorForLaunchedRecord,
  };
}

function hasGetState(generator: TaskGenerator): boolean {
  return typeof (generator as { getState?: unknown }).getState === 'function';
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function projectLauncherGeneratorState(raw: unknown): LauncherGeneratorStateSnapshot | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const snapshot = raw as Record<string, unknown>;
  const config = typeof snapshot['config'] === 'object' && snapshot['config'] !== null
    ? snapshot['config'] as Record<string, unknown>
    : undefined;
  const kind = optionalString(snapshot['kind']);
  const cadenceMs = finiteNumber(snapshot['cadenceMs']) ?? (
    kind === 'swe-rebench-v2' ? undefined : finiteNumber(config?.['cadenceMs'])
  );
  if (cadenceMs === undefined && kind !== 'swe-rebench-v2') return undefined;

  const projected: LauncherGeneratorStateSnapshot = {};
  if (cadenceMs !== undefined) projected.cadenceMs = cadenceMs;
  const lastPollAt = optionalString(snapshot['lastPollAt']);
  if (lastPollAt) projected.lastPollAt = lastPollAt;

  const lastError = typeof snapshot['lastError'] === 'object' && snapshot['lastError'] !== null
    ? snapshot['lastError'] as Record<string, unknown>
    : undefined;
  const lastErrorMessage = optionalString(lastError?.['message']);
  const lastErrorAt = optionalString(lastError?.['at']);
  if (lastErrorMessage && lastErrorAt) {
    projected.lastError = { message: lastErrorMessage, at: lastErrorAt };
  }

  const rawSummary = typeof snapshot['lastPollSummary'] === 'object' && snapshot['lastPollSummary'] !== null
    ? snapshot['lastPollSummary'] as Record<string, unknown>
    : undefined;
  if (rawSummary) {
    const poolSize = finiteNumber(rawSummary['poolSize']);
    const unposted = finiteNumber(rawSummary['unposted']);
    const live = finiteNumber(rawSummary['live']);
    const repostable = finiteNumber(rawSummary['repostable']);
    const saturated = finiteNumber(rawSummary['saturated']);
    const abandoned = finiteNumber(rawSummary['abandoned']);
    const posted = finiteNumber(rawSummary['posted']);
    if (
      poolSize !== undefined &&
      posted !== undefined &&
      unposted !== undefined &&
      live !== undefined &&
      repostable !== undefined &&
      saturated !== undefined &&
      abandoned !== undefined
    ) {
      projected.lastPollSummary = {
        poolSize,
        posted,
        unposted,
        live,
        repostable,
        saturated,
        abandoned,
      };
    } else {
      const evaluated = finiteNumber(rawSummary['evaluated']) ?? poolSize;
      const skipped = finiteNumber(rawSummary['skipped']);
      if (evaluated !== undefined && posted !== undefined && skipped !== undefined) {
        projected.lastPollSummary = { evaluated, posted, skipped };
      }
    }
  }

  const poolPublicationUpdatedAt = optionalString(snapshot['poolPublicationUpdatedAt']);
  if (poolPublicationUpdatedAt) projected.poolPublicationUpdatedAt = poolPublicationUpdatedAt;
  const poolPublicationPriorSize = finiteNumber(snapshot['poolPublicationPriorSize']);
  if (poolPublicationPriorSize !== undefined) projected.poolPublicationPriorSize = poolPublicationPriorSize;
  const poolPublicationCurrentSize = finiteNumber(snapshot['poolPublicationCurrentSize']);
  if (poolPublicationCurrentSize !== undefined) projected.poolPublicationCurrentSize = poolPublicationCurrentSize;

  return projected;
}

function launcherStateReaderFor(
  generator: TaskGenerator,
): (() => LauncherGeneratorStateSnapshot | undefined) | undefined {
  if (!hasGetState(generator)) return undefined;
  const stateful = generator as TaskGenerator & { getState(): unknown };
  return () => projectLauncherGeneratorState(stateful.getState());
}

export async function wireLaunchedRecordGenerators(
  opts: WireLaunchedRecordGeneratorsOpts,
): Promise<WireLaunchedRecordGeneratorsResult> {
  const factories = opts.factories ?? await defaultFactories();
  const logger = opts.logger ?? {};
  const generators: WiredLaunchedRecordGenerator[] = [];
  const generatorStatesBySolverType = new Map<
    string,
    () => LauncherGeneratorStateSnapshot | undefined
  >();
  let predictionGeneratorRef: TaskGenerator | undefined;

  for (const pending of opts.pendingGenerators) {
    const contract = await resolveLaunchedRecordContract(pending.record, {
      launchedDir: opts.launchedDir,
    });
    if (!contract) {
      logger.warn?.(
        `[main] launched-record generator skipped: ${pending.record.solverNetId} ` +
          '(could not resolve contract id/version)',
      );
      continue;
    }

    let generator: TaskGenerator | undefined;
    if (contract.id === 'prediction' && contract.version === 'v1') {
      generator = factories.predictionV1({
        recordRef: pending.recordRef,
        configRef: pending.configRef as { current: PredictionV1GeneratorRuntimeConfig },
        staticConfig: opts.staticConfig,
      });
      if (!predictionGeneratorRef && hasGetState(generator)) {
        predictionGeneratorRef = generator;
      }
    } else if (contract.id === 'swe-rebench-v2' && contract.version === 'v1') {
      generator = factories.sweRebenchV2({
        recordRef: pending.recordRef,
        configRef: pending.configRef as { current: SweRebenchV2GeneratorRuntimeConfig },
        staticConfig: opts.staticConfig,
      });
    } else {
      logger.warn?.(
        `[main] launched-record generator skipped: ${pending.record.solverNetId} ` +
          `(${contract.id}.${contract.version} is not supported by this daemon)`,
      );
      continue;
    }

    const getLauncherState = launcherStateReaderFor(generator);
    if (getLauncherState) {
      generatorStatesBySolverType.set(contract.solverType, getLauncherState);
    }

    generators.push({ solverType: contract.solverType, generator, getLauncherState });
    logger.info?.(
      `[main] launched-record generator wired: ${pending.record.solverNetId} ` +
        `(${contract.id}.${contract.version}, status=${pending.record.status})`,
    );
  }

  return { generators, predictionGeneratorRef, generatorStatesBySolverType };
}
