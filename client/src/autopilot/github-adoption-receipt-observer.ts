import {
  AutopilotCorrelationSchema,
  AutopilotReviewResultSchema,
  JinnRepoTaskSchema,
  bindAutopilotMutationDeliveryResult,
  parseAutopilotAdoptionReceiptComment,
  type AutopilotAdoptionReceipt,
  type AutopilotAdoptionRejectionReason,
  type AutopilotCorrelation,
  type AutopilotMutationResult,
  type AutopilotReviewResult,
  type AutopilotSessionCapsule,
} from '@jinn-network/sdk/solvernets/jinn-repo';

import type {
  AdoptionObservation,
  AdoptionReceiptObserver,
  PersistedTaskRun,
} from '../types/task-run.js';

const DEFAULT_MAX_PAGES = 100;

export interface GitHubIssueComment {
  /** Immutable GitHub database identifier. */
  readonly id: number;
  readonly authorLogin: string;
  readonly body: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface GitHubIssueCommentPage {
  readonly comments: readonly GitHubIssueComment[];
  readonly nextCursor?: string;
}

export interface GitHubPullRequestFacts {
  readonly headSha: string;
  readonly labels: readonly string[];
}

export interface GitHubIssueFacts {
  readonly number: number;
  readonly state: 'OPEN' | 'CLOSED';
  readonly body: string;
  readonly labels: readonly string[];
  readonly isPullRequest: boolean;
}

export type GitHubNativeReviewState =
  | 'APPROVED'
  | 'CHANGES_REQUESTED'
  | 'COMMENTED'
  | 'DISMISSED'
  | 'PENDING';

export interface GitHubNativeReview {
  readonly id: number;
  readonly authorLogin: string;
  readonly state: GitHubNativeReviewState;
  readonly commitId: string;
  readonly body: string;
  readonly submittedAt: string;
}

export interface GitHubNativeReviewPage {
  readonly reviews: readonly GitHubNativeReview[];
  readonly nextCursor?: string;
}

export type GitHubReviewClaimState =
  | 'active'
  | 'verdict-intent'
  | 'terminal-approved'
  | 'human'
  | 'stale';

export interface GitHubReviewClaimRecord {
  readonly protocolVersion: 2;
  readonly prNumber: number;
  readonly generation: string;
  readonly attempt: string;
  readonly reviewer: string;
  readonly head: string;
  readonly state: GitHubReviewClaimState;
  readonly recordedAt: string;
  readonly verdict?: {
    readonly state: 'APPROVE' | 'REQUEST_CHANGES';
    readonly marker: string;
  };
}

export interface GitHubReviewAuthority {
  readonly oid: string;
  /** Current record first, followed by its bounded first-parent history. */
  readonly history: readonly {
    readonly oid: string;
    readonly record: GitHubReviewClaimRecord;
  }[];
}

export interface AutopilotGitHubReadPort {
  listPrIssueComments(input: {
    readonly prNumber: number;
    readonly cursor?: string;
  }): Promise<GitHubIssueCommentPage>;
  readPullRequest(prNumber: number): Promise<GitHubPullRequestFacts>;
  readIssue(issueNumber: number): Promise<GitHubIssueFacts>;
  listPullRequestReviews(input: {
    readonly prNumber: number;
    readonly cursor?: string;
  }): Promise<GitHubNativeReviewPage>;
  readReviewAuthority(
    prNumber: number,
    expectedRootOid?: string,
  ): Promise<GitHubReviewAuthority>;
}

type ReceiptRole = AutopilotAdoptionReceipt['role'];
type AcceptedOperation = Extract<
  AutopilotAdoptionReceipt,
  { disposition: 'accepted' }
>['operation'];

export interface ObserveExactAutopilotAdoptionReceiptInput {
  readonly expectedRole: ReceiptRole;
  readonly expectedCorrelation: AutopilotCorrelation;
  readonly receiptAuthors: readonly string[];
  readonly github: AutopilotGitHubReadPort;
  /** Accepted receipts must describe this deterministic adopted operation. */
  readonly expectedAcceptedOperation?: AcceptedOperation;
  /** Human mutation results can never be accepted as evaluable Solutions. */
  readonly acceptedAllowed?: boolean;
  /** When known, bind a rejection to the deterministic policy reason. */
  readonly expectedRejectedReason?: AutopilotAdoptionRejectionReason;
  /** Defaults to 100 and bounds comments and native-review pagination. */
  readonly maxPages?: number;
}

function pending(detail: string): AdoptionObservation {
  return {
    state: 'pending',
    observedAt: new Date().toISOString(),
    detail,
  };
}

function contradictory(detail: string): AdoptionObservation {
  return { state: 'contradictory', detail };
}

function normalizedLogin(value: string): string {
  return value.trim().toLowerCase();
}

function validatePageLimit(value: number | undefined): number {
  const limit = value ?? DEFAULT_MAX_PAGES;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > DEFAULT_MAX_PAGES) {
    throw new Error(
      `Autopilot GitHub observation page bound must be between 1 and ${DEFAULT_MAX_PAGES}`,
    );
  }
  return limit;
}

function sameComment(left: GitHubIssueComment, right: GitHubIssueComment): boolean {
  return left.authorLogin === right.authorLogin
    && left.body === right.body
    && left.createdAt === right.createdAt
    && left.updatedAt === right.updatedAt;
}

async function listAllComments(
  input: ObserveExactAutopilotAdoptionReceiptInput,
): Promise<readonly GitHubIssueComment[]> {
  const limit = validatePageLimit(input.maxPages);
  const byId = new Map<number, GitHubIssueComment>();
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < limit; page += 1) {
    const result = await input.github.listPrIssueComments({
      prNumber: input.expectedCorrelation.prNumber,
      ...(cursor === undefined ? {} : { cursor }),
    });
    for (const comment of result.comments) {
      const existing = byId.get(comment.id);
      if (existing !== undefined && !sameComment(existing, comment)) {
        throw new Error(
          `GitHub comment ${comment.id} changed across immutable pagination`,
        );
      }
      byId.set(comment.id, comment);
    }
    if (result.nextCursor === undefined) return [...byId.values()];
    if (seenCursors.has(result.nextCursor)) {
      throw new Error('GitHub comment pagination repeated a cursor');
    }
    seenCursors.add(result.nextCursor);
    cursor = result.nextCursor;
  }
  throw new Error(`GitHub comment pagination exceeded ${limit} pages`);
}

async function listAllReviews(
  input: ObserveExactAutopilotAdoptionReceiptInput,
): Promise<readonly GitHubNativeReview[]> {
  const limit = validatePageLimit(input.maxPages);
  const byId = new Map<number, GitHubNativeReview>();
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < limit; page += 1) {
    const result = await input.github.listPullRequestReviews({
      prNumber: input.expectedCorrelation.prNumber,
      ...(cursor === undefined ? {} : { cursor }),
    });
    for (const review of result.reviews) {
      const existing = byId.get(review.id);
      if (
        existing !== undefined
        && JSON.stringify(existing) !== JSON.stringify(review)
      ) {
        throw new Error(
          `GitHub review ${review.id} changed across immutable pagination`,
        );
      }
      byId.set(review.id, review);
    }
    if (result.nextCursor === undefined) return [...byId.values()];
    if (seenCursors.has(result.nextCursor)) {
      throw new Error('GitHub review pagination repeated a cursor');
    }
    seenCursors.add(result.nextCursor);
    cursor = result.nextCursor;
  }
  throw new Error(`GitHub review pagination exceeded ${limit} pages`);
}

function receiptCorrelation(
  receipt: AutopilotAdoptionReceipt,
): AutopilotCorrelation {
  return AutopilotCorrelationSchema.parse({
    taskId: receipt.taskId,
    attemptIndex: receipt.attemptIndex,
    requestId: receipt.requestId,
    deliveryEnvelopeCid: receipt.deliveryEnvelopeCid,
    v2AttemptId: receipt.v2AttemptId,
    claimOid: receipt.claimOid,
    prNumber: receipt.prNumber,
    expectedHead: receipt.expectedHead,
    ...(receipt.resultingHead === undefined
      ? {}
      : { resultingHead: receipt.resultingHead }),
    ...(receipt.reviewedHead === undefined
      ? {}
      : { reviewedHead: receipt.reviewedHead }),
    ...(receipt.reviewGeneration === undefined
      ? {}
      : { reviewGeneration: receipt.reviewGeneration }),
    ...(receipt.reviewRefOid === undefined
      ? {}
      : { reviewRefOid: receipt.reviewRefOid }),
  });
}

function matchesStableDelivery(
  receipt: AutopilotAdoptionReceipt,
  input: ObserveExactAutopilotAdoptionReceiptInput,
): boolean {
  const expected = input.expectedCorrelation;
  return receipt.role === input.expectedRole
    && receipt.taskId === expected.taskId
    && receipt.attemptIndex === expected.attemptIndex
    && receipt.requestId === expected.requestId
    && receipt.deliveryEnvelopeCid === expected.deliveryEnvelopeCid
    && receipt.v2AttemptId === expected.v2AttemptId;
}

function matchesExpectedCorrelation(
  receipt: AutopilotAdoptionReceipt,
  expected: AutopilotCorrelation,
): boolean {
  const actual = receiptCorrelation(receipt);
  return ([
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
  ] as const).every((key) => (
    expected[key] === undefined || expected[key] === actual[key]
  ));
}

function expectedReviewState(
  operation: AcceptedOperation,
): GitHubNativeReviewState | undefined {
  if (operation === 'review-verdict') return 'APPROVED';
  if (operation === 'review-findings') return 'CHANGES_REQUESTED';
  return undefined;
}

function expectedLabel(operation: AcceptedOperation): string | undefined {
  if (operation === 'review-verdict') return 'review:approved';
  if (operation === 'review-findings') return 'review:changes-requested';
  if (operation === 'human') return 'review:needs-human';
  return undefined;
}

function effectiveReviews(
  reviews: readonly GitHubNativeReview[],
): readonly GitHubNativeReview[] {
  const latest = new Map<string, GitHubNativeReview>();
  for (const review of [...reviews].sort((left, right) =>
    left.submittedAt.localeCompare(right.submittedAt))) {
    if (
      review.state === 'APPROVED'
      || review.state === 'CHANGES_REQUESTED'
      || review.state === 'DISMISSED'
    ) {
      latest.set(normalizedLogin(review.authorLogin), review);
    }
  }
  return [...latest.values()];
}

function expectedReviewClaimState(
  operation: AcceptedOperation,
): GitHubReviewClaimState {
  if (operation === 'review-verdict') return 'terminal-approved';
  if (operation === 'review-findings') return 'stale';
  return 'human';
}

function automatedReviewMarker(record: GitHubReviewClaimRecord): string | undefined {
  if (record.verdict === undefined) return undefined;
  return `<!-- jinn-autopilot-review:v2 generation=${record.generation} `
    + `attempt=${record.attempt} intent=${record.verdict.marker} `
    + `reviewer=${record.reviewer} head=${record.head} `
    + `verdict=${record.verdict.state} -->`;
}

async function verifyReviewAuthority(
  receipt: Extract<AutopilotAdoptionReceipt, { disposition: 'accepted' }>,
  input: ObserveExactAutopilotAdoptionReceiptInput,
): Promise<{
  readonly problem: string | null;
  readonly verdictRecord?: GitHubReviewClaimRecord;
  readonly currentRecord?: GitHubReviewClaimRecord;
  readonly advancedBeyondReceipt?: boolean;
}> {
  if (
    receipt.reviewGeneration === undefined
    || receipt.reviewRefOid === undefined
  ) {
    return {
      problem: 'accepted receipt omitted exact review generation authority',
    };
  }
  const authority = await input.github.readReviewAuthority(
    receipt.prNumber,
    receipt.reviewRefOid,
  );
  const current = authority.history[0];
  if (current === undefined || current.oid !== authority.oid) {
    return { problem: 'current review authority is not observable' };
  }
  const authors = new Set(input.receiptAuthors.map(normalizedLogin));
  if (receipt.role === 'solution') {
    const exactCurrent =
      authority.oid === receipt.reviewRefOid
      && current.record.protocolVersion === 2
      && current.record.prNumber === receipt.prNumber
      && current.record.generation === receipt.reviewGeneration
      && current.record.head === receipt.resultingHead
      && current.record.state === 'active'
      && authors.has(normalizedLogin(current.record.reviewer));
    return exactCurrent
      ? {
          problem: null,
          currentRecord: current.record,
          advancedBeyondReceipt: false,
        }
      : { problem: 'Solution review generation is not the exact active root' };
  }

  const rootIndex = authority.history.findIndex(({ oid }) =>
    oid === receipt.reviewRefOid);
  const root = authority.history[rootIndex];
  if (
    root === undefined
    || root.record.state !== 'active'
    || root.record.protocolVersion !== 2
    || root.record.prNumber !== receipt.prNumber
    || root.record.generation !== receipt.reviewGeneration
    || root.record.head !== receipt.reviewedHead
    || !authors.has(normalizedLogin(root.record.reviewer))
  ) {
    return {
      problem:
        'Verdict review generation root differs from the receipt',
    };
  }
  const terminalState = expectedReviewClaimState(receipt.operation);
  const terminalIndex = authority.history.findIndex(({ record }, index) =>
    index < rootIndex
    && record.generation === root.record.generation
    && record.attempt === root.record.attempt
    && normalizedLogin(record.reviewer)
      === normalizedLogin(root.record.reviewer)
    && record.head === root.record.head
    && record.state === terminalState);
  const terminal = authority.history[terminalIndex];
  if (terminal === undefined) {
    return {
      problem:
        'Verdict review generation is not an operation-compatible descendant',
    };
  }
  const advancedBeyondReceipt = terminal.oid !== current.oid;
  if (receipt.operation === 'human') {
    return {
      problem: null,
      currentRecord: current.record,
      advancedBeyondReceipt,
    };
  }
  const verdictState = receipt.operation === 'review-verdict'
    ? 'APPROVE'
    : 'REQUEST_CHANGES';
  const verdictRecord = authority.history.find(({ record }, index) =>
    index >= terminalIndex
    && index < rootIndex
    && record.state === 'verdict-intent'
    && record.generation === receipt.reviewGeneration
    && record.attempt === root.record.attempt
    && normalizedLogin(record.reviewer)
      === normalizedLogin(root.record.reviewer)
    && record.head === root.record.head
    && record.verdict?.state === verdictState
  )?.record;
  return verdictRecord === undefined
    ? { problem: 'Verdict review intent is not observable in exact ancestry' }
    : {
        problem: null,
        verdictRecord,
        currentRecord: current.record,
        advancedBeyondReceipt,
      };
}

async function verifyAcceptedReceiptFacts(
  receipt: Extract<AutopilotAdoptionReceipt, { disposition: 'accepted' }>,
  input: ObserveExactAutopilotAdoptionReceiptInput,
): Promise<string | null> {
  if (input.acceptedAllowed === false) {
    return 'the delivered outcome cannot be accepted for evaluation';
  }
  if (
    input.expectedAcceptedOperation !== undefined
    && receipt.operation !== input.expectedAcceptedOperation
  ) {
    return `accepted operation ${receipt.operation} does not match delivered output`;
  }

  const reviewAuthority = await verifyReviewAuthority(receipt, input);
  if (reviewAuthority.problem !== null) return reviewAuthority.problem;
  const pr = await input.github.readPullRequest(receipt.prNumber);
  const exactHead = receipt.role === 'solution'
    ? receipt.resultingHead
    : receipt.reviewedHead;
  const historicalVerdict =
    receipt.role === 'verdict'
    && reviewAuthority.advancedBeyondReceipt === true;
  if (
    pr.headSha !== exactHead
    && !(
      historicalVerdict
      && reviewAuthority.currentRecord?.head === pr.headSha
    )
  ) {
    return `current PR head ${pr.headSha} does not match adopted or proven descendant head ${exactHead}`;
  }
  if (receipt.role === 'solution') return null;
  const label = expectedLabel(receipt.operation);
  if (
    !historicalVerdict
    && label !== undefined
    && !pr.labels.includes(label)
  ) {
    return `native ${receipt.operation} label ${label} is not observable`;
  }
  if (
    !historicalVerdict
    &&
    receipt.operation === 'review-verdict'
    && (
      pr.labels.includes('review:changes-requested')
      || pr.labels.includes('review:needs-human')
    )
  ) {
    return 'native approval projection conflicts with requested-changes or Human';
  }
  if (
    !historicalVerdict
    &&
    receipt.operation === 'review-findings'
    && (
      pr.labels.includes('review:approved')
      || pr.labels.includes('review:needs-human')
    )
  ) {
    return 'native requested-changes projection conflicts with approval or Human';
  }
  if (receipt.operation === 'review-findings') {
    const child = await input.github.readIssue(receipt.childIssueNumber);
    const marker =
      `<!-- jinn-autopilot:child pr=${receipt.prNumber} kind=review-finding -->`;
    const canonicalChildMarkers = child.body.match(
      /<!-- jinn-autopilot:child pr=\d+ kind=(?:review-finding|reconcile|ci-failure) -->/g,
    ) ?? [];
    if (
      child.number !== receipt.childIssueNumber
      || (!historicalVerdict && child.state !== 'OPEN')
      || child.isPullRequest
      || !(child.body === marker || child.body.startsWith(`${marker}\n`))
      || canonicalChildMarkers.length !== 1
      || !child.labels.includes('review-finding')
      || !child.labels.includes('effort:medium')
      || !child.labels.includes('priority:p1')
    ) {
      return 'exact review-finding child is not observable';
    }
  }
  const state = expectedReviewState(receipt.operation);
  if (state === undefined) return null;

  const allReviews = await listAllReviews(input);
  const reviews = historicalVerdict ? allReviews : effectiveReviews(allReviews);
  const exactReviewer = reviewAuthority.verdictRecord?.reviewer;
  const matching = reviews.some((review) => (
    exactReviewer !== undefined
    && normalizedLogin(review.authorLogin) === normalizedLogin(exactReviewer)
    && review.state === state
    && review.commitId === receipt.reviewedHead
    && (
      reviewAuthority.verdictRecord === undefined
      || review.body.includes(
        automatedReviewMarker(reviewAuthority.verdictRecord)!,
      )
    )
  ));
  if (
    !historicalVerdict
    &&
    receipt.operation === 'review-verdict'
    && reviews.some((review) => review.state === 'CHANGES_REQUESTED')
  ) {
    return 'an effective native requested-changes review still blocks approval';
  }
  return matching
    ? null
    : `native ${state} review at ${receipt.reviewedHead} is not observable`;
}

/**
 * Pure, fail-closed receipt lookup for one exact delivered marketplace role.
 */
export async function observeExactAutopilotAdoptionReceipt(
  input: ObserveExactAutopilotAdoptionReceiptInput,
): Promise<AdoptionObservation> {
  const expected = AutopilotCorrelationSchema.safeParse(
    input.expectedCorrelation,
  );
  if (!expected.success) {
    return contradictory('expected adoption correlation is invalid');
  }
  const authors = new Set(
    input.receiptAuthors.map(normalizedLogin).filter(Boolean),
  );
  if (authors.size === 0) {
    return contradictory('adoption receipt author policy is empty');
  }

  const candidates = (await listAllComments(input))
    .filter((entry) => authors.has(normalizedLogin(entry.authorLogin)))
    .map((entry) => ({
      comment: entry,
      parsed: parseAutopilotAdoptionReceiptComment(entry.body),
    }))
    .filter((entry): entry is {
      comment: GitHubIssueComment;
      parsed: NonNullable<typeof entry.parsed>;
    } => entry.parsed !== null)
    .filter(({ parsed }) => matchesStableDelivery(parsed.receipt, input));

  if (candidates.length === 0) {
    return pending('no exact authorized adoption receipt is observable');
  }

  const dispositions = new Set(
    candidates.map(({ parsed }) => parsed.receipt.disposition),
  );
  if (dispositions.size > 1) {
    return contradictory(
      'authorized accepted and rejected receipts exist for the same delivery',
    );
  }
  if (
    candidates.some(({ parsed }) =>
      !matchesExpectedCorrelation(parsed.receipt, expected.data))
  ) {
    return contradictory(
      'authorized receipt correlation differs from the exact delivered output',
    );
  }

  const byCanonicalJson = new Map<string, AutopilotAdoptionReceipt>();
  for (const { parsed } of candidates) {
    byCanonicalJson.set(parsed.canonicalJson, parsed.receipt);
  }
  if (byCanonicalJson.size > 1) {
    return contradictory(
      'different authorized exact receipts exist for the same delivery',
    );
  }

  const receipt = [...byCanonicalJson.values()][0]!;
  if (receipt.disposition === 'rejected') {
    if (
      input.expectedRejectedReason !== undefined
      && receipt.reason !== input.expectedRejectedReason
    ) {
      return contradictory(
        `rejection reason ${receipt.reason} does not match ${input.expectedRejectedReason}`,
      );
    }
    // A rejection records why adoption did not happen. In particular, a
    // stale-head rejection remains valid after the live head advances.
    return { state: 'rejected', receipt };
  }
  const unverified = await verifyAcceptedReceiptFacts(receipt, input);
  if (unverified !== null) return pending(unverified);
  return { state: 'accepted', receipt };
}

function operationForMutation(
  session: AutopilotSessionCapsule,
  result: AutopilotMutationResult,
): AcceptedOperation | undefined {
  if (result.outcome !== 'mutation-complete') return undefined;
  return session.workflow === 'implement'
    ? 'implementation-complete'
    : 'child-complete';
}

function operationForReview(
  result: AutopilotReviewResult,
): AcceptedOperation {
  if (result.outcome === 'approve') return 'review-verdict';
  if (result.outcome === 'request-changes') return 'review-findings';
  return 'human';
}

function sameAuthorPolicy(
  left: readonly string[],
  right: readonly string[],
): boolean {
  const normalize = (values: readonly string[]) =>
    [...new Set(values.map(normalizedLogin).filter(Boolean))].sort();
  return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
}

export function derivePersistedAutopilotAdoptionExpectation(
  run: PersistedTaskRun,
):
  | {
      readonly role: ReceiptRole;
      readonly correlation: AutopilotCorrelation;
      readonly operation?: AcceptedOperation;
      readonly acceptedAllowed: boolean;
      readonly rejectedReason?: AutopilotAdoptionRejectionReason;
      readonly authors: readonly string[];
    }
  | { readonly error: string } {
  if (
    run.taskId === null
    || run.attemptIndex === null
    || run.adoptionReceiptLocation === null
    || run.adoptionReceiptAuthors === null
    || run.solutionOutputsJson === null
  ) {
    return { error: 'persisted adoption facts are incomplete' };
  }
  if (run.taskRole !== 'restoration' && run.taskRole !== 'evaluation') {
    return { error: 'persisted adoption role is missing' };
  }
  const runtimeTask = run.task;
  const isJinnRepo = run.solverType === 'jinn-repo.v1'
    || (
      runtimeTask?.contractId === 'jinn-repo'
      && runtimeTask.contractVersion === 'v1'
    );
  const parsedTask = JinnRepoTaskSchema.safeParse(runtimeTask?.spec);
  if (!parsedTask.success || parsedTask.data.source !== 'autopilot-session') {
    return { error: 'persisted Task is not a strict Autopilot session' };
  }
  const task = parsedTask.data;
  if (
    !isJinnRepo
    || runtimeTask?.id !== task.instance_id
    || task.instance_id !== `autopilot:${task.session.v2AttemptId}`
    || runtimeTask.role !== run.taskRole
  ) {
    return { error: 'persisted runtime Task identity or role is contradictory' };
  }
  if (
    run.adoptionReceiptLocation.repository !== task.session.repository
    || run.adoptionReceiptLocation.prNumber !== task.session.prNumber
    || !sameAuthorPolicy(run.adoptionReceiptAuthors, task.session.receiptAuthors)
  ) {
    return { error: 'persisted receipt policy differs from the source session' };
  }

  let output: unknown;
  try {
    output = JSON.parse(run.solutionOutputsJson) as unknown;
  } catch {
    return { error: 'persisted delivered output is not JSON' };
  }
  if (output === null || typeof output !== 'object' || Array.isArray(output)) {
    return { error: 'persisted delivered output is malformed' };
  }

  const role: ReceiptRole =
    run.taskRole === 'evaluation' ? 'verdict' : 'solution';
  const payload = output as {
    solutionPayload?: unknown;
    verdictPayload?: unknown;
  };
  let parsedResult: AutopilotMutationResult | AutopilotReviewResult;
  if (role === 'solution') {
    if (!run.manifestCid) {
      return { error: 'persisted solution envelope CID is unavailable' };
    }
    try {
      parsedResult = bindAutopilotMutationDeliveryResult(
        payload.solutionPayload,
        run.manifestCid,
      );
    } catch {
      return { error: 'persisted solution output failed its strict SDK schema' };
    }
  } else {
    const parsedReview = AutopilotReviewResultSchema.safeParse(
      payload.verdictPayload,
    );
    if (!parsedReview.success) {
      return { error: 'persisted verdict output failed its strict SDK schema' };
    }
    parsedResult = parsedReview.data;
  }
  const correlation = parsedResult.correlation;
  if (
    correlation.taskId !== run.taskId
    || correlation.attemptIndex !== run.attemptIndex
    || correlation.requestId !== run.requestId
    || correlation.deliveryEnvelopeCid !== run.manifestCid
    || correlation.v2AttemptId !== task.session.v2AttemptId
    || correlation.claimOid !== task.session.claimOid
    || correlation.prNumber !== task.session.prNumber
    || correlation.expectedHead !== task.session.expectedHead
  ) {
    return { error: 'persisted delivered output correlation is contradictory' };
  }

  return role === 'solution'
    ? {
        role,
        correlation,
        operation: operationForMutation(
          task.session,
          parsedResult as AutopilotMutationResult,
        ),
        acceptedAllowed:
          (parsedResult as AutopilotMutationResult).outcome
            === 'mutation-complete',
        ...((parsedResult as AutopilotMutationResult).outcome === 'human'
          ? { rejectedReason: 'policy-human' as const }
          : {}),
        authors: task.session.receiptAuthors,
      }
    : {
        role,
        correlation,
        operation: operationForReview(
          parsedResult as AutopilotReviewResult,
        ),
        acceptedAllowed: true,
        authors: task.session.receiptAuthors,
      };
}

/**
 * TaskEngine-compatible observer. It derives all expected facts from the
 * durable run and never accepts caller-supplied fallback identity.
 */
export function createAutopilotGitHubAdoptionReceiptObserver(input: {
  readonly github: AutopilotGitHubReadPort;
  readonly maxPages?: number;
}): AdoptionReceiptObserver {
  return {
    async observe(run: PersistedTaskRun): Promise<AdoptionObservation> {
      const expected = derivePersistedAutopilotAdoptionExpectation(run);
      if ('error' in expected) return contradictory(expected.error);
      return observeExactAutopilotAdoptionReceipt({
        expectedRole: expected.role,
        expectedCorrelation: expected.correlation,
        receiptAuthors: expected.authors,
        github: input.github,
        ...(expected.operation === undefined
          ? {}
          : { expectedAcceptedOperation: expected.operation }),
        acceptedAllowed: expected.acceptedAllowed,
        ...(expected.rejectedReason === undefined
          ? {}
          : { expectedRejectedReason: expected.rejectedReason }),
        ...(input.maxPages === undefined ? {} : { maxPages: input.maxPages }),
      });
    },
  };
}
