import { z } from 'zod/v3';
import { GitHubRepositorySlugSchema } from './autopilot-session.js';

const MAX_FINDINGS = 50;
const MAX_FINDING_TITLE_BYTES = 240;
const MAX_FINDING_DETAIL_BYTES = 8 * 1024;
const MAX_REPOSITORY_BYTES = 200;

export const Sha256DigestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);
export const GitOidSchema = z.string().regex(/^[0-9a-f]{40}$/);

function boundedText(maxBytes: number, label: string) {
  return z.string().min(1)
    .refine((value) => !value.includes('\u0000'), `${label} must not contain NUL`)
    .refine(
      (value) => new TextEncoder().encode(value).byteLength <= maxBytes,
      `${label} must be no larger than ${maxBytes} UTF-8 bytes`,
    );
}

const RepositorySchema = GitHubRepositorySlugSchema.refine(
  (repository) => new TextEncoder().encode(repository).byteLength <= MAX_REPOSITORY_BYTES,
  `Repository must be no larger than ${MAX_REPOSITORY_BYTES} UTF-8 bytes`,
);

export const IssueRelayFindingV1Schema = z.object({
  code: boundedText(MAX_FINDING_TITLE_BYTES, 'Finding code'),
  title: boundedText(MAX_FINDING_TITLE_BYTES, 'Finding title').refine(
    (value) => !/[\r\n]/.test(value),
    'Finding title must be a single line',
  ),
  detail: boundedText(MAX_FINDING_DETAIL_BYTES, 'Finding detail'),
  path: boundedText(MAX_FINDING_DETAIL_BYTES, 'Finding path').optional(),
}).strict();

export interface IssueRelayFindingV1 {
  readonly code: string;
  readonly title: string;
  readonly detail: string;
  readonly path?: string;
}

export const IssueRelayPurposeSchema = z.enum(['initial', 'repair']);
export type IssueRelayPurpose = 'initial' | 'repair';

export interface IssueRelayRoundV1 {
  readonly schemaVersion: 'jinn-issue-relay-round.v1';
  readonly generation: string;
  readonly round: number;
  readonly snapshotDigest: `sha256:${string}`;
  readonly targetRepository: string;
  readonly workspaceRepository: string;
  readonly inputHead: string;
  readonly purpose: IssueRelayPurpose;
  readonly findings: readonly IssueRelayFindingV1[];
  readonly prNumber?: number;
}

const roundCommonFields = {
  schemaVersion: z.literal('jinn-issue-relay-round.v1'),
  generation: boundedText(MAX_FINDING_DETAIL_BYTES, 'Generation'),
  round: z.number().int().safe().nonnegative(),
  snapshotDigest: Sha256DigestSchema,
  targetRepository: RepositorySchema,
  workspaceRepository: RepositorySchema,
  inputHead: GitOidSchema,
};

const InitialIssueRelayRoundV1Schema = z.object({
  ...roundCommonFields,
  purpose: z.literal('initial'),
  findings: z.array(IssueRelayFindingV1Schema).max(MAX_FINDINGS),
  prNumber: z.never().optional(),
}).strict();

const RepairIssueRelayRoundV1Schema = z.object({
  ...roundCommonFields,
  purpose: z.literal('repair'),
  findings: z.array(IssueRelayFindingV1Schema).min(1).max(MAX_FINDINGS),
  prNumber: z.number().int().positive(),
}).strict();

export const IssueRelayRoundV1Schema = z.union([
  InitialIssueRelayRoundV1Schema,
  RepairIssueRelayRoundV1Schema,
]);

const SafeAddressSchema = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const IsoTimestampSchema = z.string().datetime({ offset: true });
const PositiveIntegerSchema = z.number().int().positive();
const NonNegativeSafeIntegerSchema = z.number().int().safe().nonnegative();
const SingleLineSchema = (maxBytes: number, label: string) => boundedText(maxBytes, label)
  .refine((value) => !/[\r\n]/.test(value), `${label} must be a single line`);

export interface IssueRelayCorrelationV1 {
  readonly generation: string;
  readonly round: number;
  readonly snapshotDigest: `sha256:${string}`;
  readonly taskId: string;
  readonly attemptIndex: number;
  readonly requestId: string;
  readonly deliveryEnvelopeCid: string;
}

export const IssueRelayCorrelationV1Schema = z.object({
  generation: SingleLineSchema(MAX_FINDING_DETAIL_BYTES, 'Generation'),
  round: NonNegativeSafeIntegerSchema,
  snapshotDigest: Sha256DigestSchema,
  taskId: SingleLineSchema(MAX_FINDING_DETAIL_BYTES, 'Task ID'),
  attemptIndex: NonNegativeSafeIntegerSchema,
  requestId: SingleLineSchema(MAX_FINDING_DETAIL_BYTES, 'Request ID'),
  deliveryEnvelopeCid: SingleLineSchema(MAX_FINDING_DETAIL_BYTES, 'Delivery envelope CID'),
}).strict();

export type IssueRelayAdoptionReceiptV1 =
  | {
      readonly schemaVersion: 'jinn-issue-relay-adoption.v1';
      readonly disposition: 'accepted';
      readonly correlation: IssueRelayCorrelationV1;
      readonly targetRepository: string;
      readonly workspaceRepository: string;
      readonly issueNumber: number;
      readonly prNumber: number;
      readonly headRef: string;
      readonly inputHead: string;
      readonly resultingHead: string;
      readonly patchDigest: `sha256:${string}`;
      readonly solutionSafe: string;
      readonly adoptedAt: string;
    }
  | {
      readonly schemaVersion: 'jinn-issue-relay-adoption.v1';
      readonly disposition: 'rejected';
      readonly correlation: IssueRelayCorrelationV1;
      readonly reason:
        | 'correlation-mismatch'
        | 'unsafe-patch'
        | 'stale-input'
        | 'verification-failed'
        | 'authority-changed'
        | 'cancelled';
      readonly detail: string;
      readonly recordedAt: string;
    };

const AcceptedIssueRelayAdoptionReceiptV1Schema = z.object({
  schemaVersion: z.literal('jinn-issue-relay-adoption.v1'),
  disposition: z.literal('accepted'),
  correlation: IssueRelayCorrelationV1Schema,
  targetRepository: RepositorySchema,
  workspaceRepository: RepositorySchema,
  issueNumber: PositiveIntegerSchema,
  prNumber: PositiveIntegerSchema,
  headRef: SingleLineSchema(MAX_FINDING_DETAIL_BYTES, 'Head ref'),
  inputHead: GitOidSchema,
  resultingHead: GitOidSchema,
  patchDigest: Sha256DigestSchema,
  solutionSafe: SafeAddressSchema,
  adoptedAt: IsoTimestampSchema,
}).strict();

const RejectedIssueRelayAdoptionReceiptV1Schema = z.object({
  schemaVersion: z.literal('jinn-issue-relay-adoption.v1'),
  disposition: z.literal('rejected'),
  correlation: IssueRelayCorrelationV1Schema,
  reason: z.enum([
    'correlation-mismatch',
    'unsafe-patch',
    'stale-input',
    'verification-failed',
    'authority-changed',
    'cancelled',
  ]),
  detail: boundedText(MAX_FINDING_DETAIL_BYTES, 'Rejection detail'),
  recordedAt: IsoTimestampSchema,
}).strict();

export const IssueRelayAdoptionReceiptV1Schema = z.union([
  AcceptedIssueRelayAdoptionReceiptV1Schema,
  RejectedIssueRelayAdoptionReceiptV1Schema,
]);

export interface IssueRelayEvaluationAnchorV1 {
  readonly schemaVersion: 'jinn-issue-relay-evaluation-anchor.v1';
  readonly correlation: IssueRelayCorrelationV1;
  readonly targetRepository: string;
  readonly workspaceRepository: string;
  readonly prNumber: number;
  readonly targetBase: string;
  readonly baseOid: string;
  readonly headRef: string;
  readonly evaluatedHead: string;
  readonly adoptionReceiptDigest: `sha256:${string}`;
  readonly checksDigest: `sha256:${string}`;
  readonly anchoredAt: string;
}

export const IssueRelayEvaluationAnchorV1Schema = z.object({
  schemaVersion: z.literal('jinn-issue-relay-evaluation-anchor.v1'),
  correlation: IssueRelayCorrelationV1Schema,
  targetRepository: RepositorySchema,
  workspaceRepository: RepositorySchema,
  prNumber: PositiveIntegerSchema,
  targetBase: SingleLineSchema(MAX_FINDING_DETAIL_BYTES, 'Target base'),
  baseOid: GitOidSchema,
  headRef: SingleLineSchema(MAX_FINDING_DETAIL_BYTES, 'Head ref'),
  evaluatedHead: GitOidSchema,
  adoptionReceiptDigest: Sha256DigestSchema,
  checksDigest: Sha256DigestSchema,
  anchoredAt: IsoTimestampSchema,
}).strict();

export interface IssueRelayEvaluationContextV1 {
  readonly schemaVersion: 'jinn-issue-relay-evaluation-context.v1';
  readonly goal: {
    readonly snapshotDigest: `sha256:${string}`;
    readonly problemStatement: string;
    readonly acceptanceEvidence: readonly string[];
    readonly verificationProfile: 'jinn-mono.v1';
  };
  readonly operators: {
    readonly solutionSafe: string;
    readonly evaluatorSafe: string;
  };
  readonly round: IssueRelayRoundV1;
  readonly correlation: IssueRelayCorrelationV1;
  readonly reviewTarget: {
    readonly targetRepository: string;
    readonly workspaceRepository: string;
    readonly issueNumber: number;
    readonly prNumber: number;
    readonly targetBase: string;
    readonly baseOid: string;
    readonly headRef: string;
    readonly evaluatedHead: string;
  };
  readonly adoptionReceipt: Extract<
    IssueRelayAdoptionReceiptV1,
    { readonly disposition: 'accepted' }
  >;
  readonly evaluationAnchor: IssueRelayEvaluationAnchorV1;
  readonly checks: {
    readonly digest: `sha256:${string}`;
    readonly required: readonly {
      readonly name: string;
      readonly status: 'passed';
      readonly url?: string;
    }[];
    readonly optional: readonly {
      readonly name: string;
      readonly status: 'passed' | 'failed' | 'pending';
      readonly url?: string;
    }[];
  };
}

const CheckNameSchema = SingleLineSchema(MAX_FINDING_TITLE_BYTES, 'Check name');
const OptionalCheckUrlSchema = SingleLineSchema(MAX_FINDING_DETAIL_BYTES, 'Check URL').optional();

function correlationsMatch(
  left: z.infer<typeof IssueRelayCorrelationV1Schema>,
  right: z.infer<typeof IssueRelayCorrelationV1Schema>,
): boolean {
  return left.generation === right.generation
    && left.round === right.round
    && left.snapshotDigest === right.snapshotDigest
    && left.taskId === right.taskId
    && left.attemptIndex === right.attemptIndex
    && left.requestId === right.requestId
    && left.deliveryEnvelopeCid === right.deliveryEnvelopeCid;
}

export const IssueRelayEvaluationContextV1Schema = z.object({
  schemaVersion: z.literal('jinn-issue-relay-evaluation-context.v1'),
  goal: z.object({
    snapshotDigest: Sha256DigestSchema,
    problemStatement: boundedText(MAX_FINDING_DETAIL_BYTES, 'Problem statement'),
    acceptanceEvidence: z.array(boundedText(MAX_FINDING_DETAIL_BYTES, 'Acceptance evidence')),
    verificationProfile: z.literal('jinn-mono.v1'),
  }).strict(),
  operators: z.object({
    solutionSafe: SafeAddressSchema,
    evaluatorSafe: SafeAddressSchema,
  }).strict(),
  round: IssueRelayRoundV1Schema,
  correlation: IssueRelayCorrelationV1Schema,
  reviewTarget: z.object({
    targetRepository: RepositorySchema,
    workspaceRepository: RepositorySchema,
    issueNumber: PositiveIntegerSchema,
    prNumber: PositiveIntegerSchema,
    targetBase: SingleLineSchema(MAX_FINDING_DETAIL_BYTES, 'Target base'),
    baseOid: GitOidSchema,
    headRef: SingleLineSchema(MAX_FINDING_DETAIL_BYTES, 'Head ref'),
    evaluatedHead: GitOidSchema,
  }).strict(),
  adoptionReceipt: AcceptedIssueRelayAdoptionReceiptV1Schema,
  evaluationAnchor: IssueRelayEvaluationAnchorV1Schema,
  checks: z.object({
    digest: Sha256DigestSchema,
    required: z.array(z.object({
      name: CheckNameSchema,
      status: z.literal('passed'),
      url: OptionalCheckUrlSchema,
    }).strict()),
    optional: z.array(z.object({
      name: CheckNameSchema,
      status: z.enum(['passed', 'failed', 'pending']),
      url: OptionalCheckUrlSchema,
    }).strict()),
  }).strict(),
}).strict().superRefine((value, ctx) => {
  const reject = (path: Array<string | number>, message: string): void => {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path, message });
  };
  const { round, correlation, reviewTarget, adoptionReceipt, evaluationAnchor } = value;

  if (value.goal.snapshotDigest !== round.snapshotDigest) {
    reject(['goal', 'snapshotDigest'], 'Goal snapshotDigest must match round');
  }
  if (
    correlation.generation !== round.generation
    || correlation.round !== round.round
    || correlation.snapshotDigest !== round.snapshotDigest
  ) {
    reject(['correlation'], 'Correlation must match round generation, round, and snapshotDigest');
  }
  if (value.operators.solutionSafe.toLowerCase() === value.operators.evaluatorSafe.toLowerCase()) {
    reject(['operators', 'evaluatorSafe'], 'Evaluator Safe must differ from Solution Safe');
  }
  if (value.operators.solutionSafe.toLowerCase() !== adoptionReceipt.solutionSafe.toLowerCase()) {
    reject(['operators', 'solutionSafe'], 'Solution Safe must match the accepted adoption receipt');
  }
  if (!correlationsMatch(correlation, adoptionReceipt.correlation)) {
    reject(['adoptionReceipt', 'correlation'], 'Adoption receipt correlation must match context');
  }
  if (!correlationsMatch(correlation, evaluationAnchor.correlation)) {
    reject(['evaluationAnchor', 'correlation'], 'Evaluation anchor correlation must match context');
  }
  const roundBindings: Array<[unknown, unknown, Array<string | number>, string]> = [
    [reviewTarget.targetRepository, round.targetRepository, ['reviewTarget', 'targetRepository'], 'target repository'],
    [reviewTarget.workspaceRepository, round.workspaceRepository, ['reviewTarget', 'workspaceRepository'], 'workspace repository'],
    [reviewTarget.prNumber, round.prNumber, ['reviewTarget', 'prNumber'], 'PR number'],
    [adoptionReceipt.inputHead, round.inputHead, ['adoptionReceipt', 'inputHead'], 'input head'],
  ];
  for (const [actual, expected, path, label] of roundBindings) {
    if (actual !== expected) reject(path, `Evaluation ${label} must match round`);
  }
  const receiptBindings: Array<[unknown, unknown, Array<string | number>, string]> = [
    [adoptionReceipt.targetRepository, reviewTarget.targetRepository, ['adoptionReceipt', 'targetRepository'], 'target repository'],
    [adoptionReceipt.workspaceRepository, reviewTarget.workspaceRepository, ['adoptionReceipt', 'workspaceRepository'], 'workspace repository'],
    [adoptionReceipt.prNumber, reviewTarget.prNumber, ['adoptionReceipt', 'prNumber'], 'PR number'],
    [adoptionReceipt.headRef, reviewTarget.headRef, ['adoptionReceipt', 'headRef'], 'head ref'],
    [adoptionReceipt.resultingHead, reviewTarget.evaluatedHead, ['adoptionReceipt', 'resultingHead'], 'evaluated head'],
  ];
  for (const [actual, expected, path, label] of receiptBindings) {
    if (actual !== expected) reject(path, `Adoption receipt ${label} must match review target`);
  }
  const anchorBindings: Array<[unknown, unknown, Array<string | number>, string]> = [
    [evaluationAnchor.targetRepository, reviewTarget.targetRepository, ['evaluationAnchor', 'targetRepository'], 'target repository'],
    [evaluationAnchor.workspaceRepository, reviewTarget.workspaceRepository, ['evaluationAnchor', 'workspaceRepository'], 'workspace repository'],
    [evaluationAnchor.prNumber, reviewTarget.prNumber, ['evaluationAnchor', 'prNumber'], 'PR number'],
    [evaluationAnchor.targetBase, reviewTarget.targetBase, ['evaluationAnchor', 'targetBase'], 'target base'],
    [evaluationAnchor.baseOid, reviewTarget.baseOid, ['evaluationAnchor', 'baseOid'], 'base OID'],
    [evaluationAnchor.headRef, reviewTarget.headRef, ['evaluationAnchor', 'headRef'], 'head ref'],
    [evaluationAnchor.evaluatedHead, reviewTarget.evaluatedHead, ['evaluationAnchor', 'evaluatedHead'], 'evaluated head'],
    [evaluationAnchor.checksDigest, value.checks.digest, ['evaluationAnchor', 'checksDigest'], 'checks digest'],
  ];
  for (const [actual, expected, path, label] of anchorBindings) {
    if (actual !== expected) reject(path, `Evaluation anchor ${label} must match context`);
  }
});

export type IssueRelayVerdictV1 =
  | {
      readonly schemaVersion: 'jinn-issue-relay-verdict.v1';
      readonly outcome: 'pass';
      readonly correlation: IssueRelayCorrelationV1;
      readonly evaluatedHead: string;
      readonly summary: string;
      readonly findings: readonly [];
    }
  | {
      readonly schemaVersion: 'jinn-issue-relay-verdict.v1';
      readonly outcome: 'request-changes';
      readonly correlation: IssueRelayCorrelationV1;
      readonly evaluatedHead: string;
      readonly summary: string;
      readonly findings: readonly IssueRelayFindingV1[];
    }
  | {
      readonly schemaVersion: 'jinn-issue-relay-verdict.v1';
      readonly outcome: 'human' | 'unresolved';
      readonly correlation: IssueRelayCorrelationV1;
      readonly evaluatedHead: string;
      readonly summary: string;
      readonly findings: readonly [];
    };

const verdictCommonFields = {
  schemaVersion: z.literal('jinn-issue-relay-verdict.v1'),
  correlation: IssueRelayCorrelationV1Schema,
  evaluatedHead: GitOidSchema,
  summary: boundedText(MAX_FINDING_DETAIL_BYTES, 'Verdict summary'),
};

export const IssueRelayVerdictV1Schema = z.union([
  z.object({
    ...verdictCommonFields,
    outcome: z.literal('pass'),
    findings: z.array(IssueRelayFindingV1Schema).length(0),
  }).strict(),
  z.object({
    ...verdictCommonFields,
    outcome: z.literal('request-changes'),
    findings: z.array(IssueRelayFindingV1Schema).min(1).max(MAX_FINDINGS),
  }).strict(),
  z.object({
    ...verdictCommonFields,
    outcome: z.enum(['human', 'unresolved']),
    findings: z.array(IssueRelayFindingV1Schema).length(0),
  }).strict(),
]);
