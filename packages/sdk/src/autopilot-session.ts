import { z } from 'zod/v3';

const MAX_PATCH_BYTES = 2 * 1024 * 1024;
const MAX_EVIDENCE_ENTRIES = 100;
const MAX_REVIEW_FINDINGS = 50;
const MAX_REVIEW_FOLLOW_UPS = 5;
const MAX_RECEIPT_AUTHORS = 50;
const MAX_MUTATION_SUMMARY_BYTES = 8 * 1024;
const MAX_MUTATION_EVIDENCE_BYTES = 32 * 1024;
const MAX_REVIEW_BODY_BYTES = 48 * 1024;
const MAX_REVIEW_TITLE_BYTES = 240;
const MAX_REVIEW_PATH_BYTES = 1024;
const MAX_HUMAN_DETAIL_BYTES = 8 * 1024;

const PrintableStringSchema = z.string().min(1).regex(/^[\x20-\x7e]+$/);
const GitOidSchema = z.string().regex(/^[0-9a-f]{40}$/);
const UuidSchema = z.string().uuid();
const IsoTimestampSchema = z.string().datetime({ offset: true });
const PositiveIntegerSchema = z.number().int().positive();
const PatchSchema = z.string().min(1).refine(
  (patch) => new TextEncoder().encode(patch).byteLength <= MAX_PATCH_BYTES,
  'Patch must be no larger than 2 MiB when UTF-8 encoded',
);

export const GitHubRepositorySlugSchema = z.string()
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/,
    'Repository must be a safe GitHub owner/name slug',
  )
  .refine(
    (repository) => !repository.toLowerCase().endsWith('.git'),
    'Repository must not use a .git suffix',
  );

export const AutopilotSafeTokenSchema = z.string().regex(
  /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/,
  'Value must be a lowercase safe token',
);

function boundedText(maxBytes: number, label: string) {
  return z.string().min(1)
    .refine(
      (value) => !value.includes('\u0000'),
      `${label} must not contain NUL`,
    )
    .refine(
      (value) => new TextEncoder().encode(value).byteLength <= maxBytes,
      `${label} must be no larger than ${maxBytes} UTF-8 bytes`,
    );
}

function boundedSingleLine(maxBytes: number, label: string) {
  return boundedText(maxBytes, label).refine(
    (value) => !/[\r\n]/.test(value),
    `${label} must be a single line`,
  );
}

function aggregateUtf8Within(value: unknown, maxBytes: number): boolean {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength <= maxBytes;
}

export const AutopilotWorkflowSchema = z.enum([
  'implement',
  'fix-child',
  'reconcile',
  'ci-failure',
]);

export type AutopilotWorkflow = z.infer<typeof AutopilotWorkflowSchema>;

const autopilotSessionCommonFields = {
  schemaVersion: z.literal('jinn-autopilot-session.v1'),
  repository: GitHubRepositorySlugSchema,
  language: AutopilotSafeTokenSchema,
  verificationProfile: AutopilotSafeTokenSchema,
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
    targetBaseOid: GitOidSchema,
  }).strict(),
  deadline: IsoTimestampSchema,
  receiptAuthors: z.array(PrintableStringSchema).min(1).max(MAX_RECEIPT_AUTHORS),
};

function mutationWorkflowContractSchema<
  Skill extends 'implement-issue' | 'fix-child' | 'reconcile',
>(skill: Skill) {
  return z.object({
    skill: z.literal(skill),
    version: z.literal('v2'),
    resultSchema: z.literal('jinn-autopilot-mutation-result.v1'),
  }).strict();
}

export const AutopilotSessionCapsuleSchema = z.discriminatedUnion('workflow', [
  z.object({
    ...autopilotSessionCommonFields,
    workflow: z.literal('implement'),
    workflowContract: mutationWorkflowContractSchema('implement-issue'),
  }).strict(),
  z.object({
    ...autopilotSessionCommonFields,
    workflow: z.literal('fix-child'),
    workflowContract: mutationWorkflowContractSchema('fix-child'),
  }).strict(),
  z.object({
    ...autopilotSessionCommonFields,
    workflow: z.literal('reconcile'),
    workflowContract: mutationWorkflowContractSchema('reconcile'),
  }).strict(),
  z.object({
    ...autopilotSessionCommonFields,
    workflow: z.literal('ci-failure'),
    workflowContract: mutationWorkflowContractSchema('fix-child'),
  }).strict(),
]);

export type AutopilotSessionCapsule = z.infer<typeof AutopilotSessionCapsuleSchema>;

const autopilotCorrelationRequiredFields = {
  taskId: PrintableStringSchema,
  attemptIndex: z.number().int().nonnegative(),
  requestId: PrintableStringSchema,
  deliveryEnvelopeCid: PrintableStringSchema,
  v2AttemptId: UuidSchema,
  claimOid: GitOidSchema,
  prNumber: PositiveIntegerSchema,
  expectedHead: GitOidSchema,
};

const autopilotCorrelationFields = {
  ...autopilotCorrelationRequiredFields,
  resultingHead: GitOidSchema.optional(),
  reviewedHead: GitOidSchema.optional(),
  reviewGeneration: UuidSchema.optional(),
  reviewRefOid: GitOidSchema.optional(),
};

const {
  deliveryEnvelopeCid: _deliveryEnvelopeCid,
  ...autopilotMutationDeliveryCorrelationFields
} = autopilotCorrelationFields;

const AutopilotMutationDeliveryCorrelationSchema = z.object(
  autopilotMutationDeliveryCorrelationFields,
).strict();

export const AutopilotCorrelationSchema = z.object(
  autopilotCorrelationFields,
).strict();

export type AutopilotCorrelation = z.infer<typeof AutopilotCorrelationSchema>;

export const AutopilotReviewCorrelationSchema = z.object({
  ...autopilotCorrelationFields,
  resultingHead: GitOidSchema,
  reviewedHead: GitOidSchema,
  reviewGeneration: UuidSchema,
  reviewRefOid: GitOidSchema,
}).strict();

export type AutopilotReviewCorrelation = z.infer<
  typeof AutopilotReviewCorrelationSchema
>;

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
  detail: boundedText(MAX_HUMAN_DETAIL_BYTES, 'Human detail'),
}).strict();

export const AutopilotMutationEvidenceSchema = z.object({
  commands: z.array(boundedText(4 * 1024, 'Evidence command'))
    .max(MAX_EVIDENCE_ENTRIES),
  tests: z.array(boundedText(4 * 1024, 'Evidence test'))
    .max(MAX_EVIDENCE_ENTRIES),
  notes: z.array(boundedText(4 * 1024, 'Evidence note'))
    .max(MAX_EVIDENCE_ENTRIES).optional(),
}).strict().refine(
  (value) => aggregateUtf8Within(value, MAX_MUTATION_EVIDENCE_BYTES),
  `Mutation evidence must be no larger than ${MAX_MUTATION_EVIDENCE_BYTES} UTF-8 bytes`,
);

export type AutopilotMutationEvidence = z.infer<
  typeof AutopilotMutationEvidenceSchema
>;

const AutopilotMutationDeliveryCompleteResultSchema = z.object({
  schemaVersion: z.literal('jinn-autopilot-mutation-result.v1'),
  outcome: z.literal('mutation-complete'),
  correlation: AutopilotMutationDeliveryCorrelationSchema,
  patch: PatchSchema,
  summary: boundedSingleLine(MAX_MUTATION_SUMMARY_BYTES, 'Mutation summary'),
  evidence: AutopilotMutationEvidenceSchema,
}).strict();

const AutopilotMutationDeliveryHumanResultSchema = z.object({
  schemaVersion: z.literal('jinn-autopilot-mutation-result.v1'),
  outcome: z.literal('human'),
  correlation: AutopilotMutationDeliveryCorrelationSchema,
  reason: AutopilotHumanReasonSchema,
}).strict();

export const AutopilotMutationDeliveryResultSchema = z.discriminatedUnion(
  'outcome',
  [
    AutopilotMutationDeliveryCompleteResultSchema,
    AutopilotMutationDeliveryHumanResultSchema,
  ],
);

export type AutopilotMutationDeliveryResult = z.infer<
  typeof AutopilotMutationDeliveryResultSchema
>;

const AutopilotMutationCompleteResultSchema = z.object({
  schemaVersion: z.literal('jinn-autopilot-mutation-result.v1'),
  outcome: z.literal('mutation-complete'),
  correlation: AutopilotCorrelationSchema,
  patch: PatchSchema,
  summary: boundedSingleLine(MAX_MUTATION_SUMMARY_BYTES, 'Mutation summary'),
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

export function bindAutopilotMutationDeliveryResult(
  value: unknown,
  deliveryEnvelopeCid: string,
): AutopilotMutationResult {
  const delivery = AutopilotMutationDeliveryResultSchema.parse(value);
  return AutopilotMutationResultSchema.parse({
    ...delivery,
    correlation: {
      ...delivery.correlation,
      deliveryEnvelopeCid,
    },
  });
}

const AutopilotReviewFollowUpSchema = z.object({
  type: z.enum(['feat', 'chore', 'fix', 'refactor']),
  title: boundedSingleLine(MAX_REVIEW_TITLE_BYTES, 'Follow-up title'),
  body: boundedText(MAX_REVIEW_BODY_BYTES, 'Follow-up body'),
  effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']),
  priority: z.enum(['p0', 'p1', 'p2', 'p3', 'p4']),
}).strict();

const AutopilotReviewFindingSchema = z.object({
  title: boundedSingleLine(MAX_REVIEW_TITLE_BYTES, 'Finding title'),
  body: boundedText(MAX_REVIEW_BODY_BYTES, 'Finding body'),
  path: boundedText(MAX_REVIEW_PATH_BYTES, 'Finding path').optional(),
  line: PositiveIntegerSchema.optional(),
}).strict();

const AutopilotReviewApproveResultSchema = z.object({
  schemaVersion: z.literal('jinn-autopilot-review-result.v1'),
  outcome: z.literal('approve'),
  correlation: AutopilotReviewCorrelationSchema,
  body: boundedText(MAX_REVIEW_BODY_BYTES, 'Approval body'),
  followUps: z.array(AutopilotReviewFollowUpSchema)
    .max(MAX_REVIEW_FOLLOW_UPS)
    .refine(
      (value) => aggregateUtf8Within(value, MAX_REVIEW_BODY_BYTES),
      `Review follow-ups must be no larger than ${MAX_REVIEW_BODY_BYTES} UTF-8 bytes`,
    )
    .optional(),
}).strict();

const AutopilotReviewRequestChangesResultSchema = z.object({
  schemaVersion: z.literal('jinn-autopilot-review-result.v1'),
  outcome: z.literal('request-changes'),
  correlation: AutopilotReviewCorrelationSchema,
  findings: z.array(AutopilotReviewFindingSchema)
    .min(1)
    .max(MAX_REVIEW_FINDINGS)
    .refine(
      (value) => !value.some((finding) => (
        finding.title.includes('jinn-autopilot:child')
        || finding.body.includes('jinn-autopilot:child')
        || finding.path?.includes('jinn-autopilot:child') === true
      )),
      'Review findings must not contain Autopilot child markers',
    )
    .refine(
      (value) => aggregateUtf8Within(value, MAX_REVIEW_BODY_BYTES),
      `Review findings must be no larger than ${MAX_REVIEW_BODY_BYTES} UTF-8 bytes`,
    ),
}).strict();

const AutopilotReviewHumanResultSchema = z.object({
  schemaVersion: z.literal('jinn-autopilot-review-result.v1'),
  outcome: z.literal('human'),
  correlation: AutopilotReviewCorrelationSchema,
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
  ...autopilotCorrelationRequiredFields,
  recordedAt: IsoTimestampSchema,
};

export const AcceptedSolutionAdoptionReceiptSchema = z.object({
  ...adoptionReceiptCommonFields,
  disposition: z.literal('accepted'),
  role: z.literal('solution'),
  operation: z.enum(['implementation-complete', 'child-complete']),
  resultingHead: GitOidSchema,
  reviewedHead: z.never().optional(),
  reviewGeneration: UuidSchema,
  reviewRefOid: GitOidSchema,
}).strict();

export type AcceptedSolutionAdoptionReceipt = z.infer<
  typeof AcceptedSolutionAdoptionReceiptSchema
>;

const RejectedSolutionAdoptionReceiptSchema = z.object({
  ...adoptionReceiptCommonFields,
  disposition: z.literal('rejected'),
  role: z.literal('solution'),
  reason: AutopilotAdoptionRejectionReasonSchema,
  detail: boundedText(MAX_HUMAN_DETAIL_BYTES, 'Rejection detail'),
  resultingHead: GitOidSchema.optional(),
  reviewedHead: z.never().optional(),
  reviewGeneration: UuidSchema.optional(),
  reviewRefOid: GitOidSchema.optional(),
}).strict();

const acceptedVerdictAdoptionReceiptCommon = {
  ...adoptionReceiptCommonFields,
  disposition: z.literal('accepted'),
  role: z.literal('verdict'),
  resultingHead: GitOidSchema,
  reviewedHead: GitOidSchema,
  reviewGeneration: UuidSchema,
  reviewRefOid: GitOidSchema,
};

const AcceptedReviewVerdictAdoptionReceiptSchema = z.object({
  ...acceptedVerdictAdoptionReceiptCommon,
  operation: z.enum(['review-verdict', 'human']),
  childIssueNumber: z.never().optional(),
}).strict();

const AcceptedReviewFindingsAdoptionReceiptSchema = z.object({
  ...acceptedVerdictAdoptionReceiptCommon,
  operation: z.literal('review-findings'),
  childIssueNumber: z.number().int().positive(),
}).strict();

const RejectedVerdictAdoptionReceiptSchema = z.object({
  ...adoptionReceiptCommonFields,
  disposition: z.literal('rejected'),
  role: z.literal('verdict'),
  reason: AutopilotAdoptionRejectionReasonSchema,
  detail: boundedText(MAX_HUMAN_DETAIL_BYTES, 'Rejection detail'),
  resultingHead: GitOidSchema,
  reviewedHead: GitOidSchema,
  reviewGeneration: UuidSchema,
  reviewRefOid: GitOidSchema,
}).strict();

export const AutopilotAdoptionReceiptSchema = z.union([
  AcceptedSolutionAdoptionReceiptSchema,
  RejectedSolutionAdoptionReceiptSchema,
  AcceptedReviewVerdictAdoptionReceiptSchema,
  AcceptedReviewFindingsAdoptionReceiptSchema,
  RejectedVerdictAdoptionReceiptSchema,
]);

export type AutopilotAdoptionReceipt = z.infer<typeof AutopilotAdoptionReceiptSchema>;

const SafeAddressSchema = z.string().regex(/^0x[0-9a-fA-F]{40}$/);

const AutopilotEvaluationCorrelationSchema = AutopilotReviewCorrelationSchema.extend({
  resultingHead: GitOidSchema,
}).strict();

/**
 * Additive evaluation-only context attached after an Autopilot Solution has
 * been adopted and claimed through the Router. It is intentionally one strict
 * codec rather than a bag of Task.context fields: the accepted Solution
 * receipt, source correlation, full PR target, and the two canonical Safe
 * identities must agree before any semantic agent can run.
 */
export const AutopilotEvaluationContextSchema = z.object({
  schemaVersion: z.literal('jinn-autopilot-evaluation-context.v1'),
  operators: z.object({
    solutionSafe: SafeAddressSchema,
    evaluatorSafe: SafeAddressSchema,
  }).strict(),
  reviewTarget: z.object({
    repository: GitHubRepositorySlugSchema,
    issueNumber: PositiveIntegerSchema,
    childIssueNumber: PositiveIntegerSchema.optional(),
    prNumber: PositiveIntegerSchema,
    targetBase: PrintableStringSchema,
    baseOid: GitOidSchema,
    headRef: PrintableStringSchema,
    resultingHead: GitOidSchema,
    reviewGeneration: UuidSchema,
    reviewRefOid: GitOidSchema,
  }).strict(),
  session: AutopilotSessionCapsuleSchema,
  correlation: AutopilotEvaluationCorrelationSchema,
  solution: z.object({
    summary: boundedSingleLine(MAX_MUTATION_SUMMARY_BYTES, 'Mutation summary'),
    evidence: AutopilotMutationEvidenceSchema,
    adoptionReceipt: AcceptedSolutionAdoptionReceiptSchema,
  }).strict(),
}).strict().superRefine((value, ctx) => {
  const mismatch = (path: Array<string | number>, message: string): void => {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path, message });
  };
  const { session, reviewTarget, correlation, operators } = value;
  const receipt = value.solution.adoptionReceipt;

  if (operators.solutionSafe.toLowerCase() === operators.evaluatorSafe.toLowerCase()) {
    mismatch(['operators', 'evaluatorSafe'], 'Evaluator Safe must differ from Solution Safe');
  }

  const targetBindings: Array<[unknown, unknown, Array<string | number>, string]> = [
    [reviewTarget.repository, session.repository, ['reviewTarget', 'repository'], 'repository'],
    [reviewTarget.issueNumber, session.issueNumber, ['reviewTarget', 'issueNumber'], 'issue number'],
    [reviewTarget.childIssueNumber, session.childIssueNumber, ['reviewTarget', 'childIssueNumber'], 'child issue number'],
    [reviewTarget.prNumber, session.prNumber, ['reviewTarget', 'prNumber'], 'PR number'],
    [reviewTarget.targetBase, session.targetBase, ['reviewTarget', 'targetBase'], 'target base'],
    [reviewTarget.baseOid, session.taskSnapshot.targetBaseOid, ['reviewTarget', 'baseOid'], 'base OID'],
    [reviewTarget.headRef, session.branch, ['reviewTarget', 'headRef'], 'head ref'],
  ];
  for (const [actual, expected, path, label] of targetBindings) {
    if (actual !== expected) mismatch(path, `Evaluation ${label} does not match session`);
  }

  const receiptBindings: Array<[unknown, unknown, Array<string | number>, string]> = [
    [correlation.taskId, receipt.taskId, ['correlation', 'taskId'], 'taskId'],
    [correlation.attemptIndex, receipt.attemptIndex, ['correlation', 'attemptIndex'], 'attemptIndex'],
    [correlation.requestId, receipt.requestId, ['correlation', 'requestId'], 'requestId'],
    [correlation.deliveryEnvelopeCid, receipt.deliveryEnvelopeCid, ['correlation', 'deliveryEnvelopeCid'], 'deliveryEnvelopeCid'],
    [correlation.v2AttemptId, receipt.v2AttemptId, ['correlation', 'v2AttemptId'], 'v2AttemptId'],
    [correlation.claimOid, receipt.claimOid, ['correlation', 'claimOid'], 'claimOid'],
    [correlation.prNumber, receipt.prNumber, ['correlation', 'prNumber'], 'prNumber'],
    [correlation.expectedHead, receipt.expectedHead, ['correlation', 'expectedHead'], 'expectedHead'],
    [correlation.resultingHead, receipt.resultingHead, ['correlation', 'resultingHead'], 'resultingHead'],
    [correlation.reviewedHead, receipt.resultingHead, ['correlation', 'reviewedHead'], 'reviewedHead'],
    [correlation.reviewGeneration, receipt.reviewGeneration, ['correlation', 'reviewGeneration'], 'reviewGeneration'],
    [correlation.reviewRefOid, receipt.reviewRefOid, ['correlation', 'reviewRefOid'], 'reviewRefOid'],
    [reviewTarget.resultingHead, receipt.resultingHead, ['reviewTarget', 'resultingHead'], 'resulting head'],
    [reviewTarget.reviewGeneration, receipt.reviewGeneration, ['reviewTarget', 'reviewGeneration'], 'review generation'],
    [reviewTarget.reviewRefOid, receipt.reviewRefOid, ['reviewTarget', 'reviewRefOid'], 'review ref OID'],
  ];
  for (const [actual, expected, path, label] of receiptBindings) {
    if (actual !== expected) mismatch(path, `Evaluation ${label} does not match accepted Solution receipt`);
  }

  const sessionBindings: Array<[unknown, unknown, Array<string | number>, string]> = [
    [receipt.v2AttemptId, session.v2AttemptId, ['solution', 'adoptionReceipt', 'v2AttemptId'], 'v2AttemptId'],
    [receipt.claimOid, session.claimOid, ['solution', 'adoptionReceipt', 'claimOid'], 'claimOid'],
    [receipt.prNumber, session.prNumber, ['solution', 'adoptionReceipt', 'prNumber'], 'prNumber'],
    [receipt.expectedHead, session.expectedHead, ['solution', 'adoptionReceipt', 'expectedHead'], 'expectedHead'],
  ];
  for (const [actual, expected, path, label] of sessionBindings) {
    if (actual !== expected) mismatch(path, `Accepted Solution receipt ${label} does not match session`);
  }
});

export type AutopilotEvaluationContext = z.infer<
  typeof AutopilotEvaluationContextSchema
>;
