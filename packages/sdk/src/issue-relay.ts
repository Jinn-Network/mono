import { createHash } from 'node:crypto';
import { z } from 'zod/v3';
import { GitHubRepositorySlugSchema } from './autopilot-session.js';

export const ISSUE_RELAY_MAX_FINDINGS = 50;
export const ISSUE_RELAY_MAX_ACCEPTANCE_ITEMS = 50;
export const ISSUE_RELAY_MAX_CHECKS = 100;
export const ISSUE_RELAY_MAX_FINDING_TITLE_BYTES = 240;
export const ISSUE_RELAY_MAX_FINDING_DETAIL_BYTES = 8 * 1024;
export const ISSUE_RELAY_MAX_REPOSITORY_BYTES = 200;
export const ISSUE_RELAY_MAX_PATCH_BYTES = 2 * 1024 * 1024;
export const ISSUE_RELAY_MAX_PR_TITLE_BYTES = 256;
export const ISSUE_RELAY_MAX_PR_BODY_BYTES = 64 * 1024;

const MAX_FINDINGS = ISSUE_RELAY_MAX_FINDINGS;
const MAX_FINDING_TITLE_BYTES = ISSUE_RELAY_MAX_FINDING_TITLE_BYTES;
const MAX_FINDING_DETAIL_BYTES = ISSUE_RELAY_MAX_FINDING_DETAIL_BYTES;
const MAX_REPOSITORY_BYTES = ISSUE_RELAY_MAX_REPOSITORY_BYTES;

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
  findings: z.array(IssueRelayFindingV1Schema).length(0),
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

/** RFC 8785-compatible serialization for the JSON values used by Relay receipts. */
function canonicalJson(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return `{${keys
      .map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function hashAcceptedAdoptionReceipt(
  receipt: z.infer<typeof AcceptedIssueRelayAdoptionReceiptV1Schema>,
): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(canonicalJson(receipt)).digest('hex')}`;
}

export const IssueRelayEvaluationContextV1Schema = z.object({
  schemaVersion: z.literal('jinn-issue-relay-evaluation-context.v1'),
  goal: z.object({
    snapshotDigest: Sha256DigestSchema,
    problemStatement: boundedText(MAX_FINDING_DETAIL_BYTES, 'Problem statement'),
    acceptanceEvidence: z.array(
      boundedText(MAX_FINDING_DETAIL_BYTES, 'Acceptance evidence'),
    ).max(ISSUE_RELAY_MAX_ACCEPTANCE_ITEMS),
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
    }).strict()).max(ISSUE_RELAY_MAX_CHECKS),
    optional: z.array(z.object({
      name: CheckNameSchema,
      status: z.enum(['passed', 'failed', 'pending']),
      url: OptionalCheckUrlSchema,
    }).strict()).max(ISSUE_RELAY_MAX_CHECKS),
  }).strict(),
}).strict().superRefine((value, ctx) => {
  const reject = (path: Array<string | number>, message: string): void => {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path, message });
  };
  const { round, correlation, reviewTarget, adoptionReceipt, evaluationAnchor } = value;
  const expectedAdoptionReceiptDigest = hashAcceptedAdoptionReceipt(adoptionReceipt);

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
    [adoptionReceipt.inputHead, round.inputHead, ['adoptionReceipt', 'inputHead'], 'input head'],
  ];
  if (round.purpose === 'repair') {
    roundBindings.push(
      [
        reviewTarget.workspaceRepository,
        round.workspaceRepository,
        ['reviewTarget', 'workspaceRepository'],
        'workspace repository',
      ],
      [
        reviewTarget.prNumber,
        round.prNumber,
        ['reviewTarget', 'prNumber'],
        'PR number',
      ],
    );
  }
  for (const [actual, expected, path, label] of roundBindings) {
    if (actual !== expected) reject(path, `Evaluation ${label} must match round`);
  }
  const receiptBindings: Array<[unknown, unknown, Array<string | number>, string]> = [
    [adoptionReceipt.targetRepository, reviewTarget.targetRepository, ['adoptionReceipt', 'targetRepository'], 'target repository'],
    [adoptionReceipt.workspaceRepository, reviewTarget.workspaceRepository, ['adoptionReceipt', 'workspaceRepository'], 'workspace repository'],
    [adoptionReceipt.issueNumber, reviewTarget.issueNumber, ['adoptionReceipt', 'issueNumber'], 'issue number'],
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
    [evaluationAnchor.adoptionReceiptDigest, expectedAdoptionReceiptDigest, ['evaluationAnchor', 'adoptionReceiptDigest'], 'adoption receipt digest'],
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

// ---------------------------------------------------------------------------
// Issue Relay V2 portable protocol
// ---------------------------------------------------------------------------

const ISSUE_RELAY_MAX_DECISION_OPTIONS = 4;
const ISSUE_RELAY_MAX_OPTION_ITEMS = 8;
const OptionIdSchema = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  .refine(
    (value) => new TextEncoder().encode(value).byteLength <= MAX_FINDING_TITLE_BYTES,
    `Option ID must be no larger than ${MAX_FINDING_TITLE_BYTES} UTF-8 bytes`,
  );

export const IssueRelayEvaluationLaneSchema = z.enum(['security', 'quality']);
export type IssueRelayEvaluationLane = z.infer<typeof IssueRelayEvaluationLaneSchema>;

export const IssueRelayLaneFindingV1Schema = z.object({
  findingId: OptionIdSchema,
  lane: IssueRelayEvaluationLaneSchema,
  code: SingleLineSchema(MAX_FINDING_TITLE_BYTES, 'Lane finding code'),
  severity: z.enum(['low', 'medium', 'high', 'critical']),
  title: SingleLineSchema(MAX_FINDING_TITLE_BYTES, 'Lane finding title'),
  publicDetail: boundedText(MAX_FINDING_DETAIL_BYTES, 'Lane finding public detail'),
  path: boundedText(MAX_FINDING_DETAIL_BYTES, 'Lane finding path').optional(),
  sensitivity: z.enum(['public', 'restricted']),
}).strict();
export type IssueRelayLaneFindingV1 = z.infer<typeof IssueRelayLaneFindingV1Schema>;

export const IssueRelayAutomatedEvidenceV1Schema = z.object({
  tool: SingleLineSchema(MAX_FINDING_TITLE_BYTES, 'Automated evidence tool'),
  version: SingleLineSchema(MAX_FINDING_TITLE_BYTES, 'Automated evidence version'),
  status: z.enum(['passed', 'findings']),
  digest: Sha256DigestSchema,
  summary: boundedText(MAX_FINDING_DETAIL_BYTES, 'Automated evidence summary'),
}).strict();
export type IssueRelayAutomatedEvidenceV1 = z.infer<
  typeof IssueRelayAutomatedEvidenceV1Schema
>;

export const IssueRelayPullRequestMetadataV1Schema = z.object({
  title: SingleLineSchema(ISSUE_RELAY_MAX_PR_TITLE_BYTES, 'Pull request title'),
  body: boundedText(ISSUE_RELAY_MAX_PR_BODY_BYTES, 'Pull request body'),
}).strict();
export type IssueRelayPullRequestMetadataV1 = z.infer<
  typeof IssueRelayPullRequestMetadataV1Schema
>;

export function issueRelayPullRequestMetadataDigest(
  metadata: IssueRelayPullRequestMetadataV1,
): `sha256:${string}` {
  return issueRelayCanonicalDigest(IssueRelayPullRequestMetadataV1Schema.parse(metadata));
}

export const IssueRelaySolutionV2Schema = z.object({
  schemaVersion: z.literal('jinn-issue-relay-solution.v2'),
  patch: boundedText(ISSUE_RELAY_MAX_PATCH_BYTES, 'Issue Relay patch'),
  pullRequest: IssueRelayPullRequestMetadataV1Schema,
}).strict().superRefine((solution, ctx) => {
  if (solution.pullRequest.title !== solution.pullRequest.title.trim()) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['pullRequest', 'title'],
      message: 'Solution pull request title must not contain leading or trailing whitespace',
    });
  }
  if (solution.pullRequest.body !== solution.pullRequest.body.trim()) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['pullRequest', 'body'],
      message: 'Solution pull request body must not contain leading or trailing whitespace',
    });
  }
  if (solution.pullRequest.body.includes('<!-- jinn-issue-relay:pull-request:')) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['pullRequest', 'body'],
      message: 'Solution pull request body must not contain reserved Relay marker content',
    });
  }
  if (
    new TextEncoder().encode(solution.pullRequest.body).byteLength
      > ISSUE_RELAY_MAX_PR_BODY_BYTES - 1024
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['pullRequest', 'body'],
      message: 'Solution pull request body must reserve space for Relay authority metadata',
    });
  }
});
export type IssueRelaySolutionV2 = z.infer<typeof IssueRelaySolutionV2Schema>;

export const IssueRelayPublicEvidenceDescriptorV1Schema = z.object({
  label: SingleLineSchema(MAX_FINDING_TITLE_BYTES, 'Evidence label'),
  digest: Sha256DigestSchema,
  summary: boundedText(MAX_FINDING_DETAIL_BYTES, 'Evidence summary'),
  url: z.string().url().optional(),
}).strict();
export type IssueRelayPublicEvidenceDescriptorV1 = z.infer<
  typeof IssueRelayPublicEvidenceDescriptorV1Schema
>;

export const IssueRelayImplementationPolicySchema = z.enum([
  'implement-before-decision',
  'decision-before-implementation',
  'recommendation-only',
]);
export type IssueRelayImplementationPolicy = z.infer<
  typeof IssueRelayImplementationPolicySchema
>;

export const IssueRelayDecisionOptionV1Schema = z.object({
  optionId: OptionIdSchema,
  title: SingleLineSchema(MAX_FINDING_TITLE_BYTES, 'Decision option title'),
  description: boundedText(MAX_FINDING_DETAIL_BYTES, 'Decision option description'),
  effect: z.enum([
    'implement-change',
    'retain-current-change',
    'accept-noncritical-risk',
    'clarify-scope',
    'cancel',
  ]),
  implementationBrief: boundedText(
    MAX_FINDING_DETAIL_BYTES,
    'Decision option implementation brief',
  ).optional(),
  consequences: z.array(
    boundedText(MAX_FINDING_DETAIL_BYTES, 'Decision option consequence'),
  ).min(1).max(ISSUE_RELAY_MAX_OPTION_ITEMS),
  tradeoffs: z.array(
    boundedText(MAX_FINDING_DETAIL_BYTES, 'Decision option tradeoff'),
  ).min(1).max(ISSUE_RELAY_MAX_OPTION_ITEMS),
}).strict().superRefine((option, ctx) => {
  if (option.effect === 'implement-change' && option.implementationBrief === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['implementationBrief'],
      message: 'An implementation option requires a bounded implementation brief',
    });
  }
  if (option.effect !== 'implement-change' && option.implementationBrief !== undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['implementationBrief'],
      message: 'Only implementation options may carry an implementation brief',
    });
  }
});
export type IssueRelayDecisionOptionV1 = z.infer<typeof IssueRelayDecisionOptionV1Schema>;

export const IssueRelayDecisionProposalV1Schema = z.object({
  schemaVersion: z.literal('jinn-issue-relay-decision-proposal.v1'),
  lane: IssueRelayEvaluationLaneSchema,
  reasonCode: OptionIdSchema,
  question: boundedText(MAX_FINDING_DETAIL_BYTES, 'Decision question'),
  authorityCategory: z.enum([
    'authorising-maintainer',
    'repository-admin',
    'security-owner',
    'budget-owner',
  ]),
  whyHumanAuthorityIsRequired: boundedText(
    MAX_FINDING_DETAIL_BYTES,
    'Human authority explanation',
  ),
  supportingEvidence: z.array(IssueRelayPublicEvidenceDescriptorV1Schema)
    .max(ISSUE_RELAY_MAX_OPTION_ITEMS),
  options: z.array(IssueRelayDecisionOptionV1Schema)
    .min(2)
    .max(ISSUE_RELAY_MAX_DECISION_OPTIONS),
  recommendedOptionId: OptionIdSchema,
  recommendationRationale: boundedText(
    MAX_FINDING_DETAIL_BYTES,
    'Recommendation rationale',
  ),
  recommendationConfidence: z.enum(['low', 'medium', 'high']),
  proposedImplementationPolicy: IssueRelayImplementationPolicySchema,
}).strict().superRefine((proposal, ctx) => {
  const optionIds = proposal.options.map(({ optionId }) => optionId);
  if (new Set(optionIds).size !== optionIds.length) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['options'],
      message: 'Decision option IDs must be unique',
    });
  }
  if (!optionIds.includes(proposal.recommendedOptionId)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['recommendedOptionId'],
      message: 'Recommended option must name one declared option',
    });
  }
  if (
    proposal.lane === 'quality'
    && proposal.authorityCategory === 'security-owner'
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['authorityCategory'],
      message: 'A quality decision cannot request security-owner authority',
    });
  }
});
export type IssueRelayDecisionProposalV1 = z.infer<
  typeof IssueRelayDecisionProposalV1Schema
>;

export function issueRelayCanonicalDigest(value: unknown): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
}

export function issueRelayDecisionKey(input: {
  readonly generation: string;
  readonly snapshotDigest: string;
  readonly proposal: IssueRelayDecisionProposalV1;
}): `sha256:${string}` {
  const proposal = IssueRelayDecisionProposalV1Schema.parse(input.proposal);
  const snapshotDigest = Sha256DigestSchema.parse(input.snapshotDigest);
  return issueRelayCanonicalDigest({
    generation: input.generation,
    snapshotDigest,
    lane: proposal.lane,
    reasonCode: proposal.reasonCode,
    normalizedQuestion: proposal.question.trim().replace(/\s+/g, ' '),
    options: [...proposal.options]
      .map(({ optionId, effect }) => ({ optionId, effect }))
      .sort((left, right) => left.optionId.localeCompare(right.optionId, 'en-US')),
  });
}

const DecisionBindingV1Schema = z.object({
  decisionKey: Sha256DigestSchema,
  proposalDigest: Sha256DigestSchema,
  requestDigest: Sha256DigestSchema.optional(),
  optionId: OptionIdSchema,
  authorization: z.enum([
    'repository-policy-safe-preimplementation',
    'human-option-intent',
  ]),
  sourceHead: GitOidSchema,
  frozenImplementationBrief: boundedText(
    MAX_FINDING_DETAIL_BYTES,
    'Frozen implementation brief',
  ),
}).strict().superRefine((binding, ctx) => {
  if (
    binding.authorization === 'human-option-intent'
    && binding.requestDigest === undefined
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['requestDigest'],
      message: 'Human-authorized implementation must bind its decision request',
    });
  }
  if (
    binding.authorization === 'repository-policy-safe-preimplementation'
    && binding.requestDigest !== undefined
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['requestDigest'],
      message: 'Preimplementation occurs before a head-bound decision request exists',
    });
  }
});

const roundV2CommonFields = {
  schemaVersion: z.literal('jinn-issue-relay-round.v2'),
  generation: boundedText(MAX_FINDING_DETAIL_BYTES, 'Generation'),
  round: NonNegativeSafeIntegerSchema,
  snapshotDigest: Sha256DigestSchema,
  targetRepository: RepositorySchema,
  workspaceRepository: RepositorySchema,
  inputHead: GitOidSchema,
};

export const IssueRelayRoundV2Schema = z.discriminatedUnion('purpose', [
  z.object({
    ...roundV2CommonFields,
    purpose: z.literal('initial'),
    findings: z.array(IssueRelayLaneFindingV1Schema).length(0),
    prNumber: z.never().optional(),
    decisionBinding: z.never().optional(),
  }).strict(),
  z.object({
    ...roundV2CommonFields,
    purpose: z.literal('repair'),
    findings: z.array(IssueRelayLaneFindingV1Schema).min(1).max(MAX_FINDINGS),
    prNumber: PositiveIntegerSchema,
    decisionBinding: z.never().optional(),
  }).strict(),
  z.object({
    ...roundV2CommonFields,
    purpose: z.literal('decision-implementation'),
    findings: z.array(IssueRelayLaneFindingV1Schema).length(0),
    prNumber: PositiveIntegerSchema,
    decisionBinding: DecisionBindingV1Schema,
  }).strict(),
]);
export type IssueRelayRoundV2 = z.infer<typeof IssueRelayRoundV2Schema>;

const IssueRelayPriorDecisionV1Schema = z.object({
  decisionKey: Sha256DigestSchema,
  lane: IssueRelayEvaluationLaneSchema,
  optionId: OptionIdSchema,
  implementationRound: NonNegativeSafeIntegerSchema,
  requestDigest: Sha256DigestSchema.optional(),
  humanDecisionReceiptDigest: Sha256DigestSchema.optional(),
  authorization: z.enum([
    'repository-policy-safe-preimplementation',
    'human-option-intent',
  ]),
}).strict().superRefine((decision, ctx) => {
  if (
    decision.authorization === 'human-option-intent'
    && (
      decision.requestDigest === undefined
      || decision.humanDecisionReceiptDigest === undefined
    )
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Human option intent requires its request and decision receipt digests',
    });
  }
});

export const IssueRelayEvaluationContextV2Schema = z.object({
  schemaVersion: z.literal('jinn-issue-relay-evaluation-context.v2'),
  goal: z.object({
    snapshotDigest: Sha256DigestSchema,
    problemStatement: boundedText(MAX_FINDING_DETAIL_BYTES, 'Problem statement'),
    acceptanceEvidence: z.array(
      boundedText(MAX_FINDING_DETAIL_BYTES, 'Acceptance evidence'),
    ).max(ISSUE_RELAY_MAX_ACCEPTANCE_ITEMS),
    verificationProfile: z.literal('jinn-mono.v1'),
  }).strict(),
  operators: z.object({
    solutionSafe: SafeAddressSchema,
    evaluatorSafe: SafeAddressSchema,
  }).strict(),
  round: IssueRelayRoundV2Schema,
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
    pullRequest: IssueRelayPullRequestMetadataV1Schema.extend({
      digest: Sha256DigestSchema,
    }).strict(),
  }).strict(),
  adoptionReceipt: AcceptedIssueRelayAdoptionReceiptV1Schema,
  evaluationAnchor: IssueRelayEvaluationAnchorV1Schema,
  checks: z.object({
    digest: Sha256DigestSchema,
    required: z.array(z.object({
      name: CheckNameSchema,
      status: z.literal('passed'),
      url: OptionalCheckUrlSchema,
    }).strict()).max(ISSUE_RELAY_MAX_CHECKS),
    optional: z.array(z.object({
      name: CheckNameSchema,
      status: z.enum(['passed', 'failed', 'pending']),
      url: OptionalCheckUrlSchema,
    }).strict()).max(ISSUE_RELAY_MAX_CHECKS),
  }).strict(),
  laneSpecifications: z.object({
    security: Sha256DigestSchema,
    quality: Sha256DigestSchema,
  }).strict(),
  priorDecisions: z.array(IssueRelayPriorDecisionV1Schema).max(100),
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
  if (
    reviewTarget.pullRequest.digest
      !== issueRelayPullRequestMetadataDigest({
        title: reviewTarget.pullRequest.title,
        body: reviewTarget.pullRequest.body,
      })
  ) {
    reject(
      ['reviewTarget', 'pullRequest', 'digest'],
      'Pull request metadata digest must match its exact title and body',
    );
  }
  if (value.operators.solutionSafe.toLowerCase() !== adoptionReceipt.solutionSafe.toLowerCase()) {
    reject(['operators', 'solutionSafe'], 'Solution Safe must match the adoption receipt');
  }
  if (!correlationsMatch(correlation, adoptionReceipt.correlation)) {
    reject(['adoptionReceipt', 'correlation'], 'Adoption receipt correlation must match context');
  }
  if (!correlationsMatch(correlation, evaluationAnchor.correlation)) {
    reject(['evaluationAnchor', 'correlation'], 'Evaluation anchor correlation must match context');
  }
  const bindings: Array<[unknown, unknown, Array<string | number>, string]> = [
    [reviewTarget.targetRepository, round.targetRepository, ['reviewTarget', 'targetRepository'], 'target repository'],
    [adoptionReceipt.inputHead, round.inputHead, ['adoptionReceipt', 'inputHead'], 'input head'],
    [adoptionReceipt.targetRepository, reviewTarget.targetRepository, ['adoptionReceipt', 'targetRepository'], 'target repository'],
    [adoptionReceipt.workspaceRepository, reviewTarget.workspaceRepository, ['adoptionReceipt', 'workspaceRepository'], 'workspace repository'],
    [adoptionReceipt.issueNumber, reviewTarget.issueNumber, ['adoptionReceipt', 'issueNumber'], 'issue number'],
    [adoptionReceipt.prNumber, reviewTarget.prNumber, ['adoptionReceipt', 'prNumber'], 'PR number'],
    [adoptionReceipt.headRef, reviewTarget.headRef, ['adoptionReceipt', 'headRef'], 'head ref'],
    [adoptionReceipt.resultingHead, reviewTarget.evaluatedHead, ['adoptionReceipt', 'resultingHead'], 'evaluated head'],
    [evaluationAnchor.targetRepository, reviewTarget.targetRepository, ['evaluationAnchor', 'targetRepository'], 'target repository'],
    [evaluationAnchor.workspaceRepository, reviewTarget.workspaceRepository, ['evaluationAnchor', 'workspaceRepository'], 'workspace repository'],
    [evaluationAnchor.prNumber, reviewTarget.prNumber, ['evaluationAnchor', 'prNumber'], 'PR number'],
    [evaluationAnchor.targetBase, reviewTarget.targetBase, ['evaluationAnchor', 'targetBase'], 'target base'],
    [evaluationAnchor.baseOid, reviewTarget.baseOid, ['evaluationAnchor', 'baseOid'], 'base OID'],
    [evaluationAnchor.headRef, reviewTarget.headRef, ['evaluationAnchor', 'headRef'], 'head ref'],
    [evaluationAnchor.evaluatedHead, reviewTarget.evaluatedHead, ['evaluationAnchor', 'evaluatedHead'], 'evaluated head'],
    [evaluationAnchor.adoptionReceiptDigest, hashAcceptedAdoptionReceipt(adoptionReceipt), ['evaluationAnchor', 'adoptionReceiptDigest'], 'adoption receipt digest'],
    [evaluationAnchor.checksDigest, value.checks.digest, ['evaluationAnchor', 'checksDigest'], 'checks digest'],
  ];
  if (round.purpose !== 'initial') {
    bindings.push(
      [reviewTarget.workspaceRepository, round.workspaceRepository, ['reviewTarget', 'workspaceRepository'], 'workspace repository'],
      [reviewTarget.prNumber, round.prNumber, ['reviewTarget', 'prNumber'], 'PR number'],
    );
  }
  for (const [actual, expected, path, label] of bindings) {
    if (actual !== expected) reject(path, `Evaluation ${label} must match V2 context`);
  }
  const seen = new Set<string>();
  for (const [index, decision] of value.priorDecisions.entries()) {
    const identity = `${decision.decisionKey}:${decision.optionId}`;
    if (seen.has(identity)) {
      reject(['priorDecisions', index], 'Decision option lineage cannot repeat');
    }
    seen.add(identity);
  }
});
export type IssueRelayEvaluationContextV2 = z.infer<
  typeof IssueRelayEvaluationContextV2Schema
>;

export function issueRelayEvaluationContextV2Digest(
  context: IssueRelayEvaluationContextV2,
): `sha256:${string}` {
  return issueRelayCanonicalDigest(IssueRelayEvaluationContextV2Schema.parse(context));
}

const laneOutcomeSchema = z.union([
  z.object({
    kind: z.literal('pass'),
    findings: z.array(IssueRelayLaneFindingV1Schema).length(0),
  }).strict(),
  z.object({
    kind: z.literal('changes-required'),
    findings: z.array(IssueRelayLaneFindingV1Schema).min(1).max(MAX_FINDINGS),
  }).strict(),
  z.object({
    kind: z.literal('decision-required'),
    proposal: IssueRelayDecisionProposalV1Schema,
    findings: z.array(IssueRelayLaneFindingV1Schema).length(0),
  }).strict(),
  z.object({
    kind: z.literal('critical-block'),
    publicSummary: boundedText(MAX_FINDING_DETAIL_BYTES, 'Critical block public summary'),
    restrictedEvidencePresent: z.boolean(),
    restrictedEvidenceDigest: Sha256DigestSchema.optional(),
    findings: z.array(IssueRelayLaneFindingV1Schema).length(0),
  }).strict().superRefine((outcome, ctx) => {
    if (outcome.restrictedEvidencePresent !== (outcome.restrictedEvidenceDigest !== undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['restrictedEvidenceDigest'],
        message: 'Restricted-evidence presence must agree with its digest',
      });
    }
  }),
]);

export const IssueRelayLaneAttestationV1Schema = z.object({
  schemaVersion: z.literal('jinn-issue-relay-lane-attestation.v1'),
  lane: IssueRelayEvaluationLaneSchema,
  correlation: IssueRelayCorrelationV1Schema,
  evaluatedHead: GitOidSchema,
  evaluationContextDigest: Sha256DigestSchema,
  evaluationAnchorDigest: Sha256DigestSchema,
  adoptionReceiptDigest: Sha256DigestSchema,
  checksDigest: Sha256DigestSchema,
  pullRequestMetadataDigest: Sha256DigestSchema,
  evaluationSpecificationDigest: Sha256DigestSchema,
  automatedEvidence: z.array(IssueRelayAutomatedEvidenceV1Schema).max(20).optional(),
  outcome: laneOutcomeSchema,
  decisionAssessment: z.object({
    decisionKey: Sha256DigestSchema,
    optionId: OptionIdSchema,
    implementationRound: NonNegativeSafeIntegerSchema,
    status: z.enum(['conforms', 'does-not-conform']),
  }).strict().optional(),
  publicSummary: boundedText(MAX_FINDING_DETAIL_BYTES, 'Lane attestation public summary'),
}).strict().superRefine((attestation, ctx) => {
  if (attestation.outcome.kind === 'critical-block' && attestation.lane !== 'security') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['outcome', 'kind'],
      message: 'Only security evaluation may produce a critical block',
    });
  }
  if (
    attestation.outcome.kind === 'decision-required'
    && attestation.outcome.proposal.lane !== attestation.lane
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['outcome', 'proposal', 'lane'],
      message: 'Decision proposal lane must match its attestation lane',
    });
  }
  if (
    attestation.outcome.kind === 'changes-required'
    && attestation.outcome.findings.some(({ lane }) => lane !== attestation.lane)
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['outcome', 'findings'],
      message: 'All findings must retain their producing lane',
    });
  }
  if (
    attestation.decisionAssessment?.status === 'does-not-conform'
    && attestation.outcome.kind !== 'changes-required'
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['decisionAssessment', 'status'],
      message: 'A nonconforming implementation must produce actionable changes',
    });
  }
});
export type IssueRelayLaneAttestationV1 = z.infer<
  typeof IssueRelayLaneAttestationV1Schema
>;

export const IssueRelayLaneFailureV1Schema = z.object({
  schemaVersion: z.literal('jinn-issue-relay-lane-failure.v1'),
  lane: IssueRelayEvaluationLaneSchema,
  evaluatedHead: GitOidSchema,
  evaluationContextDigest: Sha256DigestSchema,
  pullRequestMetadataDigest: Sha256DigestSchema,
  reason: z.enum([
    'provider-unavailable',
    'checkout-failed',
    'malformed-output',
    'missing-evidence',
    'deadline',
    'capability-limit',
  ]),
  recovery: z.enum(['retry-same', 'reroute', 'operator']),
  publicSummary: boundedText(MAX_FINDING_DETAIL_BYTES, 'Lane failure public summary'),
}).strict();
export type IssueRelayLaneFailureV1 = z.infer<typeof IssueRelayLaneFailureV1Schema>;

const laneObservationSchema = z.union([
  IssueRelayLaneAttestationV1Schema,
  IssueRelayLaneFailureV1Schema,
]);

function expectedBundleProjection(bundle: {
  readonly lanes: {
    readonly security: z.infer<typeof laneObservationSchema>;
    readonly quality: z.infer<typeof laneObservationSchema>;
  };
}): 'pass' | 'fail' | 'unresolved' {
  const observations = [bundle.lanes.security, bundle.lanes.quality];
  if (observations.some((observation) =>
    observation.schemaVersion === 'jinn-issue-relay-lane-attestation.v1'
    && (
      observation.outcome.kind === 'changes-required'
      || observation.outcome.kind === 'critical-block'
    ))) {
    return 'fail';
  }
  if (observations.every((observation) =>
    observation.schemaVersion === 'jinn-issue-relay-lane-attestation.v1'
    && observation.outcome.kind === 'pass')) {
    return 'pass';
  }
  return 'unresolved';
}

export const IssueRelayEvaluationBundleV2Schema = z.object({
  schemaVersion: z.literal('jinn-issue-relay-evaluation-bundle.v2'),
  correlation: IssueRelayCorrelationV1Schema,
  evaluatedHead: GitOidSchema,
  evaluationContextDigest: Sha256DigestSchema,
  lanes: z.object({
    security: laneObservationSchema,
    quality: laneObservationSchema,
  }).strict(),
  overallProjection: z.enum(['pass', 'fail', 'unresolved']),
}).strict().superRefine((bundle, ctx) => {
  for (const lane of ['security', 'quality'] as const) {
    const observation = bundle.lanes[lane];
    if (observation.lane !== lane) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['lanes', lane, 'lane'],
        message: `The ${lane} slot must contain a ${lane} observation`,
      });
    }
    if (observation.evaluatedHead !== bundle.evaluatedHead) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['lanes', lane, 'evaluatedHead'],
        message: 'Lane observation head must match its bundle',
      });
    }
    if (
      observation.pullRequestMetadataDigest
        !== bundle.lanes.security.pullRequestMetadataDigest
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['lanes', lane, 'pullRequestMetadataDigest'],
        message: 'Both lanes must bind the same exact pull request metadata',
      });
    }
    if (observation.evaluationContextDigest !== bundle.evaluationContextDigest) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['lanes', lane, 'evaluationContextDigest'],
        message: 'Lane evaluation context must match its bundle',
      });
    }
    if (
      observation.schemaVersion === 'jinn-issue-relay-lane-attestation.v1'
      && !correlationsMatch(observation.correlation, bundle.correlation)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['lanes', lane, 'correlation'],
        message: 'Lane attestation correlation must match its bundle',
      });
    }
  }
  if (bundle.overallProjection !== expectedBundleProjection(bundle)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['overallProjection'],
      message: 'Bundle projection must be derived from both lane observations',
    });
  }
});
export type IssueRelayEvaluationBundleV2 = z.infer<
  typeof IssueRelayEvaluationBundleV2Schema
>;

const decisionImplementationSchema = z.object({
  status: z.enum(['not-required', 'not-started', 'in-progress', 'implemented', 'verified']),
  optionId: OptionIdSchema.optional(),
  sourceHead: GitOidSchema.optional(),
  implementedHead: GitOidSchema.optional(),
  implementationRound: NonNegativeSafeIntegerSchema.optional(),
  conformanceAttestationDigest: Sha256DigestSchema.optional(),
}).strict().superRefine((implementation, ctx) => {
  if (implementation.status === 'not-required') {
    if (Object.keys(implementation).some((key) => key !== 'status')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'A no-implementation request cannot carry implementation evidence',
      });
    }
    return;
  }
  if (implementation.optionId === undefined || implementation.sourceHead === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Implementation state must identify its option and source head',
    });
  }
  if (
    ['implemented', 'verified'].includes(implementation.status)
    && (
      implementation.implementedHead === undefined
      || implementation.implementationRound === undefined
    )
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Implemented state requires the resulting head and round',
    });
  }
  if (
    implementation.status === 'verified'
    && implementation.conformanceAttestationDigest === undefined
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Verified implementation requires its conformance attestation',
    });
  }
});

const decisionRequestFields = {
  schemaVersion: z.literal('jinn-issue-relay-decision-request.v1'),
  decisionKey: Sha256DigestSchema,
  generation: boundedText(MAX_FINDING_DETAIL_BYTES, 'Generation'),
  round: NonNegativeSafeIntegerSchema,
  snapshotDigest: Sha256DigestSchema,
  exactHead: GitOidSchema,
  lane: IssueRelayEvaluationLaneSchema,
  proposal: IssueRelayDecisionProposalV1Schema,
  effectiveImplementationPolicy: IssueRelayImplementationPolicySchema,
  implementation: decisionImplementationSchema,
  requiredRole: z.enum([
    'original-authorising-maintainer',
    'current-repository-admin',
  ]),
  allowedActions: z.array(z.enum([
    'select-option',
    'clarify-scope',
    'cancel',
    'defer',
  ])).min(1).max(4),
  createdAt: IsoTimestampSchema,
  expiresAt: IsoTimestampSchema,
};

export function issueRelayDecisionRequestDigest(
  input: Record<string, unknown>,
): `sha256:${string}` {
  const { requestDigest: _ignored, ...unsigned } = input;
  return issueRelayCanonicalDigest(unsigned);
}

export const IssueRelayDecisionRequestV1Schema = z.object({
  ...decisionRequestFields,
  requestDigest: Sha256DigestSchema,
}).strict().superRefine((request, ctx) => {
  if (request.decisionKey !== issueRelayDecisionKey({
    generation: request.generation,
    snapshotDigest: request.snapshotDigest,
    proposal: request.proposal,
  })) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['decisionKey'],
      message: 'Decision key must match the stable proposal identity',
    });
  }
  if (request.proposal.lane !== request.lane) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['proposal', 'lane'],
      message: 'Decision proposal lane must match its request',
    });
  }
  if (new Set(request.allowedActions).size !== request.allowedActions.length) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['allowedActions'],
      message: 'Allowed actions must be unique',
    });
  }
  if (Date.parse(request.expiresAt) <= Date.parse(request.createdAt)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['expiresAt'],
      message: 'Decision expiry must be after creation',
    });
  }
  if (request.requestDigest !== issueRelayDecisionRequestDigest(request)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['requestDigest'],
      message: 'Decision request digest must cover the exact canonical request',
    });
  }
});
export type IssueRelayDecisionRequestV1 = z.infer<
  typeof IssueRelayDecisionRequestV1Schema
>;

const humanDecisionFields = {
  schemaVersion: z.literal('jinn-issue-relay-human-decision.v1'),
  requestDigest: Sha256DigestSchema,
  decisionKey: Sha256DigestSchema,
  generation: boundedText(MAX_FINDING_DETAIL_BYTES, 'Generation'),
  round: NonNegativeSafeIntegerSchema,
  snapshotDigest: Sha256DigestSchema,
  requestHead: GitOidSchema,
  lane: IssueRelayEvaluationLaneSchema,
  action: z.enum(['select-option', 'clarify-scope', 'cancel', 'defer']),
  selectedOptionId: OptionIdSchema.optional(),
  binding: z.enum(['exact-head-acceptance', 'option-intent']),
  actor: z.object({
    githubLogin: SingleLineSchema(MAX_FINDING_TITLE_BYTES, 'GitHub login'),
    githubUserId: SingleLineSchema(MAX_FINDING_DETAIL_BYTES, 'GitHub user ID'),
  }).strict(),
  authority: z.object({
    requiredRole: z.enum([
      'original-authorising-maintainer',
      'current-repository-admin',
    ]),
    observedPermission: z.enum(['WRITE', 'MAINTAIN', 'ADMIN']),
    checkedAt: IsoTimestampSchema,
  }).strict(),
  sourceComment: z.object({
    commentId: PositiveIntegerSchema,
    nodeId: SingleLineSchema(MAX_FINDING_DETAIL_BYTES, 'GitHub comment node ID'),
    bodyDigest: Sha256DigestSchema,
    createdAt: IsoTimestampSchema,
    updatedAt: IsoTimestampSchema,
  }).strict(),
  rationale: boundedText(MAX_FINDING_DETAIL_BYTES, 'Human rationale').optional(),
  decidedAt: IsoTimestampSchema,
};

export function issueRelayHumanDecisionReceiptDigest(
  input: Record<string, unknown>,
): `sha256:${string}` {
  const { receiptDigest: _ignored, ...unsigned } = input;
  return issueRelayCanonicalDigest(unsigned);
}

export const IssueRelayHumanDecisionReceiptV1Schema = z.object({
  ...humanDecisionFields,
  receiptDigest: Sha256DigestSchema,
}).strict().superRefine((receipt, ctx) => {
  if ((receipt.action === 'select-option') !== (receipt.selectedOptionId !== undefined)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['selectedOptionId'],
      message: 'Only an option selection may carry a selected option ID',
    });
  }
  if (receipt.sourceComment.createdAt !== receipt.sourceComment.updatedAt) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['sourceComment', 'updatedAt'],
      message: 'Edited GitHub commands cannot become decision receipts',
    });
  }
  if (
    receipt.authority.requiredRole === 'current-repository-admin'
    && receipt.authority.observedPermission !== 'ADMIN'
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['authority', 'observedPermission'],
      message: 'Repository-admin decisions require current ADMIN permission',
    });
  }
  if (receipt.receiptDigest !== issueRelayHumanDecisionReceiptDigest(receipt)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['receiptDigest'],
      message: 'Human decision digest must cover the exact canonical receipt',
    });
  }
});
export type IssueRelayHumanDecisionReceiptV1 = z.infer<
  typeof IssueRelayHumanDecisionReceiptV1Schema
>;
