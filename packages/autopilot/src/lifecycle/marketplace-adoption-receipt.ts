import {
  AutopilotAdoptionReceiptSchema,
  AutopilotCorrelationSchema,
  autopilotCorrelationMatches,
  type AutopilotAdoptionReceipt,
  type AutopilotCorrelation,
} from '@jinn-network/sdk/autopilot';

const MARKER_PREFIX = '<!-- jinn-autopilot:marketplace-adoption-receipt:v1 key=';
const MARKER_SUFFIX = ' -->';
const PAYLOAD_BEGIN =
  '<!-- jinn-autopilot:marketplace-adoption-receipt-payload:v1 begin -->';
const PAYLOAD_END =
  '<!-- jinn-autopilot:marketplace-adoption-receipt-payload:v1 end -->';
const MAX_COMMENT_PAGES = 100;

type ReceiptRole = AutopilotAdoptionReceipt['role'];
type ReceiptDisposition = AutopilotAdoptionReceipt['disposition'];

interface AdoptionReceiptMarkerKey {
  readonly role: ReceiptRole;
  readonly taskId: string;
  readonly attemptIndex: number;
  readonly requestId: string;
  readonly deliveryEnvelopeCid: string;
  readonly v2AttemptId: string;
  readonly disposition: ReceiptDisposition;
}

export interface ParsedAdoptionReceiptComment {
  readonly receipt: AutopilotAdoptionReceipt;
  readonly canonicalJson: string;
}

export interface AdoptionReceiptComment {
  /** Immutable GitHub issue-comment database identifier. */
  readonly id: number;
  /** Exact login returned by GitHub for the comment author. */
  readonly authorLogin: string;
  readonly body: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface AdoptionReceiptCommentPage {
  readonly comments: readonly AdoptionReceiptComment[];
  readonly nextCursor?: string;
}

export interface AdoptionReceiptExactFacts {
  readonly role: ReceiptRole;
  readonly correlation: AutopilotCorrelation;
  /** Exact PR head described by and correlated with this receipt. */
  readonly prHead: string;
}

export interface ReceiptFactsVerificationInput {
  readonly exactFacts: AdoptionReceiptExactFacts;
  readonly receipt: AutopilotAdoptionReceipt;
}

export interface AdoptionReceiptReadPorts {
  listPrIssueComments(input: {
    readonly prNumber: number;
    readonly cursor?: string;
  }): Promise<AdoptionReceiptCommentPage>;
  /**
   * Verifies the receipt against caller-owned authoritative facts. A valid
   * GitHub comment is evidence, not authority by itself.
   */
  verifyReceiptFacts(input: ReceiptFactsVerificationInput): Promise<boolean>;
}

export interface CreateAdoptionReceiptCommentInput {
  readonly prNumber: number;
  /** The write port must refuse atomically if this is no longer the PR head. */
  readonly expectedHead: string;
  readonly body: string;
}

export interface AdoptionReceiptWritePorts {
  readCurrentPrHead(prNumber: number): Promise<string>;
  createPrComment(input: CreateAdoptionReceiptCommentInput): Promise<{
    readonly commentId: number;
  }>;
}

export type AdoptionReceiptPorts =
  & AdoptionReceiptReadPorts
  & AdoptionReceiptWritePorts;

export type AdoptionReceiptPendingReason =
  | 'not-found'
  | 'facts-unverified';

export type AdoptionReceiptContradictionReason =
  | 'accepted-and-rejected'
  | 'correlation-mismatch'
  | 'different-accepted-receipts'
  | 'different-rejected-receipts';

interface ExactAdoptionReceiptState {
  readonly receipt: AutopilotAdoptionReceipt;
  readonly canonicalJson: string;
  readonly comments: readonly AdoptionReceiptComment[];
}

export type AdoptionReceiptState =
  | {
    readonly status: 'pending';
    readonly reason: AdoptionReceiptPendingReason;
  }
  | ({
    readonly status: 'exact-accepted';
  } & ExactAdoptionReceiptState)
  | ({
    readonly status: 'exact-rejected';
  } & ExactAdoptionReceiptState)
  | {
    readonly status: 'contradiction';
    readonly reason: AdoptionReceiptContradictionReason;
    readonly comments: readonly AdoptionReceiptComment[];
  };

export type AdoptionReceiptLookupErrorCode =
  | 'comment-id-collision'
  | 'pagination-loop'
  | 'pagination-limit';

export class AdoptionReceiptLookupError extends Error {
  constructor(
    readonly code: AdoptionReceiptLookupErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AdoptionReceiptLookupError';
  }
}

export type AdoptionReceiptPublicationErrorCode =
  | 'invalid-receipt'
  | 'publisher-not-allowed'
  | 'receipt-facts-mismatch'
  | 'facts-unverified'
  | 'receipt-contradiction'
  | 'different-disposition'
  | 'different-receipt'
  | 'stale-head'
  | 'publication-not-observed';

export class AdoptionReceiptPublicationError extends Error {
  constructor(
    readonly code: AdoptionReceiptPublicationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AdoptionReceiptPublicationError';
  }
}

export interface PublishAdoptionReceiptInput {
  readonly receipt: AutopilotAdoptionReceipt;
  readonly exactFacts: AdoptionReceiptExactFacts;
  /**
   * Current PR head expected for the guarded comment write. This is separate
   * from the head described by a stale-head rejection receipt.
   */
  readonly expectedPublicationHead: string;
  readonly allowedAuthors: readonly string[];
  readonly publisherLogin: string;
}

export type PublishAdoptionReceiptResult =
  | {
    readonly status: 'published';
    readonly receipt: AutopilotAdoptionReceipt;
    readonly comment: AdoptionReceiptComment;
  }
  | {
    readonly status: 'already-published';
    readonly receipt: AutopilotAdoptionReceipt;
    readonly comments: readonly AdoptionReceiptComment[];
  };

function normalizeLogin(login: string): string {
  return login.trim().toLowerCase();
}

function markerKey(receipt: AutopilotAdoptionReceipt): AdoptionReceiptMarkerKey {
  return {
    role: receipt.role,
    taskId: receipt.taskId,
    attemptIndex: receipt.attemptIndex,
    requestId: receipt.requestId,
    deliveryEnvelopeCid: receipt.deliveryEnvelopeCid,
    v2AttemptId: receipt.v2AttemptId,
    disposition: receipt.disposition,
  };
}

function encodeMarkerKey(key: AdoptionReceiptMarkerKey): string {
  return Buffer.from(JSON.stringify(key), 'utf8').toString('base64url');
}

function parseMarkerKey(encoded: string): AdoptionReceiptMarkerKey | null {
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) return null;
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as unknown;
  } catch {
    return null;
  }
  if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded)) {
    return null;
  }
  const value = decoded as Record<string, unknown>;
  if (
    Object.keys(value).length !== 7
    || (value.role !== 'solution' && value.role !== 'verdict')
    || typeof value.taskId !== 'string'
    || !Number.isSafeInteger(value.attemptIndex)
    || (value.attemptIndex as number) < 0
    || typeof value.requestId !== 'string'
    || typeof value.deliveryEnvelopeCid !== 'string'
    || typeof value.v2AttemptId !== 'string'
    || (value.disposition !== 'accepted' && value.disposition !== 'rejected')
  ) {
    return null;
  }
  const parsed: AdoptionReceiptMarkerKey = {
    role: value.role,
    taskId: value.taskId,
    attemptIndex: value.attemptIndex as number,
    requestId: value.requestId,
    deliveryEnvelopeCid: value.deliveryEnvelopeCid,
    v2AttemptId: value.v2AttemptId,
    disposition: value.disposition,
  };
  return encodeMarkerKey(parsed) === encoded ? parsed : null;
}

function markerKeysMatch(
  expected: AdoptionReceiptMarkerKey,
  actual: AdoptionReceiptMarkerKey,
): boolean {
  return expected.role === actual.role
    && expected.taskId === actual.taskId
    && expected.attemptIndex === actual.attemptIndex
    && expected.requestId === actual.requestId
    && expected.deliveryEnvelopeCid === actual.deliveryEnvelopeCid
    && expected.v2AttemptId === actual.v2AttemptId
    && expected.disposition === actual.disposition;
}

export function formatAdoptionReceiptComment(
  input: AutopilotAdoptionReceipt,
): string {
  const receipt = AutopilotAdoptionReceiptSchema.parse(input);
  const encodedKey = encodeMarkerKey(markerKey(receipt));
  return [
    `${MARKER_PREFIX}${encodedKey}${MARKER_SUFFIX}`,
    PAYLOAD_BEGIN,
    '```json',
    JSON.stringify(receipt),
    '```',
    PAYLOAD_END,
  ].join('\n');
}

export function parseAdoptionReceiptComment(
  body: string,
): ParsedAdoptionReceiptComment | null {
  const lines = body.split('\n');
  if (
    lines.length !== 6
    || !lines[0]?.startsWith(MARKER_PREFIX)
    || !lines[0].endsWith(MARKER_SUFFIX)
    || lines[1] !== PAYLOAD_BEGIN
    || lines[2] !== '```json'
    || lines[4] !== '```'
    || lines[5] !== PAYLOAD_END
  ) {
    return null;
  }
  const encodedKey = lines[0].slice(
    MARKER_PREFIX.length,
    -MARKER_SUFFIX.length,
  );
  const parsedMarker = parseMarkerKey(encodedKey);
  if (parsedMarker === null) return null;

  let rawReceipt: unknown;
  try {
    rawReceipt = JSON.parse(lines[3]!) as unknown;
  } catch {
    return null;
  }
  const parsedReceipt = AutopilotAdoptionReceiptSchema.safeParse(rawReceipt);
  if (!parsedReceipt.success) return null;
  const receipt = parsedReceipt.data;
  const canonicalJson = JSON.stringify(receipt);
  if (
    canonicalJson !== lines[3]
    || !markerKeysMatch(parsedMarker, markerKey(receipt))
  ) {
    return null;
  }
  return { receipt, canonicalJson };
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

function receiptPrHead(receipt: AutopilotAdoptionReceipt): string {
  if (receipt.role === 'verdict') return receipt.reviewedHead;
  return receipt.resultingHead ?? receipt.expectedHead;
}

function receiptMatchesExactFacts(
  receipt: AutopilotAdoptionReceipt,
  exactFacts: AdoptionReceiptExactFacts,
): boolean {
  let expectedCorrelation: AutopilotCorrelation;
  try {
    expectedCorrelation = AutopilotCorrelationSchema.parse(exactFacts.correlation);
  } catch {
    return false;
  }
  return receipt.role === exactFacts.role
    && receiptPrHead(receipt) === exactFacts.prHead
    && autopilotCorrelationMatches(
      expectedCorrelation,
      receiptCorrelation(receipt),
    );
}

function receiptMatchesStableDeliveryIdentity(
  receipt: AutopilotAdoptionReceipt,
  exactFacts: AdoptionReceiptExactFacts,
): boolean {
  const expected = exactFacts.correlation;
  return receipt.role === exactFacts.role
    && receipt.taskId === expected.taskId
    && receipt.attemptIndex === expected.attemptIndex
    && receipt.requestId === expected.requestId
    && receipt.deliveryEnvelopeCid === expected.deliveryEnvelopeCid
    && receipt.v2AttemptId === expected.v2AttemptId;
}

async function listAllComments(
  prNumber: number,
  ports: AdoptionReceiptReadPorts,
): Promise<readonly AdoptionReceiptComment[]> {
  const byId = new Map<number, AdoptionReceiptComment>();
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < MAX_COMMENT_PAGES; page += 1) {
    const result = await ports.listPrIssueComments({
      prNumber,
      ...(cursor === undefined ? {} : { cursor }),
    });
    for (const comment of result.comments) {
      const prior = byId.get(comment.id);
      if (prior === undefined) {
        byId.set(comment.id, comment);
      } else if (
        prior.authorLogin !== comment.authorLogin
        || prior.body !== comment.body
        || prior.createdAt !== comment.createdAt
        || prior.updatedAt !== comment.updatedAt
      ) {
        throw new AdoptionReceiptLookupError(
          'comment-id-collision',
          `GitHub comment ${comment.id} changed across pagination`,
        );
      }
    }
    if (result.nextCursor === undefined) return [...byId.values()];
    if (seenCursors.has(result.nextCursor)) {
      throw new AdoptionReceiptLookupError(
        'pagination-loop',
        'GitHub comment pagination repeated a cursor',
      );
    }
    seenCursors.add(result.nextCursor);
    cursor = result.nextCursor;
  }
  throw new AdoptionReceiptLookupError(
    'pagination-limit',
    `GitHub comment pagination exceeded ${MAX_COMMENT_PAGES} pages`,
  );
}

export async function readAdoptionReceiptState(
  exactFacts: AdoptionReceiptExactFacts,
  allowedAuthors: readonly string[],
  ports: AdoptionReceiptReadPorts,
): Promise<AdoptionReceiptState> {
  const allowed = new Set(allowedAuthors.map(normalizeLogin).filter(Boolean));
  const comments = await listAllComments(exactFacts.correlation.prNumber, ports);
  const candidates: Array<{
    readonly comment: AdoptionReceiptComment;
    readonly parsed: ParsedAdoptionReceiptComment;
  }> = [];
  const verified: Array<{
    readonly comment: AdoptionReceiptComment;
    readonly parsed: ParsedAdoptionReceiptComment;
  }> = [];
  let foundUnverified = false;

  for (const comment of comments) {
    if (!allowed.has(normalizeLogin(comment.authorLogin))) continue;
    const parsed = parseAdoptionReceiptComment(comment.body);
    if (
      parsed === null
      || !receiptMatchesStableDeliveryIdentity(parsed.receipt, exactFacts)
    ) {
      continue;
    }
    candidates.push({ comment, parsed });
  }

  const candidateDispositions = new Set(
    candidates.map(({ parsed }) => parsed.receipt.disposition),
  );
  if (
    candidateDispositions.has('accepted')
    && candidateDispositions.has('rejected')
  ) {
    return {
      status: 'contradiction',
      reason: 'accepted-and-rejected',
      comments: candidates.map(({ comment }) => comment),
    };
  }
  if (candidates.some(
    ({ parsed }) => !receiptMatchesExactFacts(parsed.receipt, exactFacts),
  )) {
    return {
      status: 'contradiction',
      reason: 'correlation-mismatch',
      comments: candidates.map(({ comment }) => comment),
    };
  }

  for (const { comment, parsed } of candidates) {
    if (!await ports.verifyReceiptFacts({
      exactFacts,
      receipt: parsed.receipt,
    })) {
      foundUnverified = true;
      continue;
    }
    verified.push({ comment, parsed });
  }

  if (verified.length === 0) {
    return {
      status: 'pending',
      reason: foundUnverified ? 'facts-unverified' : 'not-found',
    };
  }

  const accepted = new Map<string, typeof verified>();
  const rejected = new Map<string, typeof verified>();
  for (const entry of verified) {
    const target = entry.parsed.receipt.disposition === 'accepted'
      ? accepted
      : rejected;
    const prior = target.get(entry.parsed.canonicalJson) ?? [];
    target.set(entry.parsed.canonicalJson, [...prior, entry]);
  }
  if (accepted.size > 0 && rejected.size > 0) {
    return {
      status: 'contradiction',
      reason: 'accepted-and-rejected',
      comments: verified.map(({ comment }) => comment),
    };
  }
  if (accepted.size > 1) {
    return {
      status: 'contradiction',
      reason: 'different-accepted-receipts',
      comments: verified.map(({ comment }) => comment),
    };
  }
  if (rejected.size > 1) {
    return {
      status: 'contradiction',
      reason: 'different-rejected-receipts',
      comments: verified.map(({ comment }) => comment),
    };
  }

  const [canonicalJson, entries] = (
    accepted.size === 1 ? [...accepted.entries()] : [...rejected.entries()]
  )[0]!;
  const receipt = entries[0]!.parsed.receipt;
  return {
    status: receipt.disposition === 'accepted'
      ? 'exact-accepted'
      : 'exact-rejected',
    receipt,
    canonicalJson,
    comments: entries.map(({ comment }) => comment),
  };
}

function publicationError(
  code: AdoptionReceiptPublicationErrorCode,
  message: string,
): never {
  throw new AdoptionReceiptPublicationError(code, message);
}

function exactStateMatchesReceipt(
  state: Extract<
    AdoptionReceiptState,
    { readonly status: 'exact-accepted' | 'exact-rejected' }
  >,
  receipt: AutopilotAdoptionReceipt,
): boolean {
  return state.canonicalJson === JSON.stringify(receipt);
}

export async function publishAdoptionReceipt(
  input: PublishAdoptionReceiptInput,
  ports: AdoptionReceiptPorts,
): Promise<PublishAdoptionReceiptResult> {
  const parsed = AutopilotAdoptionReceiptSchema.safeParse(input.receipt);
  if (!parsed.success) {
    return publicationError('invalid-receipt', 'Receipt failed the canonical SDK schema');
  }
  const receipt = parsed.data;
  const allowed = new Set(input.allowedAuthors.map(normalizeLogin).filter(Boolean));
  if (!allowed.has(normalizeLogin(input.publisherLogin))) {
    return publicationError(
      'publisher-not-allowed',
      'Publisher login is not in the caller-supplied allowlist',
    );
  }
  if (!receiptMatchesExactFacts(receipt, input.exactFacts)) {
    return publicationError(
      'receipt-facts-mismatch',
      'Receipt does not match the requested exact facts',
    );
  }

  const existing = await readAdoptionReceiptState(
    input.exactFacts,
    input.allowedAuthors,
    ports,
  );
  if (existing.status === 'contradiction') {
    return publicationError(
      'receipt-contradiction',
      `Receipt lookup failed closed: ${existing.reason}`,
    );
  }
  if (
    existing.status === 'pending'
    && existing.reason === 'facts-unverified'
  ) {
    return publicationError(
      'facts-unverified',
      'An exact-looking receipt could not be verified against authoritative facts',
    );
  }
  if (
    existing.status === 'exact-accepted'
    || existing.status === 'exact-rejected'
  ) {
    if (existing.receipt.disposition !== receipt.disposition) {
      return publicationError(
        'different-disposition',
        'An authorized exact receipt already records the opposite disposition',
      );
    }
    if (!exactStateMatchesReceipt(existing, receipt)) {
      return publicationError(
        'different-receipt',
        'An authorized receipt with the same disposition has different exact content',
      );
    }
    return {
      status: 'already-published',
      receipt,
      comments: existing.comments,
    };
  }

  if (!await ports.verifyReceiptFacts({
    exactFacts: input.exactFacts,
    receipt,
  })) {
    return publicationError(
      'facts-unverified',
      'Receipt failed caller-owned authoritative fact verification',
    );
  }

  const firstHead = await ports.readCurrentPrHead(receipt.prNumber);
  if (firstHead !== input.expectedPublicationHead) {
    return publicationError(
      'stale-head',
      `Expected publication head ${input.expectedPublicationHead}, observed ${firstHead}`,
    );
  }
  const currentHead = await ports.readCurrentPrHead(receipt.prNumber);
  if (currentHead !== input.expectedPublicationHead) {
    return publicationError(
      'stale-head',
      `Expected publication head ${input.expectedPublicationHead}, observed ${currentHead}`,
    );
  }

  const created = await ports.createPrComment({
    prNumber: receipt.prNumber,
    expectedHead: input.expectedPublicationHead,
    body: formatAdoptionReceiptComment(receipt),
  });

  const observed = await readAdoptionReceiptState(
    input.exactFacts,
    input.allowedAuthors,
    ports,
  );
  if (
    observed.status !== (receipt.disposition === 'accepted'
      ? 'exact-accepted'
      : 'exact-rejected')
    || !exactStateMatchesReceipt(observed as Extract<
      AdoptionReceiptState,
      { readonly status: 'exact-accepted' | 'exact-rejected' }
    >, receipt)
  ) {
    return publicationError(
      observed.status === 'contradiction'
        ? 'receipt-contradiction'
        : 'publication-not-observed',
      'The authored exact receipt was not observed after publication',
    );
  }
  const authored = observed.comments.find(
    (comment) => comment.id === created.commentId
      && normalizeLogin(comment.authorLogin) === normalizeLogin(input.publisherLogin),
  );
  if (authored === undefined) {
    return publicationError(
      'publication-not-observed',
      'The created comment was not read back with the publishing author',
    );
  }
  return {
    status: 'published',
    receipt,
    comment: authored,
  };
}
