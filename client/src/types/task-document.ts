/**
 * task.v1 — canonical signed Task document.
 *
 * This is the IPFS-addressed, signed document posted through the deployed
 * router compatibility surface. `solverType` is the protocol join key; `spec`
 * is the SolverType-specific payload.
 */

import { z } from 'zod/v3';
import { WindowSchema } from './window.js';

const HexStringSchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]*$/, 'must be a 0x-prefixed hex string');

const SignatureSchema = z.object({
  algo: z.literal('secp256k1'),
  signer: HexStringSchema,
  hash: HexStringSchema,
  sig: HexStringSchema,
});

const CreatorSchema = z.object({
  safeAddress: HexStringSchema,
  agentEoa: HexStringSchema,
});

export const TaskClaimPolicySchema = z.object({
  mode: z.enum(['exclusive', 'parallel']).default('exclusive'),
  maxClaims: z.number().int().positive(),
  maxClaimsPerOperator: z.number().int().positive().default(1),
  claimWindowStartTs: z.number().int().optional(),
  claimWindowEndTs: z.number().int().optional(),
  submissionDeadlineTs: z.number().int().optional(),
  claimLeaseTtlSeconds: z.number().int().positive().default(30 * 60),
  policyHook: HexStringSchema.optional(),
  /**
   * On-chain `evaluationPolicy.requiredVerdicts` — the number of verdict
   * claim slots per attempt. Optional; the adapter defaults it to 1. A value
   * > 1 lets an honest evaluator still claim and deliver a verdict slot when
   * other (e.g. non-delivering) evaluators have already taken some slots —
   * the per-evaluator cap (`maxVerdictsPerEvaluator: 1`) means no single
   * evaluator can monopolise all of them. Useful on a shared/adversarial
   * network where verdict slots may be squatted.
   */
  requiredVerdicts: z.number().int().positive().optional(),
  /**
   * On-chain `TaskPolicy.allowSolverSelfEvaluation`. Optional; the adapter
   * defaults it to `false` → the coordinator rejects a verdict whose evaluator
   * is the attempt's solver (the independent-evaluation invariant). A testnet
   * SolverNet sets it `true` so a single operator can solve + self-evaluate +
   * close the loop solo (dogfooding). Leave unset/false on mainnet.
   */
  allowSolverSelfEvaluation: z.boolean().optional(),
}).passthrough();

export type TaskClaimPolicy = z.infer<typeof TaskClaimPolicySchema>;

/**
 * Generic execution-profile pin (issue #2039). Lets a signed task pin the
 * exact harness/model/version it must run under, plus an opaque loadout
 * reference and isolation request. Core carries these fields without
 * interpreting them — `harness`/`model`/`version` are checked by the engine
 * against the resolved SolverNet (`solverNetManifestCid`) before claim or
 * model invocation; `loadoutRef`/`isolation` are consumer-defined (e.g. a
 * benchmark harness) and pass through unvalidated. Being part of
 * `TaskV1Fields`, any change to these fields changes the canonical-JSON hash
 * and therefore invalidates the task's signature — no separate enforcement
 * needed for that.
 */
export const ExecutionRequestSchema = z.object({
  harness: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  version: z.string().min(1).optional(),
  loadoutRef: z.string().min(1).optional(),
  isolation: z.enum(['shared', 'dedicated']).optional(),
}).strict();

export type ExecutionRequest = z.infer<typeof ExecutionRequestSchema>;

const NoLegacyKindSchema = z.record(z.unknown()).superRefine((spec, ctx) => {
  if (Object.prototype.hasOwnProperty.call(spec, 'kind')) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'spec.kind is retired; use top-level solverType',
      path: ['kind'],
    });
  }
});

const TaskV1Fields = {
  schemaVersion: z.literal('task.v1'),
  id: z.string().min(1),
  /**
   * Legacy SolverType identity string (e.g. `prediction.v1`). Daemon-internal
   * dispatch still uses it during migration; new code should derive it as
   * ``${contractId}.${contractVersion}`` from the BINDING fields below.
   * Spec §14 (Task 24, 2026-05-05-solvernet-creation-and-launch.md).
   * @deprecated Use `contractId` + `contractVersion` (and `solverNetManifestCid`
   *   for protocol identity).
   */
  solverType: z.string().min(1),
  /**
   * BINDING — IPFS CID of the launched SolverNet manifest the task is posted
   * under. Becomes `manifestDigest = keccak256(solverNetManifestCid)` on
   * chain (replaces the prior `keccak256(solverType)` digest). Per spec §14
   * this is the protocol identity; per-launch eligibility derives from it.
   */
  solverNetManifestCid: z.string().min(1),
  /** SolverNet contract id (e.g. `prediction`). See spec §14. */
  contractId: z.string().min(1),
  /** SolverNet contract version (e.g. `v1`). See spec §14. */
  contractVersion: z.string().min(1),
  role: z.enum(['restoration', 'evaluation']).default('restoration'),
  description: z.string().min(1),
  window: WindowSchema,
  spec: NoLegacyKindSchema,
  eligibility: z.record(z.unknown()),
  claimPolicy: TaskClaimPolicySchema,
  executionRequest: ExecutionRequestSchema.optional(),
  creator: CreatorSchema,
  createdAt: z.number().int(),
};

function rejectTopLevelKind<T extends z.ZodRawShape>(schema: z.ZodObject<T>) {
  return schema.passthrough().superRefine((task, ctx) => {
    if (Object.prototype.hasOwnProperty.call(task, 'kind')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'kind is retired; use top-level solverType',
        path: ['kind'],
      });
    }
  }).transform((task) => {
    const { kind: _kind, ...canonical } = task as z.infer<typeof schema> & { kind?: unknown };
    return canonical as z.infer<typeof schema>;
  });
}

export const TaskV1Schema = rejectTopLevelKind(z.object(TaskV1Fields));

export type TaskV1 = z.infer<typeof TaskV1Schema>;

export const SignedTaskV1Schema = rejectTopLevelKind(z.object({
  ...TaskV1Fields,
  signature: SignatureSchema,
}));

export type SignedTaskV1 = z.infer<typeof SignedTaskV1Schema>;

export function parseTaskV1(input: unknown): TaskV1 {
  return TaskV1Schema.parse(input);
}

export function parseSignedTaskV1(input: unknown): SignedTaskV1 {
  return SignedTaskV1Schema.parse(input);
}
