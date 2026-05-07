// SolverNetManifestV1 — the launched-instance authority document.
//
// Mirror of the TypeScript interface in
// `spec/2026-05-05-solvernet-creation-and-launch.md` §7. The Zod validator
// here is the daemon-side ergonomic check; the canonical wire format for
// signing and cross-implementation verification is JSON Schema (Task 2 will
// derive it from this Zod schema).
//
// Notable shape rules from §7:
// - Fully embedded contract (no ref/embed split)
// - `solutionPriceWei` and `verdictPriceWei` are top-level (no `economics` wrapper)
// - `openRoles: Array<'solver' | 'evaluator'>` is top-level (no `participation` wrapper)
// - No `recommendedHarnesses`, no `requiredRuntimePlugins`, no `defaultRuntimePlugins`
// - `evaluationFunction.implementation` is BINDING (canonical evaluator harness reference)
// - `signature: { alg: 'eip-191'; signer: 0x...; value: 0x... }`

import { z } from 'zod';
import type { JsonSchema } from '../json-schema.js';

// JSON Schema is opaque to this validator — manifests carry user-authored
// schemas whose internal shape we do not constrain here. Manifest readers
// validate payloads against these schemas at task/solution/verdict handling
// time. `z.record(z.string(), z.unknown())` already rejects non-object input,
// so no further refinement is needed.
const JsonSchemaZ: z.ZodType<JsonSchema> = z.record(z.string(), z.unknown());

const HexStringZ = z
  .string()
  .regex(/^0x[0-9a-fA-F]+$/u, {
    message: 'must be 0x-prefixed hex with at least one hex digit',
  }) as z.ZodType<`0x${string}`>;

const NumericStringZ = z
  .string()
  .regex(/^\d+$/u, { message: 'must be a non-negative integer string (wei)' });

// `creator` is the launcher role and is always implicit — it never appears in
// `openRoles` because the launcher is the SolverNet's authority document
// signer, not a participant target advertised for join. `openRoles` is
// constrained inline to ['solver', 'evaluator']; this enum is exposed for
// callers that reason about all three roles (e.g., credentialRequirements
// keying).
const ContractRoleZ = z.enum(['creator', 'solver', 'evaluator']);

const CredentialRequirementZ = z.object({
  id: z.string().min(1),
  kind: z.string().min(1),
  required: z.boolean(),
  description: z.string(),
}).strict();

const ClaimPolicyDefaultsZ = z.object({
  mode: z.enum(['parallel', 'serial']),
  maxClaims: z.number().int().nonnegative(),
  maxClaimsPerOperator: z.number().int().nonnegative(),
  claimLeaseTtlSeconds: z.number().int().nonnegative(),
}).strict();

const EvaluationFunctionZ = z.object({
  id: z.string().min(1),
  deterministic: z.boolean(),
  inputs: z.array(z.string()),
  output: z.string().min(1),
  implementation: z.string().min(1), // BINDING — see §7
}).strict();

const AggregationFunctionZ = z.object({
  id: z.string().min(1),
  deterministic: z.boolean(),
  inputs: z.array(z.string()),
  output: z.string().min(1),
  windowDays: z.number().int().positive().optional(),
}).strict();

const ContractZ = z.object({
  id: z.string().min(1),
  version: z.string().min(1),
  schemas: z.object({
    task: JsonSchemaZ,
    solution: JsonSchemaZ,
    verdict: JsonSchemaZ,
  }).strict(),
  claimPolicyDefaults: ClaimPolicyDefaultsZ,
  credentialRequirements: z.object({
    creator: z.array(CredentialRequirementZ),
    solver: z.array(CredentialRequirementZ),
    evaluator: z.array(CredentialRequirementZ),
  }).strict(),
  evaluationFunction: EvaluationFunctionZ,
  aggregationFunction: AggregationFunctionZ,
}).strict();

const LauncherZ = z.object({
  safeAddress: HexStringZ,
  agentEoa: HexStringZ,
  agentId: z.string().min(1),
}).strict();

const SignatureZ = z.object({
  alg: z.literal('eip-191'),
  signer: HexStringZ,
  value: HexStringZ,
}).strict();

const RegistryZ = z.object({
  manifestCid: z.string().min(1).optional(),
  registryUrl: z.string().min(1).optional(),
}).strict();

export const SolverNetManifestV1Schema = z.object({
  schemaVersion: z.literal('solvernet.manifest.v1'),
  solverNetId: z.string().min(1),
  network: z.enum(['base-sepolia', 'base']),
  name: z.string().min(1),
  description: z.string(),

  launcher: LauncherZ,
  contract: ContractZ,

  solutionPriceWei: NumericStringZ,
  verdictPriceWei: NumericStringZ,
  openRoles: z.array(z.enum(['solver', 'evaluator'])).min(1),

  registry: RegistryZ.optional(),

  createdAt: z.string().min(1),
  launchedAt: z.string().min(1),
  signature: SignatureZ,
}).strict();

/**
 * The canonical TypeScript shape of a SolverNetManifestV1, derived from the
 * Zod schema. Mirrors the interface in §7 of the spec exactly.
 *
 * Note: derivation from Zod ensures the type and the validator can never
 * drift apart. If you change the Zod schema, the type updates automatically.
 */
export type SolverNetManifestV1 = z.infer<typeof SolverNetManifestV1Schema>;

/**
 * Re-exports of the per-role helper types — useful for code that builds
 * partial pieces of a manifest before the full document is assembled.
 */
export type SolverNetContractRole = z.infer<typeof ContractRoleZ>;
export type SolverNetCredentialRequirement = z.infer<typeof CredentialRequirementZ>;
export type SolverNetClaimPolicyDefaults = z.infer<typeof ClaimPolicyDefaultsZ>;
export type SolverNetEvaluationFunction = z.infer<typeof EvaluationFunctionZ>;
export type SolverNetAggregationFunction = z.infer<typeof AggregationFunctionZ>;

export interface ManifestValidationIssue {
  path: string;
  message: string;
}

export type ManifestValidationResult =
  | { ok: true; value: SolverNetManifestV1 }
  | { ok: false; issues: ManifestValidationIssue[] };

/**
 * Validate a value against the SolverNetManifestV1 schema. Returns a tagged
 * union with either the typed manifest or a list of validation issues with
 * dotted paths suitable for surfacing in launcher UI.
 */
export function validateSolverNetManifest(value: unknown): ManifestValidationResult {
  const parsed = SolverNetManifestV1Schema.safeParse(value);
  if (parsed.success) {
    return { ok: true, value: parsed.data };
  }
  const issues = parsed.error.issues.map((issue) => ({
    path: issue.path.length > 0 ? issue.path.join('.') : '<root>',
    message: issue.message,
  }));
  return { ok: false, issues };
}
