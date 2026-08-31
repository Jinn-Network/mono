// operator/src/harnesses/impls/hermes-agent/resolved-model-guard.ts
//
// Spend-safety check for the current T3.1 real-network path: after the solver
// writes task-local Hermes config.yaml, compare the resolved model/provider
// against the scenario's declared pair (plus an optional approved override)
// before additional solve spend. Normal operator model selection is unchanged
// unless T3.1 expected-model env is set.
import { existsSync, readFileSync } from 'node:fs';
import { parse as yamlParse } from 'yaml';

export const T31_EXPECTED_HERMES_MODEL_ENV = 'JINN_T31_EXPECTED_HERMES_MODEL';
export const T31_EXPECTED_HERMES_PROVIDER_ENV = 'JINN_T31_EXPECTED_HERMES_PROVIDER';
export const T31_APPROVED_HERMES_MODEL_ENV = 'JINN_T31_APPROVED_HERMES_MODEL';
export const T31_APPROVED_HERMES_PROVIDER_ENV = 'JINN_T31_APPROVED_HERMES_PROVIDER';

export interface HermesModelProviderPair {
  model: string;
  provider?: string;
}

export interface ResolvedHermesModel {
  model?: string;
  provider?: string;
}

export interface ResolvedHermesModelGuardEvidence {
  requestedModel: string;
  requestedProvider: string | undefined;
  resolvedModel: string | undefined;
  resolvedProvider: string | undefined;
  configPath: string;
  overrideApproved: boolean;
}

export interface T31ResolvedModelGuardPolicy {
  requested: HermesModelProviderPair;
  approvedOverride?: HermesModelProviderPair;
}

function isObj(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalize(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function same(left: string | undefined, right: string | undefined): boolean {
  return normalize(left) === normalize(right);
}

function display(value: string | undefined): string {
  return value ?? '(unset)';
}

export class ResolvedHermesModelMismatchError extends Error {
  readonly requestedModel: string;
  readonly requestedProvider: string | undefined;
  readonly resolvedModel: string | undefined;
  readonly resolvedProvider: string | undefined;
  readonly configPath: string;

  constructor(args: {
    requestedModel: string;
    requestedProvider: string | undefined;
    resolvedModel: string | undefined;
    resolvedProvider: string | undefined;
    configPath: string;
  }) {
    super(
      `T3.1 Hermes model/provider mismatch before solve spend: ` +
        `requested model=${args.requestedModel} provider=${display(args.requestedProvider)}, ` +
        `resolved model=${display(args.resolvedModel)} provider=${display(args.resolvedProvider)}, ` +
        `config=${args.configPath}`,
    );
    this.name = 'ResolvedHermesModelMismatchError';
    this.requestedModel = args.requestedModel;
    this.requestedProvider = args.requestedProvider;
    this.resolvedModel = args.resolvedModel;
    this.resolvedProvider = args.resolvedProvider;
    this.configPath = args.configPath;
  }
}

export function assertResolvedHermesModel(input: {
  configPath: string;
  requested: HermesModelProviderPair;
  resolved: ResolvedHermesModel;
  approvedOverride?: HermesModelProviderPair;
}): ResolvedHermesModelGuardEvidence {
  const requestedModel = normalize(input.requested.model);
  if (!requestedModel) {
    throw new Error('T3.1 Hermes model guard requires a requested model');
  }
  const requestedProvider = normalize(input.requested.provider);
  const resolvedModel = normalize(input.resolved.model);
  const resolvedProvider = normalize(input.resolved.provider);
  const overrideModel = normalize(input.approvedOverride?.model);
  const overrideProvider = normalize(input.approvedOverride?.provider);

  const matchesRequested =
    resolvedModel === requestedModel && same(resolvedProvider, requestedProvider);
  const matchesOverride =
    overrideModel !== undefined &&
    resolvedModel === overrideModel &&
    same(resolvedProvider, overrideProvider ?? requestedProvider);

  if (matchesRequested || matchesOverride) {
    return {
      requestedModel,
      requestedProvider,
      resolvedModel,
      resolvedProvider,
      configPath: input.configPath,
      overrideApproved: Boolean(matchesOverride && !matchesRequested),
    };
  }

  throw new ResolvedHermesModelMismatchError({
    requestedModel,
    requestedProvider,
    resolvedModel,
    resolvedProvider,
    configPath: input.configPath,
  });
}

export function readResolvedHermesModelFromConfig(configPath: string): ResolvedHermesModel {
  if (!existsSync(configPath)) {
    throw new Error(`T3.1 Hermes model guard: config not found at ${configPath}`);
  }
  let parsed: unknown;
  try {
    parsed = yamlParse(readFileSync(configPath, 'utf8'));
  } catch {
    throw new Error(`T3.1 Hermes model guard: unparseable config at ${configPath}`);
  }
  if (!isObj(parsed)) {
    throw new Error(`T3.1 Hermes model guard: unparseable config at ${configPath}`);
  }
  const modelBlock = isObj(parsed['model']) ? parsed['model'] : {};
  return {
    model: typeof modelBlock['default'] === 'string' ? modelBlock['default'] : undefined,
    provider: typeof modelBlock['provider'] === 'string' ? modelBlock['provider'] : undefined,
  };
}

export function assertResolvedHermesModelFromConfig(input: {
  configPath: string;
  requested: HermesModelProviderPair;
  approvedOverride?: HermesModelProviderPair;
}): ResolvedHermesModelGuardEvidence {
  return assertResolvedHermesModel({
    configPath: input.configPath,
    requested: input.requested,
    resolved: readResolvedHermesModelFromConfig(input.configPath),
    approvedOverride: input.approvedOverride,
  });
}

export function parseT31ResolvedModelGuardPolicy(
  env: NodeJS.ProcessEnv = process.env,
): T31ResolvedModelGuardPolicy | undefined {
  const model = env[T31_EXPECTED_HERMES_MODEL_ENV]?.trim();
  if (!model) return undefined;
  const provider = env[T31_EXPECTED_HERMES_PROVIDER_ENV]?.trim() || undefined;
  const overrideModel = env[T31_APPROVED_HERMES_MODEL_ENV]?.trim() || undefined;
  const overrideProvider = env[T31_APPROVED_HERMES_PROVIDER_ENV]?.trim() || undefined;
  return {
    requested: { model, ...(provider ? { provider } : {}) },
    ...(overrideModel
      ? {
          approvedOverride: {
            model: overrideModel,
            ...(overrideProvider ? { provider: overrideProvider } : {}),
          },
        }
      : {}),
  };
}

export function formatResolvedHermesModelGuardEvidence(
  evidence: ResolvedHermesModelGuardEvidence,
): string {
  const override = evidence.overrideApproved
    ? ` (approved override of requested model=${evidence.requestedModel} provider=${display(evidence.requestedProvider)})`
    : '';
  return (
    `resolved model=${display(evidence.resolvedModel)} ` +
    `provider=${display(evidence.resolvedProvider)} ` +
    `config=${evidence.configPath}` +
    override
  );
}
