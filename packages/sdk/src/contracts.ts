import { z } from 'zod/v3';
import type { OutputArtifact, RationaleEntry, Solution } from './types.js';
import { PredictionV1TaskSchema, type PredictionV1Task } from './prediction-v1.js';
import {
  PredictionV1RestorationPayloadSchema,
  PredictionV1VerdictPayloadSchema,
  type PredictionV1RestorationPayload,
  type PredictionV1VerdictPayload,
} from './payloads/prediction-v1.js';
import { SweRebenchV2TaskSchema } from './swe-rebench-v2.js';
import {
  SweRebenchV2SolutionPayloadSchema,
  SweRebenchV2VerdictPayloadSchema,
} from './payloads/swe-rebench-v2.js';
import {
  JinnRepoTaskSchema,
  type JinnRepoTask,
} from './jinn-repo.js';
import {
  JinnRepoSolutionPayloadSchema,
  JinnRepoVerdictPayloadSchema,
  type JinnRepoSolutionPayload,
  type JinnRepoVerdictPayload,
} from './payloads/jinn-repo.js';
import {
  SessionDerivedSolutionSchema,
  SessionDerivedTaskSchema,
  SessionDerivedVerdictSchema,
} from './payloads/session-derived.js';
import { type JsonSchema, zodToJsonSchema } from './json-schema.js';

export type SolverNetContractRole = 'creator' | 'solver' | 'evaluator';
export type PayloadKind = 'task' | 'solution' | 'verdict';
export type SupportedSolverType =
  | 'prediction.v1'
  | 'swe-rebench-v2.v1'
  | 'jinn-repo.v1'
  | 'session-derived.v1';

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
  mode: 'parallel' | 'serial';
  maxClaims: number;
  maxClaimsPerOperator: number;
  claimLeaseTtlSeconds: number;
}

/**
 * A schema entry on a SolverNet contract. Carries both the canonical wire
 * format (JSON Schema, embedded into manifests) and a Zod validator
 * (daemon-side ergonomic check). See `spec/2026-05-05-solvernet-creation-and-launch.md` §8.
 *
 * The two forms are kept in sync at definition time via `zodToJsonSchema`.
 */
export interface SolverNetContractSchema {
  zod: z.ZodTypeAny;
  json: JsonSchema;
}

export interface SolverNetContract {
  /** Stable contract identity (e.g. `'prediction'`). */
  id: string;
  /** Contract version label (e.g. `'v1'`). */
  version: string;
  name: string;
  schemas: {
    task: SolverNetContractSchema;
    solution: SolverNetContractSchema;
    verdict: SolverNetContractSchema;
  };
  claimPolicyDefaults: SolverNetClaimPolicyDefaults;
  credentialRequirements: Record<SolverNetContractRole, CredentialRequirement[]>;
  evaluationFunction: SolverNetEvaluationFunction;
  aggregationFunction: SolverNetAggregationFunction;
}

export type SolverNetContractMap = Record<SupportedSolverType, SolverNetContract>;

export const PREDICTION_V1_SOLVER_NET_CONTRACT: SolverNetContract = {
  id: 'prediction',
  version: 'v1',
  name: 'Prediction',
  schemas: {
    task: {
      zod: PredictionV1TaskSchema,
      json: zodToJsonSchema(PredictionV1TaskSchema),
    },
    solution: {
      zod: PredictionV1RestorationPayloadSchema,
      json: zodToJsonSchema(PredictionV1RestorationPayloadSchema),
    },
    verdict: {
      zod: PredictionV1VerdictPayloadSchema,
      json: zodToJsonSchema(PredictionV1VerdictPayloadSchema),
    },
  },
  claimPolicyDefaults: {
    mode: 'parallel',
    maxClaims: 25,
    maxClaimsPerOperator: 1,
    claimLeaseTtlSeconds: 30 * 60,
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
    implementation: 'operator/src/harnesses/impls/prediction-v1-evaluator',
  },
  aggregationFunction: {
    id: 'prediction.trailing-mean-brier-spread.v1',
    deterministic: true,
    inputs: ['SCORED prediction.v1 Verdicts'],
    output: 'trailing mean brierSpread',
    windowDays: 84,
  },
};

export const SWE_REBENCH_V2_V1_SOLVER_NET_CONTRACT: SolverNetContract = {
  id: 'swe-rebench-v2',
  version: 'v1',
  name: 'SWE-rebench v2',
  schemas: {
    task: {
      zod: SweRebenchV2TaskSchema,
      json: zodToJsonSchema(SweRebenchV2TaskSchema),
    },
    solution: {
      zod: SweRebenchV2SolutionPayloadSchema,
      json: zodToJsonSchema(SweRebenchV2SolutionPayloadSchema),
    },
    verdict: {
      zod: SweRebenchV2VerdictPayloadSchema,
      json: zodToJsonSchema(SweRebenchV2VerdictPayloadSchema),
    },
  },
  claimPolicyDefaults: {
    mode: 'parallel',
    maxClaims: 5,
    maxClaimsPerOperator: 5,
    claimLeaseTtlSeconds: 60 * 60, // 1 hour per Task — coding tasks need more time than predictions
  },
  credentialRequirements: {
    creator: [
      {
        id: 'huggingface.dataset.read',
        kind: 'public-api',
        required: true,
        description: 'Read public HuggingFace dataset rows for Task creation (datasets-server.huggingface.co).',
      },
    ],
    solver: [],
    evaluator: [
      {
        id: 'docker.hub.swerebenchv2.read',
        kind: 'public-api',
        required: true,
        description: 'Pull SWE-rebench v2 per-instance Docker images from docker.io/swerebenchv2.',
      },
    ],
  },
  evaluationFunction: {
    id: 'swe-rebench-v2.docker-test-suite.v1',
    deterministic: true,
    inputs: ['SWE-rebench v2 Task', 'SWE-rebench v2 Solution', 'per-instance Docker image'],
    output: 'SWE-rebench v2 Verdict',
    implementation: 'operator/src/harnesses/impls/swe-rebench-v2-evaluator',
  },
  aggregationFunction: {
    id: 'swe-rebench-v2.multi-winrate.v1',
    deterministic: true,
    inputs: ['SCORED swe-rebench-v2.v1 Verdicts'],
    output: 'structured network-result (mean/complexity-weighted/byLanguage/frontier/parityTrip)',
    windowDays: 30,
  },
};

export const JINN_REPO_V1_SOLVER_NET_CONTRACT: SolverNetContract = {
  id: 'jinn-repo',
  version: 'v1',
  name: 'Jinn repo',
  schemas: {
    task: {
      zod: JinnRepoTaskSchema,
      json: zodToJsonSchema(JinnRepoTaskSchema),
    },
    solution: {
      zod: JinnRepoSolutionPayloadSchema,
      json: zodToJsonSchema(JinnRepoSolutionPayloadSchema),
    },
    verdict: {
      zod: JinnRepoVerdictPayloadSchema,
      json: zodToJsonSchema(JinnRepoVerdictPayloadSchema),
    },
  },
  claimPolicyDefaults: {
    mode: 'parallel',
    maxClaims: 5,
    maxClaimsPerOperator: 5,
    claimLeaseTtlSeconds: 60 * 60, // 1 hour per Task — coding tasks need more time than predictions
  },
  credentialRequirements: {
    creator: [],
    // Solver needs only public git/GitHub read; represented as no declared credential.
    solver: [],
    // Repo-native runner (no Docker) — unlike swe-rebench-v2, no Docker credential.
    evaluator: [],
  },
  evaluationFunction: {
    id: 'jinn-repo.repo-native-test.v1',
    deterministic: true,
    inputs: ['Jinn repo Task', 'Jinn repo Solution', 'gold tests from corpus'],
    output: 'Jinn repo Verdict',
    implementation: 'operator/src/harnesses/impls/jinn-repo-evaluator',
  },
  aggregationFunction: {
    id: 'jinn-repo.multi-winrate.v1',
    deterministic: true,
    inputs: ['SCORED jinn-repo.v1 Verdicts'],
    output: 'structured network-result',
    windowDays: 30,
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// SESSION_DERIVED_V1_SOLVER_NET_CONTRACT — Phase 0 / Task 0.4 scaffold.
//
// Contract identity + claim-policy + credential requirements + evaluator and
// aggregation refs are landed here so downstream phases (task-generator,
// composite evaluator, runtime plugin) can reference the contract without
// circular blocking. Payload schemas (Task / Solution / Verdict) are
// placeholders; they get filled in Phase 10 of the plan once the LLM-distilled
// payload shapes are nailed down.
//
// Spec: spec/2026-05-07-telemetry-collector-and-task-generator.md §5.1, §5.2.
// ─────────────────────────────────────────────────────────────────────────────

export const SESSION_DERIVED_V1_SOLVER_NET_CONTRACT: SolverNetContract = {
  id: 'session-derived',
  version: 'v1',
  name: 'Session-derived',
  schemas: {
    task: {
      zod: SessionDerivedTaskSchema,
      json: zodToJsonSchema(SessionDerivedTaskSchema),
    },
    solution: {
      zod: SessionDerivedSolutionSchema,
      json: zodToJsonSchema(SessionDerivedSolutionSchema),
    },
    verdict: {
      zod: SessionDerivedVerdictSchema,
      json: zodToJsonSchema(SessionDerivedVerdictSchema),
    },
  },
  claimPolicyDefaults: {
    mode: 'parallel',
    maxClaims: 50,
    maxClaimsPerOperator: 5,
    claimLeaseTtlSeconds: 4 * 60 * 60, // 4h per Task — sessions can be larger than swe-rebench-v2's 1h tasks
  },
  credentialRequirements: {
    creator: [],
    solver: [],
    evaluator: [
      {
        // Spec §5.2: evaluators require a $50 USDC bond to participate.
        // The bond mechanism itself is a separate workstream; this entry
        // declares the requirement so manifest-side registration can flag
        // operators who have not yet posted bond.
        id: 'session-derived.evaluator.bond',
        kind: 'operator-credential',
        required: true,
        description:
          'Evaluators must post a $50 USDC bond (slashable on detected dishonesty) to participate in session-derived evaluation.',
      },
    ],
  },
  evaluationFunction: {
    id: '@jinn-network/session-derived-evaluator',
    deterministic: false, // composite uses LLM-judge component → non-deterministic
    inputs: ['session-derived Task', 'session-derived Solution', 'sourceCapture envelope'],
    output: 'session-derived Verdict (composite_score + signal_breakdown)',
    implementation: 'operator/src/harnesses/impls/session-derived-evaluator', // Phase 10 surface
  },
  aggregationFunction: {
    id: 'session-derived-rolling-mean',
    deterministic: false,
    inputs: ['SCORED session-derived Verdicts'],
    output: 'session-derived-network-result (mean composite + signal-coverage breakdown)',
    windowDays: 30,
  },
};

export const SOLVER_NET_CONTRACTS: SolverNetContractMap = {
  'prediction.v1': PREDICTION_V1_SOLVER_NET_CONTRACT,
  'swe-rebench-v2.v1': SWE_REBENCH_V2_V1_SOLVER_NET_CONTRACT,
  'jinn-repo.v1': JINN_REPO_V1_SOLVER_NET_CONTRACT,
  'session-derived.v1': SESSION_DERIVED_V1_SOLVER_NET_CONTRACT,
};

/**
 * Look up a SolverNet contract template by stable identity ({id, version}).
 *
 * The legacy string-keyed signature (`getSolverNetContract('prediction.v1')`)
 * was removed in Task 30 of `spec/2026-05-05-solvernet-creation-and-launch.md`
 * alongside `SolverNetContract.solverType`.
 */
export function getSolverNetContract(
  ref: { id: string; version: string },
): SolverNetContract | undefined {
  const key = `${ref.id}.${ref.version}`;
  return SOLVER_NET_CONTRACTS[key as SupportedSolverType];
}

/**
 * Internal helper: derives the legacy `solverType` string (`${id}.${version}`)
 * from a contract id and version.
 *
 * @internal Used only by daemon-internal harness dispatch's compatibility
 * layer (spec §15 non-goal: the internal `solverType` alias in harness
 * dispatch is intentionally retained for one cycle past Task 30). NOT
 * re-exported from the `@jinn-network/sdk/solvernets` barrel and not part
 * of the SDK's public surface.
 */
export function solverTypeAlias(ref: { id: string; version: string }): string {
  return `${ref.id}.${ref.version}`;
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

function parseSolverTypeString(solverType: string): { id: string; version: string } | undefined {
  const dot = solverType.lastIndexOf('.');
  if (dot <= 0 || dot === solverType.length - 1) return undefined;
  return { id: solverType.slice(0, dot), version: solverType.slice(dot + 1) };
}

function getSchema(solverType: string, kind: PayloadKind): z.ZodTypeAny | undefined {
  const ref = parseSolverTypeString(solverType);
  if (!ref) return undefined;
  return getSolverNetContract(ref)?.schemas[kind].zod;
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
export function validateTask(solverType: 'jinn-repo.v1', task: unknown): PayloadValidationResult<JinnRepoTask>;
export function validateTask(solverType: string, task: unknown): PayloadValidationResult<unknown>;
export function validateTask(solverType: string, task: unknown): PayloadValidationResult<unknown> {
  return validateWithSchema(solverType, 'task', task);
}

export function assertTask(solverType: 'prediction.v1', task: unknown): PredictionV1Task;
export function assertTask(solverType: 'jinn-repo.v1', task: unknown): JinnRepoTask;
export function assertTask(solverType: string, task: unknown): unknown;
export function assertTask(solverType: string, task: unknown): unknown {
  return assertValid(validateTask(solverType, task));
}

export function validateSolutionPayload(
  solverType: 'prediction.v1',
  payload: unknown,
): PayloadValidationResult<PredictionV1RestorationPayload>;
export function validateSolutionPayload(
  solverType: 'jinn-repo.v1',
  payload: unknown,
): PayloadValidationResult<JinnRepoSolutionPayload>;
export function validateSolutionPayload(solverType: string, payload: unknown): PayloadValidationResult<Record<string, unknown>>;
export function validateSolutionPayload(solverType: string, payload: unknown): PayloadValidationResult<unknown> {
  return validateWithSchema(solverType, 'solution', payload);
}

export function assertSolutionPayload(
  solverType: 'prediction.v1',
  payload: unknown,
): PredictionV1RestorationPayload;
export function assertSolutionPayload(
  solverType: 'jinn-repo.v1',
  payload: unknown,
): JinnRepoSolutionPayload;
export function assertSolutionPayload(solverType: string, payload: unknown): Record<string, unknown>;
export function assertSolutionPayload(solverType: string, payload: unknown): unknown {
  return assertValid(validateSolutionPayload(solverType, payload));
}

export function validateVerdictPayload(
  solverType: 'prediction.v1',
  payload: unknown,
): PayloadValidationResult<PredictionV1VerdictPayload>;
export function validateVerdictPayload(
  solverType: 'jinn-repo.v1',
  payload: unknown,
): PayloadValidationResult<JinnRepoVerdictPayload>;
export function validateVerdictPayload(solverType: string, payload: unknown): PayloadValidationResult<Record<string, unknown>>;
export function validateVerdictPayload(solverType: string, payload: unknown): PayloadValidationResult<unknown> {
  return validateWithSchema(solverType, 'verdict', payload);
}

export function assertVerdictPayload(
  solverType: 'prediction.v1',
  payload: unknown,
): PredictionV1VerdictPayload;
export function assertVerdictPayload(
  solverType: 'jinn-repo.v1',
  payload: unknown,
): JinnRepoVerdictPayload;
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
