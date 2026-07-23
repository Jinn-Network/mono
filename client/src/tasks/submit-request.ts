import {
  JinnRepoAutopilotSessionTaskSchema,
  type JinnRepoAutopilotSessionTask,
} from '@jinn-network/sdk/solvernets/jinn-repo';
import { z, type ZodType } from 'zod/v3';

const ExclusiveClaimPolicySchema = z.object({
  mode: z.literal('exclusive'),
  maxClaims: z.literal(1),
  maxClaimsPerOperator: z.literal(1),
  claimWindowStartTs: z.number().int(),
  claimWindowEndTs: z.number().int(),
  submissionDeadlineTs: z.number().int(),
  claimLeaseTtlSeconds: z.number().int().positive(),
  requiredVerdicts: z.literal(1),
}).strict();

export interface MarketplaceTaskSubmitRequest {
  schemaVersion: 'jinn-task-submit-request.v1';
  id: string;
  description: string;
  solverType: 'jinn-repo.v1';
  solverNetManifestCid?: string;
  solverNet?: string;
  createdAt: number;
  window: { startTs: number; endTs: number };
  claimPolicy: {
    mode: 'exclusive';
    maxClaims: 1;
    maxClaimsPerOperator: 1;
    claimWindowStartTs: number;
    claimWindowEndTs: number;
    submissionDeadlineTs: number;
    claimLeaseTtlSeconds: number;
    requiredVerdicts: 1;
  };
  spec: JinnRepoAutopilotSessionTask;
}

export const MarketplaceTaskSubmitRequestSchema: ZodType<MarketplaceTaskSubmitRequest> =
  z.object({
    schemaVersion: z.literal('jinn-task-submit-request.v1'),
    id: z.string().min(1),
    description: z.string().min(1),
    solverType: z.literal('jinn-repo.v1'),
    solverNetManifestCid: z.string().min(1).optional(),
    solverNet: z.string().min(1).optional(),
    createdAt: z.number().int(),
    window: z.object({
      startTs: z.number().int(),
      endTs: z.number().int(),
    }).strict(),
    claimPolicy: ExclusiveClaimPolicySchema,
    spec: JinnRepoAutopilotSessionTaskSchema.strict(),
  }).strict().superRefine((request, ctx) => {
    const expectedId = `autopilot:${request.spec.session.v2AttemptId}`;
    if (request.id !== expectedId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['id'],
        message: `id must be the deterministic Task key ${expectedId}`,
      });
    }
    if (!request.solverNetManifestCid && !request.solverNet) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['solverNetManifestCid'],
        message: 'solverNetManifestCid or solverNet is required',
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
        Number.isFinite(sessionDeadline) && sessionDeadline >= policy.claimWindowEndTs,
        'session deadline must not precede claimWindowEndTs',
      ],
      [
        ['spec', 'session', 'deadline'],
        Number.isFinite(sessionDeadline) && sessionDeadline <= policy.submissionDeadlineTs,
        'session deadline must be within submissionDeadlineTs',
      ],
    );
    for (const [path, valid, message] of timingIssues) {
      if (!valid) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path, message });
      }
    }
  });

export function parseMarketplaceTaskSubmitRequest(
  input: unknown,
): MarketplaceTaskSubmitRequest {
  return MarketplaceTaskSubmitRequestSchema.parse(input);
}
