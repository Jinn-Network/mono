export {
  PREDICTION_V1_SOLVER_NET_CONTRACT,
  SOLVER_NET_CONTRACTS,
  PayloadValidationException,
  getSolverNetContract,
  validateTask,
  assertTask,
  validateSolutionPayload,
  assertSolutionPayload,
  validateVerdictPayload,
  assertVerdictPayload,
  buildSolutionOutput,
  buildVerdictOutput,
} from '../contracts.js';

export type {
  SolverNetContractRole,
  PayloadKind,
  SupportedSolverType,
  CredentialRequirement,
  SolverNetEvaluationFunction,
  SolverNetAggregationFunction,
  SolverNetClaimPolicyDefaults,
  SolverNetContract,
  SolverNetContractMap,
  SolverNetContractSchema,
  PayloadValidationIssue,
  PayloadValidationFailure,
  PayloadValidationSuccess,
  PayloadValidationResult,
  BuildSolutionOutputArgs,
  BuildVerdictOutputArgs,
} from '../contracts.js';

// SolverNetManifestV1 — the launched-instance authority document.
// See `spec/2026-05-05-solvernet-creation-and-launch.md` §7.
export {
  SolverNetManifestV1Schema,
  validateSolverNetManifest,
} from './manifest-schema.js';

export type {
  SolverNetManifestV1,
  SolverNetCredentialRequirement,
  ManifestValidationIssue,
  ManifestValidationResult,
} from './manifest-schema.js';

// JSON Schema serialization helpers — the canonical wire format for manifest
// task/solution/verdict schemas, with a Zod recovery helper for daemon-side
// validation.
export {
  zodToJsonSchema,
  jsonSchemaToZod,
} from '../json-schema.js';

export type { JsonSchema } from '../json-schema.js';
