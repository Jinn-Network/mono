import { z } from 'zod/v3';

const MAX_PATCH_BYTES = 2 * 1024 * 1024;
const MAX_EVIDENCE_ENTRIES = 100;
const MAX_REVIEW_FINDINGS = 50;
const MAX_REVIEW_FOLLOW_UPS = 5;
const MAX_RECEIPT_AUTHORS = 50;

const PrintableStringSchema = z.string().min(1).regex(/^[\x20-\x7e]+$/);
const GitOidSchema = z.string().regex(/^[0-9a-f]{40}$/);
const UuidSchema = z.string().uuid();
const IsoTimestampSchema = z.string().datetime({ offset: true });
const PositiveIntegerSchema = z.number().int().positive();
const PatchSchema = z.string().min(1).refine(
  (patch) => new TextEncoder().encode(patch).byteLength <= MAX_PATCH_BYTES,
  'Patch must be no larger than 2 MiB when UTF-8 encoded',
);

export const AutopilotWorkflowSchema = z.enum([
  'implement',
  'fix-child',
  'reconcile',
  'ci-failure',
]);

export type AutopilotWorkflow = z.infer<typeof AutopilotWorkflowSchema>;

export const AutopilotSessionCapsuleSchema = z.object({
  schemaVersion: z.literal('jinn-autopilot-session.v1'),
  workflow: AutopilotWorkflowSchema,
  repository: z.literal('Jinn-Network/mono'),
  issueNumber: PositiveIntegerSchema,
  childIssueNumber: PositiveIntegerSchema.optional(),
  parentPrNumber: PositiveIntegerSchema.optional(),
  prNumber: PositiveIntegerSchema,
  targetBase: PrintableStringSchema,
  branch: PrintableStringSchema,
  claimOid: GitOidSchema,
  expectedHead: GitOidSchema,
  v2AttemptId: UuidSchema,
  runnerId: PrintableStringSchema,
  taskSnapshot: z.object({
    title: z.string(),
    body: z.string(),
    prBody: z.string(),
    baseSha: GitOidSchema,
  }).strict(),
  workflowContract: z.object({
    skill: z.enum(['implement-issue', 'fix-child', 'reconcile']),
    version: z.literal('v2'),
    resultSchema: z.enum([
      'jinn-autopilot-mutation-result.v1',
      'jinn-autopilot-review-result.v1',
    ]),
  }).strict(),
  deadline: IsoTimestampSchema,
  receiptAuthors: z.array(PrintableStringSchema).min(1).max(MAX_RECEIPT_AUTHORS),
}).strict();

export type AutopilotSessionCapsule = z.infer<typeof AutopilotSessionCapsuleSchema>;

const autopilotCorrelationFields = {
  taskId: PrintableStringSchema,
  attemptIndex: z.number().int().nonnegative(),
  requestId: PrintableStringSchema,
  deliveryEnvelopeCid: PrintableStringSchema,
  v2AttemptId: UuidSchema,
  claimOid: GitOidSchema,
  prNumber: PositiveIntegerSchema,
  expectedHead: GitOidSchema,
  resultingHead: GitOidSchema.optional(),
  reviewedHead: GitOidSchema.optional(),
  reviewGeneration: UuidSchema.optional(),
  reviewRefOid: GitOidSchema.optional(),
};

export const AutopilotCorrelationSchema = z.object(
  autopilotCorrelationFields,
).strict();

export type AutopilotCorrelation = z.infer<typeof AutopilotCorrelationSchema>;

const correlationKeys = [
  'taskId',
  'attemptIndex',
  'requestId',
  'deliveryEnvelopeCid',
  'v2AttemptId',
  'claimOid',
  'prNumber',
  'expectedHead',
  'resultingHead',
  'reviewedHead',
  'reviewGeneration',
  'reviewRefOid',
] as const satisfies readonly (keyof AutopilotCorrelation)[];

export function autopilotCorrelationMatches(
  expected: AutopilotCorrelation,
  actual: AutopilotCorrelation,
): boolean {
  return correlationKeys.every((key) => expected[key] === actual[key]);
}

const AutopilotHumanReasonSchema = z.object({
  code: PrintableStringSchema,
  detail: z.string().min(1),
}).strict();

const AutopilotMutationEvidenceSchema = z.object({
  commands: z.array(z.string().min(1)).max(MAX_EVIDENCE_ENTRIES),
  tests: z.array(z.string().min(1)).max(MAX_EVIDENCE_ENTRIES),
  notes: z.array(z.string().min(1)).max(MAX_EVIDENCE_ENTRIES).optional(),
}).strict();

const AutopilotMutationCompleteResultSchema = z.object({
  schemaVersion: z.literal('jinn-autopilot-mutation-result.v1'),
  outcome: z.literal('mutation-complete'),
  correlation: AutopilotCorrelationSchema,
  patch: PatchSchema,
  summary: z.string().min(1),
  evidence: AutopilotMutationEvidenceSchema,
}).strict();

const AutopilotMutationHumanResultSchema = z.object({
  schemaVersion: z.literal('jinn-autopilot-mutation-result.v1'),
  outcome: z.literal('human'),
  correlation: AutopilotCorrelationSchema,
  reason: AutopilotHumanReasonSchema,
}).strict();

export const AutopilotMutationResultSchema = z.discriminatedUnion('outcome', [
  AutopilotMutationCompleteResultSchema,
  AutopilotMutationHumanResultSchema,
]);

export type AutopilotMutationResult = z.infer<typeof AutopilotMutationResultSchema>;

const AutopilotReviewFollowUpSchema = z.object({
  title: z.string().min(1),
  body: z.string().min(1),
}).strict();

const AutopilotReviewFindingSchema = z.object({
  title: z.string().min(1),
  body: z.string().min(1),
  path: z.string().min(1).optional(),
  line: PositiveIntegerSchema.optional(),
}).strict();

const AutopilotReviewApproveResultSchema = z.object({
  schemaVersion: z.literal('jinn-autopilot-review-result.v1'),
  outcome: z.literal('approve'),
  correlation: AutopilotCorrelationSchema,
  body: z.string().min(1),
  followUps: z.array(AutopilotReviewFollowUpSchema).max(MAX_REVIEW_FOLLOW_UPS).optional(),
}).strict();

const AutopilotReviewRequestChangesResultSchema = z.object({
  schemaVersion: z.literal('jinn-autopilot-review-result.v1'),
  outcome: z.literal('request-changes'),
  correlation: AutopilotCorrelationSchema,
  findings: z.array(AutopilotReviewFindingSchema).min(1).max(MAX_REVIEW_FINDINGS),
}).strict();

const AutopilotReviewHumanResultSchema = z.object({
  schemaVersion: z.literal('jinn-autopilot-review-result.v1'),
  outcome: z.literal('human'),
  correlation: AutopilotCorrelationSchema,
  reason: AutopilotHumanReasonSchema,
}).strict();

export const AutopilotReviewResultSchema = z.discriminatedUnion('outcome', [
  AutopilotReviewApproveResultSchema,
  AutopilotReviewRequestChangesResultSchema,
  AutopilotReviewHumanResultSchema,
]);

export type AutopilotReviewResult = z.infer<typeof AutopilotReviewResultSchema>;

export const AutopilotAdoptionRejectionReasonSchema = z.enum([
  'correlation-mismatch',
  'untrusted-operator',
  'stale-claim',
  'stale-head',
  'stale-review-generation',
  'invalid-artifact',
  'patch-does-not-apply',
  'verification-failed',
  'policy-human',
  'receipt-contradiction',
  'internal-adoption-failure',
]);

export type AutopilotAdoptionRejectionReason = z.infer<
  typeof AutopilotAdoptionRejectionReasonSchema
>;

const adoptionReceiptCommonFields = {
  schemaVersion: z.literal('jinn-autopilot-marketplace-adoption.v1'),
  ...autopilotCorrelationFields,
  recordedAt: IsoTimestampSchema,
};

const AcceptedSolutionAdoptionReceiptSchema = z.object({
  ...adoptionReceiptCommonFields,
  disposition: z.literal('accepted'),
  role: z.literal('solution'),
  operation: z.enum(['implementation-complete', 'child-complete']),
  resultingHead: GitOidSchema,
  reviewGeneration: UuidSchema,
  reviewRefOid: GitOidSchema,
}).strict();

const RejectedSolutionAdoptionReceiptSchema = z.object({
  ...adoptionReceiptCommonFields,
  disposition: z.literal('rejected'),
  role: z.literal('solution'),
  reason: AutopilotAdoptionRejectionReasonSchema,
  detail: z.string().min(1),
}).strict();

const AcceptedVerdictAdoptionReceiptSchema = z.object({
  ...adoptionReceiptCommonFields,
  disposition: z.literal('accepted'),
  role: z.literal('verdict'),
  operation: z.enum(['review-verdict', 'review-findings', 'human']),
  reviewedHead: GitOidSchema,
  reviewGeneration: UuidSchema,
  reviewRefOid: GitOidSchema,
}).strict();

const RejectedVerdictAdoptionReceiptSchema = z.object({
  ...adoptionReceiptCommonFields,
  disposition: z.literal('rejected'),
  role: z.literal('verdict'),
  reason: AutopilotAdoptionRejectionReasonSchema,
  detail: z.string().min(1),
}).strict();

export const AutopilotAdoptionReceiptSchema = z.union([
  AcceptedSolutionAdoptionReceiptSchema,
  RejectedSolutionAdoptionReceiptSchema,
  AcceptedVerdictAdoptionReceiptSchema,
  RejectedVerdictAdoptionReceiptSchema,
]);

export type AutopilotAdoptionReceipt = z.infer<typeof AutopilotAdoptionReceiptSchema>;
