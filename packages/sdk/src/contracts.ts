import type { z } from 'zod';
import type { OutputArtifact, RationaleEntry, Solution } from './types.js';
import { PredictionV1TaskSchema, type PredictionV1Task } from './prediction-v1.js';
import {
  PredictionV1RestorationPayloadSchema,
  PredictionV1VerdictPayloadSchema,
  type PredictionV1RestorationPayload,
  type PredictionV1VerdictPayload,
} from './payloads/prediction-v1.js';

export type SolverNetContractRole = 'creator' | 'solver' | 'evaluator';
export type PayloadKind = 'task' | 'solution' | 'verdict';
export type SupportedSolverType = 'prediction.v1';

export interface CredentialRequirement {
  id: string;
  kind: 'public-api' | 'client-owned' | 'operator-credential';
  required: boolean;
  description: string;
}

export interface SolverNetEvaluationFunction {
  id: string;
  deterministic: boolean;
  inputs: readonly string[];
  output: string;
  implementation: string;
}

export interface SolverNetAggregationFunction {
  id: string;
  deterministic: boolean;
  inputs: readonly string[];
  output: string;
  windowDays?: number;
}

export interface SolverNetClaimPolicyDefaults {
  kind: string;
  maxClaims: number;
  maxClaimsPerSolver: number;
  claimWindow: string;
  selection: string;
  economics: string;
}

export interface SolverNetContract {
  name: string;
  solverType: SupportedSolverType;
  schemas: {
    task: z.ZodTypeAny;
    solution: z.ZodTypeAny;
    verdict: z.ZodTypeAny;
  };
  claimPolicyDefaults: SolverNetClaimPolicyDefaults;
  credentialRequirements: Record<SolverNetContractRole, CredentialRequirement[]>;
  evaluationFunction: SolverNetEvaluationFunction;
  aggregationFunction: SolverNetAggregationFunction;
  referencePlugins: string[];
}

export type SolverNetContractMap = Record<SupportedSolverType, SolverNetContract>;

export const PREDICTION_V1_SOLVER_NET_CONTRACT: SolverNetContract = {
  name: 'Prediction',
  solverType: 'prediction.v1',
  schemas: {
    task: PredictionV1TaskSchema,
    solution: PredictionV1RestorationPayloadSchema,
    verdict: PredictionV1VerdictPayloadSchema,
  },
  claimPolicyDefaults: {
    kind: 'parallel',
    maxClaims: 25,
    maxClaimsPerSolver: 1,
    claimWindow: 'task-window',
    selection: 'all-valid-solutions-scored',
    economics: 'testnet-flat',
  },
  credentialRequirements: {
    creator: [
      {
        id: 'polymarket.public.market-data.read',
        kind: 'public-api',
        required: true,
        description: 'Read public Polymarket market metadata and orderbook snapshots for Task creation.',
      },
    ],
    solver: [],
    evaluator: [
      {
        id: 'polymarket.public.resolution.read',
        kind: 'public-api',
        required: true,
        description: 'Read public Polymarket/UMA final market state for resolution mapping.',
      },
    ],
  },
  evaluationFunction: {
    id: 'prediction.brier-loss.v1',
    deterministic: true,
    inputs: ['prediction.v1 Task', 'prediction.v1 Solution', 'Polymarket/UMA resolution'],
    output: 'prediction.v1 Verdict',
    implementation: 'client/src/harnesses/impls/prediction-v1-evaluator',
  },
  aggregationFunction: {
    id: 'prediction.trailing-mean-brier-spread.v1',
    deterministic: true,
    inputs: ['SCORED prediction.v1 Verdicts'],
    output: 'trailing mean brierSpread',
    windowDays: 84,
  },
  referencePlugins: ['bundled:jinn-prediction-plugin'],
};

export const SOLVER_NET_CONTRACTS: SolverNetContractMap = {
  'prediction.v1': PREDICTION_V1_SOLVER_NET_CONTRACT,
};

export function getSolverNetContract(solverType: string): SolverNetContract | undefined {
  return SOLVER_NET_CONTRACTS[solverType as SupportedSolverType];
}

export interface PayloadValidationIssue {
  path: string;
  message: string;
}

export interface PayloadValidationFailure {
  ok: false;
  error: {
    code: 'unsupported_solver_type' | 'invalid_payload';
    message: string;
    issues: PayloadValidationIssue[];
  };
}

export interface PayloadValidationSuccess<T> {
  ok: true;
  value: T;
}

export type PayloadValidationResult<T> = PayloadValidationSuccess<T> | PayloadValidationFailure;

export class PayloadValidationException extends Error {
  readonly code: 'unsupported_solver_type' | 'invalid_payload';
  readonly issues: PayloadValidationIssue[];

  constructor(code: 'unsupported_solver_type' | 'invalid_payload', message: string, issues: PayloadValidationIssue[] = []) {
    super(message);
    this.name = 'PayloadValidationException';
    this.code = code;
    this.issues = issues;
  }
}

function issuesFrom(error: z.ZodError): PayloadValidationIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.length > 0 ? issue.path.join('.') : '<root>',
    message: issue.message,
  }));
}

function getSchema(solverType: string, kind: PayloadKind): z.ZodTypeAny | undefined {
  return getSolverNetContract(solverType)?.schemas[kind];
}

function validateWithSchema<T>(solverType: string, kind: PayloadKind, value: unknown): PayloadValidationResult<T> {
  const schema = getSchema(solverType, kind);
  if (!schema) {
    return {
      ok: false,
      error: {
        code: 'unsupported_solver_type',
        message: `Unsupported SolverType for ${kind} validation: ${solverType}`,
        issues: [],
      },
    };
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const issues = issuesFrom(parsed.error);
    return {
      ok: false,
      error: {
        code: 'invalid_payload',
        message: `${solverType} ${kind} failed validation: ${issues.map((issue) => `${issue.path}: ${issue.message}`).join('; ')}`,
        issues,
      },
    };
  }
  return { ok: true, value: parsed.data as T };
}

function assertValid<T>(result: PayloadValidationResult<T>): T {
  if (result.ok) return result.value;
  throw new PayloadValidationException(result.error.code, result.error.message, result.error.issues);
}

export function validateTask(solverType: 'prediction.v1', task: unknown): PayloadValidationResult<PredictionV1Task>;
export function validateTask(solverType: string, task: unknown): PayloadValidationResult<unknown>;
export function validateTask(solverType: string, task: unknown): PayloadValidationResult<unknown> {
  return validateWithSchema(solverType, 'task', task);
}

export function assertTask(solverType: 'prediction.v1', task: unknown): PredictionV1Task;
export function assertTask(solverType: string, task: unknown): unknown;
export function assertTask(solverType: string, task: unknown): unknown {
  return assertValid(validateTask(solverType, task));
}

export function validateSolutionPayload(
  solverType: 'prediction.v1',
  payload: unknown,
): PayloadValidationResult<PredictionV1RestorationPayload>;
export function validateSolutionPayload(solverType: string, payload: unknown): PayloadValidationResult<Record<string, unknown>>;
export function validateSolutionPayload(solverType: string, payload: unknown): PayloadValidationResult<unknown> {
  return validateWithSchema(solverType, 'solution', payload);
}

export function assertSolutionPayload(
  solverType: 'prediction.v1',
  payload: unknown,
): PredictionV1RestorationPayload;
export function assertSolutionPayload(solverType: string, payload: unknown): Record<string, unknown>;
export function assertSolutionPayload(solverType: string, payload: unknown): unknown {
  return assertValid(validateSolutionPayload(solverType, payload));
}

export function validateVerdictPayload(
  solverType: 'prediction.v1',
  payload: unknown,
): PayloadValidationResult<PredictionV1VerdictPayload>;
export function validateVerdictPayload(solverType: string, payload: unknown): PayloadValidationResult<Record<string, unknown>>;
export function validateVerdictPayload(solverType: string, payload: unknown): PayloadValidationResult<unknown> {
  return validateWithSchema(solverType, 'verdict', payload);
}

export function assertVerdictPayload(
  solverType: 'prediction.v1',
  payload: unknown,
): PredictionV1VerdictPayload;
export function assertVerdictPayload(solverType: string, payload: unknown): Record<string, unknown>;
export function assertVerdictPayload(solverType: string, payload: unknown): unknown {
  return assertValid(validateVerdictPayload(solverType, payload));
}

export interface BuildSolutionOutputArgs {
  solverType: string;
  venueName: string;
  payload: Record<string, unknown>;
  gating?: Record<string, unknown>;
  informational?: Record<string, unknown>;
  artifacts?: OutputArtifact[];
  rationale?: RationaleEntry[];
}

export function buildSolutionOutput(args: BuildSolutionOutputArgs): Solution {
  const payload = assertSolutionPayload(args.solverType, args.payload) as Record<string, unknown>;
  return {
    venueRef: { name: args.venueName },
    gating: args.gating ?? {},
    ...(args.informational ? { informational: args.informational } : {}),
    solutionPayload: payload,
    ...(args.artifacts ? { artifacts: args.artifacts } : {}),
    ...(args.rationale ? { rationale: args.rationale } : {}),
  };
}

export interface BuildVerdictOutputArgs {
  solverType: string;
  venueName?: string;
  payload: Record<string, unknown>;
  gating?: Record<string, unknown>;
  informational?: Record<string, unknown>;
  artifacts?: OutputArtifact[];
  rationale?: RationaleEntry[];
}

export function buildVerdictOutput(args: BuildVerdictOutputArgs): Solution {
  const payload = assertVerdictPayload(args.solverType, args.payload) as Record<string, unknown>;
  return {
    venueRef: { name: args.venueName ?? 'jinn-evaluator' },
    gating: args.gating ?? {},
    ...(args.informational ? { informational: args.informational } : {}),
    verdictPayload: payload,
    ...(args.artifacts ? { artifacts: args.artifacts } : {}),
    ...(args.rationale ? { rationale: args.rationale } : {}),
  };
}
