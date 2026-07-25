import { z } from 'zod/v3';
import {
  JinnRepoAutopilotSessionTaskSchema,
} from './jinn-repo.js';

const SafeIntegerSchema = z.number().int().safe();
const NonNegativeSafeIntegerSchema = SafeIntegerSchema.nonnegative();
const Hex32Schema = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const AddressSchema = z.string().regex(/^0x[0-9a-fA-F]{40}$/);

const ExclusiveClaimPolicySchema = z.object({
  mode: z.literal('exclusive'),
  maxClaims: z.literal(1),
  maxClaimsPerOperator: z.literal(1),
  claimWindowStartTs: SafeIntegerSchema,
  claimWindowEndTs: SafeIntegerSchema,
  submissionDeadlineTs: SafeIntegerSchema,
  claimLeaseTtlSeconds: SafeIntegerSchema.positive(),
  requiredVerdicts: z.literal(1),
}).strict();

/**
 * Canonical immutable request consumed by `jinn tasks submit --request-file`.
 *
 * This is the former client-private validator. Its wire version and ordering,
 * selection, deterministic-key, and deadline invariants are unchanged.
 */
export const TaskSubmitRequestV1Schema =
  z.object({
    schemaVersion: z.literal('jinn-task-submit-request.v1'),
    id: z.string().min(1),
    description: z.string().min(1),
    solverType: z.literal('jinn-repo.v1'),
    solverNetManifestCid: z.string().min(1).optional(),
    solverNet: z.string().min(1).optional(),
    createdAt: SafeIntegerSchema,
    window: z.object({
      startTs: SafeIntegerSchema,
      endTs: SafeIntegerSchema,
    }).strict(),
    claimPolicy: ExclusiveClaimPolicySchema,
    spec: JinnRepoAutopilotSessionTaskSchema,
  }).strict().superRefine((request, ctx) => {
    const specBindings = [
      ['repo', request.spec.repo, request.spec.session.repository],
      ['language', request.spec.language, request.spec.session.language],
      [
        'verificationProfile',
        request.spec.verificationProfile,
        request.spec.session.verificationProfile,
      ],
    ] as const;
    for (const [field, outer, inner] of specBindings) {
      if (outer !== inner) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['spec', field],
          message: `${field} must match the Autopilot session`,
        });
      }
    }
    const expectedId = `autopilot:${request.spec.session.v2AttemptId}`;
    if (request.id !== expectedId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['id'],
        message: `id must be the deterministic Task key ${expectedId}`,
      });
    }
    if (request.solverNetManifestCid && request.solverNet) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['solverNet'],
        message: 'solverNetManifestCid and solverNet are mutually exclusive',
      });
    }
    if (request.window.endTs <= request.window.startTs) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['window', 'endTs'],
        message: 'window.endTs must be after window.startTs',
      });
    }
    const policy = request.claimPolicy;
    const timingIssues: Array<[Array<string | number>, boolean, string]> = [
      [
        ['createdAt'],
        request.createdAt <= request.window.startTs,
        'createdAt must be no later than window.startTs',
      ],
      [
        ['claimPolicy', 'claimWindowStartTs'],
        policy.claimWindowStartTs >= request.window.startTs,
        'claimWindowStartTs must be within the Task window',
      ],
      [
        ['claimPolicy', 'claimWindowEndTs'],
        policy.claimWindowEndTs > policy.claimWindowStartTs,
        'claimWindowEndTs must be after claimWindowStartTs',
      ],
      [
        ['claimPolicy', 'claimWindowEndTs'],
        policy.claimWindowEndTs <= request.window.endTs,
        'claimWindowEndTs must be within the Task window',
      ],
      [
        ['claimPolicy', 'submissionDeadlineTs'],
        policy.submissionDeadlineTs > policy.claimWindowEndTs,
        'submissionDeadlineTs must be after claimWindowEndTs',
      ],
      [
        ['claimPolicy', 'submissionDeadlineTs'],
        policy.submissionDeadlineTs <= request.window.endTs,
        'submissionDeadlineTs must be within the Task window',
      ],
    ];
    const sessionDeadline = Date.parse(request.spec.session.deadline);
    timingIssues.push(
      [
        ['spec', 'session', 'deadline'],
        Number.isFinite(sessionDeadline)
          && sessionDeadline >= policy.claimWindowEndTs,
        'session deadline must not precede claimWindowEndTs',
      ],
      [
        ['spec', 'session', 'deadline'],
        Number.isFinite(sessionDeadline)
          && sessionDeadline <= policy.submissionDeadlineTs,
        'session deadline must be within submissionDeadlineTs',
      ],
    );
    for (const [path, valid, message] of timingIssues) {
      if (!valid) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path, message });
      }
    }
  });

export type TaskSubmitRequestV1 = z.infer<typeof TaskSubmitRequestV1Schema>;

export type TaskSubmitResultV1 = z.infer<typeof TaskSubmitResultV1Schema>;

export const TaskSubmitResultV1Schema = z.object({
  schemaVersion: z.literal(1),
  generatedAt: z.string().datetime({ offset: true }),
  verb: z.literal('tasks submit'),
  id: z.string().min(1),
  creatorMultisig: AddressSchema,
  taskId: z.string().min(1),
  taskCid: z.string().min(1),
  creationTx: Hex32Schema,
  creationBlock: NonNegativeSafeIntegerSchema,
  solverNetManifestCid: z.string().min(1),
  status: z.enum(['submitted', 'already_submitted']),
  attemptId: z.string().min(1).optional(),
  attemptNumber: NonNegativeSafeIntegerSchema.optional(),
  idempotent: z.boolean(),
}).strict().superRefine((value, ctx) => {
  const expectedStatus = value.idempotent
    ? 'already_submitted'
    : 'submitted';
  if (value.status !== expectedStatus) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['status'],
      message: `status must be ${expectedStatus} when idempotent is ${value.idempotent}`,
    });
  }
});

export function parseTaskSubmitRequestV1(input: unknown): TaskSubmitRequestV1 {
  return TaskSubmitRequestV1Schema.parse(input);
}
