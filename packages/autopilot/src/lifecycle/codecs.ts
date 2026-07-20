import {
  gitOid,
  gitRefName,
  isoTimestamp,
  type BranchClaim,
  type GitOid,
  type GitRefName,
  type HumanReason,
  type ReviewClaimRecord,
  type ReviewClaimState,
  type ReviewVerdictState,
} from './types.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const POSITIVE_INTEGER_PATTERN = /^[1-9][0-9]*$/;
const SAFE_TEXT_PATTERN = /^[^\u0000-\u001f\u007f:][^\u0000-\u001f\u007f]*$/;
const REVIEW_STATES: readonly ReviewClaimState[] = [
  'active',
  'verdict-intent',
  'fixing',
  'terminal-approved',
  'human',
  'stale',
];
const VERDICT_STATES: readonly ReviewVerdictState[] = ['APPROVE', 'REQUEST_CHANGES'];

const BRANCH_TRAILERS = {
  protocolVersion: 'Jinn-Autopilot-Protocol',
  phase: 'Jinn-Autopilot-Phase',
  issueNumber: 'Jinn-Autopilot-Issue',
  prNumber: 'Jinn-Autopilot-PR',
  attempt: 'Jinn-Autopilot-Attempt',
  runner: 'Jinn-Autopilot-Runner',
  login: 'Jinn-Autopilot-Login',
  expectedHead: 'Jinn-Autopilot-Expected-Head',
  targetBase: 'Jinn-Autopilot-Target-Base',
  claimedAt: 'Jinn-Autopilot-Claimed-At',
  phaseComplete: 'Jinn-Autopilot-Phase-Complete',
} as const;

const ALLOWED_BRANCH_TRAILERS = new Set<string>(Object.values(BRANCH_TRAILERS));

function positiveInteger(value: unknown, name: string): number {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return value;
  if (typeof value === 'string' && POSITIVE_INTEGER_PATTERN.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  throw new Error(`Invalid ${name}`);
}

function positiveNumber(value: unknown, name: string): number {
  if (typeof value !== 'number') throw new Error(`Invalid ${name}`);
  return positiveInteger(value, name);
}

function uuid(value: unknown, name: string): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new Error(`Invalid ${name}`);
  }
  return value;
}

function safeText(value: unknown, name: string): string {
  if (typeof value !== 'string' || !SAFE_TEXT_PATTERN.test(value)) {
    throw new Error(`Invalid ${name}`);
  }
  return value;
}

function exactKeys(record: Record<string, unknown>, allowed: readonly string[]): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(record).find((key) => !allowedSet.has(key));
  if (unknown !== undefined) throw new Error(`Unknown field: ${unknown}`);
}

function validateBranchClaim(claim: BranchClaim): BranchClaim {
  exactKeys(claim as unknown as Record<string, unknown>, [
    'kind',
    'protocolVersion',
    'phase',
    'issueNumber',
    'prNumber',
    'attempt',
    'runner',
    'login',
    'expectedHead',
    'targetBase',
    'claimedAt',
    'phaseComplete',
  ]);
  if (claim.kind !== 'branch-claim') throw new Error('Invalid branch claim kind');
  if (claim.protocolVersion !== 2) throw new Error('Unsupported protocol version');
  positiveNumber(claim.issueNumber, 'issue number');
  if (claim.prNumber !== undefined) positiveNumber(claim.prNumber, 'PR number');
  if (claim.phase !== 'implement' && claim.phase !== 'merge-prep') throw new Error('Invalid branch claim phase');
  if (claim.phase === 'merge-prep' && claim.prNumber === undefined) {
    throw new Error('Contradictory phase fields: merge-prep requires PR');
  }
  uuid(claim.attempt, 'attempt');
  safeText(claim.runner, 'runner');
  safeText(claim.login, 'login');
  gitOid(claim.expectedHead);
  gitRefName(claim.targetBase);
  isoTimestamp(claim.claimedAt);
  if (claim.phaseComplete !== undefined && claim.phaseComplete !== true) {
    throw new Error('Invalid phase-complete marker');
  }
  return claim;
}

export function encodeBranchClaimTrailers(claim: BranchClaim): string {
  validateBranchClaim(claim);
  const lines = [
    `${BRANCH_TRAILERS.protocolVersion}: 2`,
    `${BRANCH_TRAILERS.phase}: ${claim.phase}`,
    `${BRANCH_TRAILERS.issueNumber}: ${claim.issueNumber}`,
  ];
  if (claim.prNumber !== undefined) lines.push(`${BRANCH_TRAILERS.prNumber}: ${claim.prNumber}`);
  lines.push(
    `${BRANCH_TRAILERS.attempt}: ${claim.attempt}`,
    `${BRANCH_TRAILERS.runner}: ${claim.runner}`,
    `${BRANCH_TRAILERS.login}: ${claim.login}`,
    `${BRANCH_TRAILERS.expectedHead}: ${claim.expectedHead}`,
    `${BRANCH_TRAILERS.targetBase}: ${claim.targetBase}`,
    `${BRANCH_TRAILERS.claimedAt}: ${claim.claimedAt}`,
  );
  if (claim.phaseComplete === true) lines.push(`${BRANCH_TRAILERS.phaseComplete}: true`);
  return lines.join('\n');
}

export function decodeBranchClaimTrailers(value: string): BranchClaim {
  const fields = new Map<string, string>();
  for (const line of value.split('\n')) {
    if (line.length === 0) continue;
    const separator = line.indexOf(': ');
    if (separator <= 0) throw new Error(`Malformed branch claim trailer: ${line}`);
    const key = line.slice(0, separator);
    const fieldValue = line.slice(separator + 2);
    if (!ALLOWED_BRANCH_TRAILERS.has(key)) throw new Error(`Unknown branch claim trailer: ${key}`);
    if (fields.has(key)) throw new Error(`Duplicate branch claim trailer: ${key}`);
    fields.set(key, fieldValue);
  }

  const required = (key: string): string => {
    const field = fields.get(key);
    if (field === undefined) throw new Error(`Missing branch claim trailer: ${key}`);
    return field;
  };
  if (required(BRANCH_TRAILERS.protocolVersion) !== '2') {
    throw new Error('Unsupported protocol version');
  }
  const phase = required(BRANCH_TRAILERS.phase);
  if (phase !== 'implement' && phase !== 'merge-prep') throw new Error('Invalid branch claim phase');
  const prRaw = fields.get(BRANCH_TRAILERS.prNumber);
  const phaseComplete = fields.get(BRANCH_TRAILERS.phaseComplete);
  if (phaseComplete !== undefined && phaseComplete !== 'true') {
    throw new Error('Invalid phase-complete marker');
  }
  const common = {
    kind: 'branch-claim' as const,
    protocolVersion: 2 as const,
    issueNumber: positiveInteger(required(BRANCH_TRAILERS.issueNumber), 'issue number'),
    attempt: uuid(required(BRANCH_TRAILERS.attempt), 'attempt'),
    runner: safeText(required(BRANCH_TRAILERS.runner), 'runner'),
    login: safeText(required(BRANCH_TRAILERS.login), 'login'),
    expectedHead: gitOid(required(BRANCH_TRAILERS.expectedHead)),
    targetBase: gitRefName(required(BRANCH_TRAILERS.targetBase)),
    claimedAt: isoTimestamp(required(BRANCH_TRAILERS.claimedAt)),
    ...(phaseComplete === undefined ? {} : { phaseComplete: true as const }),
  };
  if (phase === 'merge-prep') {
    if (prRaw === undefined) throw new Error('Contradictory phase fields: merge-prep requires PR');
    return validateBranchClaim({
      ...common,
      phase,
      prNumber: positiveInteger(prRaw, 'PR number'),
    });
  }
  return validateBranchClaim({
    ...common,
    phase,
    ...(prRaw === undefined ? {} : { prNumber: positiveInteger(prRaw, 'PR number') }),
  });
}

function reviewRecordFromUnknown(
  value: unknown,
  requireRuntimeDiscriminator: boolean,
): ReviewClaimRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Invalid review claim payload');
  }
  const record = value as Record<string, unknown>;
  exactKeys(record, [
    ...(requireRuntimeDiscriminator ? ['kind'] : []),
    'protocolVersion',
    'prNumber',
    'generation',
    'attempt',
    'reviewer',
    'head',
    'state',
    'recordedAt',
    'verdict',
  ]);
  if (
    (requireRuntimeDiscriminator && record.kind !== 'review-claim')
    || (record.kind !== undefined && record.kind !== 'review-claim')
  ) {
    throw new Error('Invalid review claim kind');
  }
  if (record.protocolVersion !== 2) throw new Error('Unsupported protocol version');
  if (typeof record.state !== 'string' || !REVIEW_STATES.includes(record.state as ReviewClaimState)) {
    throw new Error('Invalid review claim state');
  }
  const state = record.state as ReviewClaimState;
  let verdict: ReviewClaimRecord['verdict'];
  if (record.verdict !== undefined) {
    if (typeof record.verdict !== 'object' || record.verdict === null || Array.isArray(record.verdict)) {
      throw new Error('Invalid verdict');
    }
    const verdictRecord = record.verdict as Record<string, unknown>;
    exactKeys(verdictRecord, ['marker', 'state']);
    const verdictState = verdictRecord.state;
    if (typeof verdictState !== 'string'
      || !VERDICT_STATES.includes(verdictState as ReviewVerdictState)) {
      throw new Error('Invalid verdict state');
    }
    verdict = {
      marker: uuid(verdictRecord.marker, 'verdict marker'),
      state: verdictState as ReviewVerdictState,
    };
  }
  if ((state === 'verdict-intent' || state === 'terminal-approved') && verdict === undefined) {
    throw new Error(`${state} requires verdict metadata`);
  }
  if (state === 'terminal-approved' && verdict?.state !== 'APPROVE') {
    throw new Error('terminal-approved requires APPROVE verdict');
  }
  if (!['verdict-intent', 'terminal-approved'].includes(state) && verdict !== undefined) {
    throw new Error(`Contradictory verdict fields for ${state}`);
  }
  const common = {
    kind: 'review-claim' as const,
    protocolVersion: 2 as const,
    prNumber: positiveNumber(record.prNumber, 'PR number'),
    generation: uuid(record.generation, 'generation'),
    attempt: uuid(record.attempt, 'attempt'),
    reviewer: safeText(record.reviewer, 'reviewer'),
    head: gitOid(safeText(record.head, 'head')),
    recordedAt: isoTimestamp(safeText(record.recordedAt, 'recorded-at')),
  };
  if (state === 'verdict-intent') {
    return { ...common, state, verdict: verdict! };
  }
  if (state === 'terminal-approved') {
    return {
      ...common,
      state,
      verdict: { ...verdict!, state: 'APPROVE' },
    };
  }
  return { ...common, state };
}

export function encodeReviewClaimPayload(record: ReviewClaimRecord): string {
  const valid = reviewRecordFromUnknown(record, true);
  const payload = {
    protocolVersion: valid.protocolVersion,
    prNumber: valid.prNumber,
    generation: valid.generation,
    attempt: valid.attempt,
    reviewer: valid.reviewer,
    head: valid.head,
    state: valid.state,
    recordedAt: valid.recordedAt,
    ...(valid.verdict === undefined ? {} : { verdict: valid.verdict }),
  };
  return JSON.stringify(payload);
}

export function decodeReviewClaimPayload(payload: string): ReviewClaimRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    throw new Error('Invalid review claim payload JSON');
  }
  return reviewRecordFromUnknown(parsed, false);
}

export function branchNameForIssue(issueNumber: number): GitRefName {
  return gitRefName(`autopilot/${positiveNumber(issueNumber, 'issue number')}`);
}

export function reviewClaimRef(prNumber: number): GitRefName {
  return gitRefName(
    `refs/jinn-autopilot/review-claims/v1/${positiveNumber(prNumber, 'PR number')}`,
  );
}

export interface AutomatedReviewMarker {
  readonly generation: string;
  readonly attempt: string;
  readonly head: GitOid;
  readonly verdict: ReviewVerdictState;
}

export function formatAutomatedReviewMarker(marker: AutomatedReviewMarker): string {
  uuid(marker.generation, 'generation');
  uuid(marker.attempt, 'attempt');
  gitOid(marker.head);
  if (!VERDICT_STATES.includes(marker.verdict)) throw new Error('Invalid verdict state');
  return `<!-- jinn-autopilot-review:v2 generation=${marker.generation} attempt=${marker.attempt} `
    + `head=${marker.head} verdict=${marker.verdict} -->`;
}

const REVIEW_MARKER_PATTERN =
  /^<!-- jinn-autopilot-review:v2 generation=([0-9a-f-]+) attempt=([0-9a-f-]+) head=([0-9a-f]+) verdict=([A-Z_]+) -->$/;

export function parseAutomatedReviewMarker(marker: string): AutomatedReviewMarker {
  const match = REVIEW_MARKER_PATTERN.exec(marker);
  if (match === null) throw new Error('Invalid automated review marker');
  const [, generation, attempt, head, verdict] = match;
  if (generation === undefined || attempt === undefined || head === undefined || verdict === undefined) {
    throw new Error('Invalid automated review marker');
  }
  if (!VERDICT_STATES.includes(verdict as ReviewVerdictState)) {
    throw new Error('Invalid automated review marker verdict');
  }
  return {
    generation: uuid(generation, 'generation'),
    attempt: uuid(attempt, 'attempt'),
    head: gitOid(head),
    verdict: verdict as ReviewVerdictState,
  };
}

export interface HumanCommentEvidence {
  readonly issueNumber?: number;
  readonly prNumber: number;
  readonly reason: HumanReason;
}

const HUMAN_MARKER_PATTERN =
  /^<!-- jinn-autopilot-human:v2(?: issue=([1-9][0-9]*))? pr=([1-9][0-9]*) phase=([a-z-]+) code=([a-z-]+) -->$/;

function humanReason(phase: string, code: string, detail: string): HumanReason {
  if (
    (phase === 'eligible' || phase === 'implementing')
    && [
      'first-push',
      'implementation-escalation',
      'branch-mapping-ambiguous',
      'invalid-branch-progress-time',
    ].includes(code)
  ) {
    return { phase, code: code as Extract<HumanReason, { phase: typeof phase }>['code'], detail };
  }
  if (
    (phase === 'awaiting-review' || phase === 'reviewing' || phase === 'review-fixing')
    && [
      'review-escalation',
      'reviewer-identity-unavailable',
      'invalid-review-progress-time',
    ].includes(code)
  ) {
    return { phase, code: code as Extract<HumanReason, { phase: typeof phase }>['code'], detail };
  }
  if (
    (phase === 'merge-prep' || phase === 'merge-ready')
    && [
      'semantic-conflict',
      'codeowner-sensitive-conflict',
      'invalid-merge-progress-time',
    ].includes(code)
  ) {
    return { phase, code: code as Extract<HumanReason, { phase: typeof phase }>['code'], detail };
  }
  throw new Error('Invalid Human reason phase/code');
}

export function formatHumanCommentMarker(input: {
  readonly issueNumber?: number;
  readonly prNumber: number;
  readonly reason: HumanReason;
}): string {
  if (input.issueNumber !== undefined) positiveNumber(input.issueNumber, 'issue number');
  positiveNumber(input.prNumber, 'PR number');
  humanReason(input.reason.phase, input.reason.code, input.reason.detail);
  return `<!-- jinn-autopilot-human:v2`
    + (input.issueNumber === undefined ? '' : ` issue=${input.issueNumber}`)
    + ` pr=${input.prNumber} phase=${input.reason.phase} code=${input.reason.code} -->`;
}

export function parseHumanCommentEvidence(body: string): HumanCommentEvidence | null {
  const [marker, ...paragraphs] = body.split('\n\n');
  if (marker === undefined) return null;
  const match = HUMAN_MARKER_PATTERN.exec(marker);
  if (match === null) return null;
  const [, issueRaw, prRaw, phase, code] = match;
  if (prRaw === undefined || phase === undefined || code === undefined) return null;
  const detail = paragraphs.at(-1)?.trim() ?? '';
  if (detail.length === 0 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(detail)) {
    throw new Error('Invalid Human reason detail');
  }
  return {
    ...(issueRaw === undefined
      ? {}
      : { issueNumber: positiveInteger(issueRaw, 'issue number') }),
    prNumber: positiveInteger(prRaw, 'PR number'),
    reason: humanReason(phase, code, detail),
  };
}
