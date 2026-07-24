import type { PolledIssue } from '../dispatcher/types.js';
import { toIssueBoardState, type ProjectSnapshot } from '../dispatcher/project-snapshot.js';
import { DEFAULT_FLOOR } from '../dispatcher/rate-limit-guard.js';
import type {
  GitHubRestDiscoveryReader,
  OpenIssueIndexEntry,
  PullRequestIndexEntry,
} from './github-rest-discovery.js';
import type { ConditionalRestClient } from './github-rest.js';
import {
  FULL_SCAN_RESERVE,
  TARGETED_RELATION_RESERVE,
  TARGETED_PR_RESERVE,
  GitHubRateLimitReserveError,
  assertRateLimitReserve,
} from './github-usage.js';
import {
  LifecycleDiscoveryCacheCorruptError,
  LifecycleDiscoveryCacheStore,
  LifecycleDiscoveryCacheUnsafePathError,
  type LifecycleDiscoveryState,
  type LifecycleDiscoveryStateStore,
  type LifecycleSnapshotEvidence,
} from './lifecycle-cache.js';
import {
  LifecycleRateLimitError,
  buildGitHubLifecycleSnapshot,
  composeGitHubLifecycleSnapshot,
  decodeBranchClaimSnapshot,
  decodePullRequestSnapshot,
  type GitHubLifecycleReader,
  type GitHubLifecycleSnapshot,
  type LifecycleParityDifference,
  type LifecycleSnapshotSource,
  type PullRequestSnapshot,
} from './snapshot.js';

/** Closed-index overlap selected at a full reconciliation and held fixed until the next one. */
export const RECENTLY_CLOSED_OVERLAP_MS = 5 * 60 * 1_000;

export interface PullRequestEvidenceProbe {
  /** True only when lifecycle-relevant review/comment/check evidence differs. */
  changed(pr: PullRequestSnapshot): Promise<boolean>;
}

export interface IncrementalLifecycleSnapshotSourceOptions {
  readonly fullReader: GitHubLifecycleReader;
  readonly restDiscovery: GitHubRestDiscoveryReader;
  readonly conditionalRest: ConditionalRestClient;
  readonly evidenceProbe: PullRequestEvidenceProbe;
  readonly authorAllowlist: ReadonlySet<string>;
  readonly cacheStore?: LifecycleDiscoveryStateStore;
  readonly stateDirectory?: string;
  readonly now?: () => Date;
  readonly recentlyClosedOverlapMs?: number;
}

export class IncrementalSnapshotUnavailableError extends Error {
  constructor(detail = 'no complete full-reconciliation seed exists') {
    super(`Incremental lifecycle snapshot is unavailable: ${detail}`);
    this.name = 'IncrementalSnapshotUnavailableError';
  }
}

export class IncrementalSnapshotInconsistentError extends Error {
  constructor(detail: string) {
    super(`Incremental lifecycle discovery is inconsistent: ${detail}`);
    this.name = 'IncrementalSnapshotInconsistentError';
  }
}

function exactNow(now: () => Date): string {
  const value = now();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error('Incremental snapshot clock returned an invalid Date');
  }
  return value.toISOString();
}

function uniqueByNumber<Value extends { readonly number: number }>(
  values: readonly Value[],
  subject: string,
): Map<number, Value> {
  const result = new Map<number, Value>();
  for (const value of values) {
    if (result.has(value.number)) {
      throw new IncrementalSnapshotInconsistentError(
        `${subject} contains duplicate #${value.number}`,
      );
    }
    result.set(value.number, value);
  }
  return result;
}

function polledIssues(
  project: ProjectSnapshot,
  index: readonly OpenIssueIndexEntry[],
): readonly PolledIssue[] {
  const board = toIssueBoardState(project);
  uniqueByNumber(index, 'open issue index');
  return index.map((issue): PolledIssue => {
    const entry = board.getIssue(issue.number);
    return {
      number: issue.number,
      title: issue.title,
      body: issue.body,
      labels: [...issue.labels],
      shape: entry?.issueType ?? null,
      blockedOn: entry?.blockedOn ?? null,
      blockedByIssues: [...(entry?.blockedByIssues ?? [])],
      effort: entry?.effort ?? null,
      priority: entry?.priority ?? null,
      status: entry?.status ?? null,
      onBoard: entry !== null,
      author: issue.author,
      projectItemId: entry?.id ?? null,
      inCurrentSprint: project.currentSprintIterationId !== null
        && entry?.sprintIterationId === project.currentSprintIterationId,
    };
  });
}

function indexCoreMatches(
  index: PullRequestIndexEntry,
  pr: PullRequestSnapshot,
): boolean {
  return pr.state === 'OPEN'
    && index.state === 'OPEN'
    && index.title === pr.title
    && index.headOid === pr.headOid
    && index.headRefName === pr.headRefName
    && index.baseRefName === pr.baseRefName
    && index.isDraft === pr.isDraft;
}

function indexMatches(left: PullRequestIndexEntry, right: PullRequestIndexEntry): boolean {
  return left.number === right.number
    && left.title === right.title
    && left.state === right.state
    && left.updatedAt === right.updatedAt
    && left.headOid === right.headOid
    && left.headRefName === right.headRefName
    && left.baseRefName === right.baseRefName
    && left.isDraft === right.isDraft
    && left.closedAt === right.closedAt
    && left.mergedAt === right.mergedAt;
}

function indexCollectionsMatch(
  left: readonly PullRequestIndexEntry[],
  right: readonly PullRequestIndexEntry[],
  subject: string,
): boolean {
  const leftByNumber = uniqueByNumber(left, `pre-oracle ${subject}`);
  const rightByNumber = uniqueByNumber(right, `post-oracle ${subject}`);
  return leftByNumber.size === rightByNumber.size
    && [...leftByNumber].every(([number, entry]) => {
      const candidate = rightByNumber.get(number);
      return candidate !== undefined && indexMatches(entry, candidate);
    });
}

function stableBranchIssue(headRefName: string): number | null {
  const match = /^autopilot\/([1-9][0-9]*)$/.exec(headRefName);
  if (match?.[1] === undefined) return null;
  const number = Number(match[1]);
  return Number.isSafeInteger(number) ? number : null;
}

function associatedIssueNumbers(pr: PullRequestSnapshot): ReadonlySet<number> {
  const numbers = new Set(pr.closingIssueNumbers);
  const stable = stableBranchIssue(pr.headRefName);
  if (stable !== null) numbers.add(stable);
  return numbers;
}

function projectIssueStatuses(project: ProjectSnapshot): ReadonlyMap<number, string | null> {
  return new Map(project.items
    .filter((item) => item.contentType === 'Issue')
    .map((item) => [item.number, item.status]));
}

function newlyActiveProjectIssues(
  prior: ProjectSnapshot,
  current: ProjectSnapshot,
): readonly number[] {
  const previous = projectIssueStatuses(prior);
  return current.items
    .filter((item) => item.contentType === 'Issue' && item.status !== 'Done')
    .map((item) => item.number)
    .filter((number) => {
      const status = previous.get(number);
      return status === undefined || status === 'Done';
    })
    .sort((left, right) => left - right);
}

function relevantToLifecycle(
  pr: PullRequestSnapshot,
  project: ProjectSnapshot,
): boolean {
  if (pr.labels.includes('engine:review')) return true;
  const statuses = projectIssueStatuses(project);
  return [...associatedIssueNumbers(pr)].some((number) => {
    const status = statuses.get(number);
    return status !== undefined && status !== 'Done';
  });
}

function retainMerged(pr: PullRequestSnapshot, project: ProjectSnapshot): boolean {
  if (pr.state !== 'MERGED') return true;
  const statuses = projectIssueStatuses(project);
  return [...associatedIssueNumbers(pr)].some((number) => {
    const status = statuses.get(number);
    return status !== undefined && status !== 'Done';
  });
}

function assertTargetedReserve(remaining: number, floor: number): void {
  assertGraphQlReserve(remaining, TARGETED_PR_RESERVE, floor);
}

function assertGraphQlReserve(remaining: number, reserve: number, floor: number): void {
  try {
    assertRateLimitReserve(remaining, reserve, floor);
  } catch (error) {
    if (!(error instanceof GitHubRateLimitReserveError)) throw error;
    throw new LifecycleRateLimitError(error.remaining, error.required, error.reserve);
  }
}

function assertCompletedFloor(remaining: number | null, floor: number): void {
  if (remaining === null) return;
  try {
    assertRateLimitReserve(remaining, 0, floor);
  } catch (error) {
    if (!(error instanceof GitHubRateLimitReserveError)) throw error;
    throw new LifecycleRateLimitError(error.remaining, error.required, error.reserve);
  }
}

function evidence(snapshot: GitHubLifecycleSnapshot): LifecycleSnapshotEvidence {
  if (
    snapshot.snapshotComplete !== true
    || snapshot.snapshotMode === undefined
    || snapshot.lastFullReconciliationAt === undefined
    || snapshot.lastFullReconciliationAt === null
    || snapshot.githubUsage === undefined
  ) {
    throw new IncrementalSnapshotUnavailableError('full oracle returned incomplete metadata');
  }
  return {
    project: snapshot.project,
    issues: snapshot.issues,
    pullRequests: snapshot.pullRequests,
    branches: snapshot.branches,
    capturedAt: snapshot.capturedAt,
    snapshotMode: snapshot.snapshotMode,
    lastFullReconciliationAt: snapshot.lastFullReconciliationAt,
    githubUsage: snapshot.githubUsage,
  };
}

function lifecycleDecisionMap(snapshot: GitHubLifecycleSnapshot): ReadonlyMap<string, string> {
  const decisions = new Map<string, string>();
  for (const item of snapshot.lifecycle.items) {
    const subject = item.kind === 'issue'
      ? `issue:${item.issueNumber}`
      : `pull-request:${item.prNumber}`;
    decisions.set(subject, JSON.stringify({
      ...item,
      labels: [...item.labels].sort(),
    }));
  }
  for (const diagnostic of snapshot.diagnostics) {
    const issueNumbers = [...diagnostic.issueNumbers].sort((left, right) => left - right);
    const issues = [...diagnostic.issues].sort((left, right) => left.number - right.number);
    const pullRequests = diagnostic.pullRequests
      .map((pr) => ({ ...pr, labels: [...pr.labels].sort() }))
      .sort((left, right) => left.number - right.number);
    const subject = `diagnostic:${diagnostic.code}:issues=${issueNumbers.join(',')}`
      + `:prs=${pullRequests.map((pr) => pr.number).join(',')}`;
    decisions.set(subject, JSON.stringify({
      ...diagnostic,
      issueNumbers,
      issues,
      pullRequests,
    }));
  }
  return decisions;
}

function parityDifferences(
  incremental: GitHubLifecycleSnapshot,
  full: GitHubLifecycleSnapshot,
): readonly LifecycleParityDifference[] {
  const prior = lifecycleDecisionMap(incremental);
  const oracle = lifecycleDecisionMap(full);
  const subjects = [...new Set([...prior.keys(), ...oracle.keys()])].sort();
  return subjects.flatMap((subject) => {
    const left = prior.get(subject) ?? null;
    const right = oracle.get(subject) ?? null;
    return left === right ? [] : [{ subject, incremental: left, full: right }];
  });
}

interface IncrementalComputation {
  readonly snapshot: GitHubLifecycleSnapshot;
  readonly next: LifecycleDiscoveryState;
  readonly openIssues: readonly OpenIssueIndexEntry[];
  readonly reviewClaimRefs: ReadonlyMap<number, import('./types.js').GitOid>;
}

function projectDecisionInputs(project: ProjectSnapshot): unknown {
  return {
    items: project.items
      .map((item) => ({
        ...item,
        blockedByIssues: [...item.blockedByIssues].sort((left, right) => left - right),
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    currentSprintIterationId: project.currentSprintIterationId,
  };
}

function openIssueDecisionInputs(issues: readonly OpenIssueIndexEntry[]): unknown {
  return issues
    .map((issue) => ({ ...issue, labels: [...issue.labels].sort() }))
    .sort((left, right) => left.number - right.number);
}

function branchDecisionInputs(
  branches: GitHubLifecycleSnapshot['branches'],
): unknown {
  return [...branches].sort((left, right) => (
    left.issueNumber - right.issueNumber
      || left.headRefName.localeCompare(right.headRefName)
      || left.headOid.localeCompare(right.headOid)
  ));
}

function conditionalDiscoveryInputs(
  entries: LifecycleDiscoveryState['restCache'],
): unknown {
  return entries.map(({ endpoint, etag, body, nextEndpoint }) => ({
    endpoint,
    etag,
    body,
    nextEndpoint,
  }));
}

function mapsMatch<Value>(
  left: ReadonlyMap<number, Value>,
  right: ReadonlyMap<number, Value>,
): boolean {
  return left.size === right.size
    && [...left].every(([key, value]) => right.get(key) === value);
}

function jsonMatches(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export class IncrementalLifecycleSnapshotSource implements LifecycleSnapshotSource {
  private readonly fullReader: GitHubLifecycleReader;
  private readonly restDiscovery: GitHubRestDiscoveryReader;
  private readonly conditionalRest: ConditionalRestClient;
  private readonly evidenceProbe: PullRequestEvidenceProbe;
  private readonly authorAllowlist: ReadonlySet<string>;
  private readonly cacheStore: LifecycleDiscoveryStateStore;
  private readonly now: () => Date;
  private readonly recentlyClosedOverlapMs: number;
  private state: LifecycleDiscoveryState | null = null;
  private loaded = false;

  constructor(options: IncrementalLifecycleSnapshotSourceOptions) {
    this.fullReader = options.fullReader;
    this.restDiscovery = options.restDiscovery;
    this.conditionalRest = options.conditionalRest;
    this.evidenceProbe = options.evidenceProbe;
    this.authorAllowlist = options.authorAllowlist;
    this.cacheStore = options.cacheStore ?? new LifecycleDiscoveryCacheStore({
      ...(options.stateDirectory === undefined ? {} : { stateDirectory: options.stateDirectory }),
    });
    this.now = options.now ?? (() => new Date());
    this.recentlyClosedOverlapMs = options.recentlyClosedOverlapMs
      ?? RECENTLY_CLOSED_OVERLAP_MS;
    if (
      !Number.isSafeInteger(this.recentlyClosedOverlapMs)
      || this.recentlyClosedOverlapMs < 0
    ) {
      throw new Error('Recently-closed overlap must be a non-negative integer');
    }
  }

  private async loadState(mode: 'incremental' | 'full'): Promise<LifecycleDiscoveryState | null> {
    if (!this.loaded) {
      let loaded: LifecycleDiscoveryState | null;
      try {
        loaded = await this.cacheStore.load();
      } catch (error) {
        if (
          mode !== 'full'
          || !(error instanceof LifecycleDiscoveryCacheCorruptError)
          || error instanceof LifecycleDiscoveryCacheUnsafePathError
        ) throw error;
        await this.cacheStore.quarantineCorrupt?.();
        loaded = null;
      }
      if (loaded !== null) this.conditionalRest.restoreCache(loaded.restCache);
      this.state = loaded;
      this.loaded = true;
    }
    return this.state;
  }

  async read(options: {
    readonly mode: 'incremental' | 'full';
    readonly rateLimitFloor: number;
    readonly resetUsage?: boolean;
  }): Promise<GitHubLifecycleSnapshot> {
    if (
      !Number.isSafeInteger(options.rateLimitFloor)
      || options.rateLimitFloor < DEFAULT_FLOOR
    ) {
      throw new Error(`Lifecycle rate-limit floor must be at least ${DEFAULT_FLOOR}`);
    }
    const prior = await this.loadState(options.mode);
    if (options.resetUsage !== false) this.fullReader.resetGitHubUsage?.();
    return options.mode === 'full'
      ? this.readFull(options.rateLimitFloor, prior)
      : this.readIncremental(options.rateLimitFloor, prior);
  }

  private async readFull(
    rateLimitFloor: number,
    prior: LifecycleDiscoveryState | null,
  ): Promise<GitHubLifecycleSnapshot> {
    const cycleStartedAt = exactNow(this.now);
    const cutoff = new Date(
      Date.parse(cycleStartedAt) - this.recentlyClosedOverlapMs,
    ).toISOString();
    let parityCandidate: IncrementalComputation | undefined;
    let parityUnavailableReason: string | undefined;
    if (prior?.evidence.snapshotMode === 'incremental') {
      try {
        parityCandidate = await this.computeIncremental(
          rateLimitFloor + FULL_SCAN_RESERVE,
          prior,
          false,
        );
      } catch (error) {
        parityUnavailableReason = `fresh incremental boundary candidate failed: ${
          error instanceof Error ? error.message : String(error)
        }`;
      }
    }
    const openBefore = await this.restDiscovery.readOpenPullRequestIndex();
    const closedBefore = await this.restDiscovery.readRecentlyClosedPullRequestIndex(cutoff);
    const oracleGraphQlCostAtStart = this.fullReader.githubUsage().graphqlCost;
    const provisional = await buildGitHubLifecycleSnapshot(this.fullReader, {
      authorAllowlist: this.authorAllowlist,
      rateLimitFloor,
      now: () => new Date(cycleStartedAt),
    });
    const openAfter = await this.restDiscovery.readOpenPullRequestIndex();
    if (!indexCollectionsMatch(openBefore, openAfter, 'open PR index')) {
      throw new IncrementalSnapshotInconsistentError(
        'open PR index changed across the full oracle boundary',
      );
    }
    const recentlyClosed = await this.restDiscovery.readRecentlyClosedPullRequestIndex(cutoff);
    if (!indexCollectionsMatch(
      closedBefore,
      recentlyClosed,
      'recently-closed PR index',
    )) {
      throw new IncrementalSnapshotInconsistentError(
        'recently-closed PR index changed across the full oracle boundary',
      );
    }
    const openByNumber = uniqueByNumber(openAfter, 'post-oracle open PR index');
    const closedByNumber = uniqueByNumber(recentlyClosed, 'full recently-closed PR index');
    for (const number of openByNumber.keys()) {
      if (closedByNumber.has(number)) {
        throw new IncrementalSnapshotInconsistentError(
          `PR #${number} appears in both full open and recently-closed indexes`,
        );
      }
    }
    if (parityCandidate !== undefined) {
      try {
        parityUnavailableReason = await this.parityBoundaryChange(parityCandidate) ?? undefined;
      } catch (error) {
        parityUnavailableReason = `parity boundary validation failed: ${
          error instanceof Error ? error.message : String(error)
        }`;
      }
    }
    const capturedAt = exactNow(this.now);
    const full = composeGitHubLifecycleSnapshot(provisional, {
      authorAllowlist: this.authorAllowlist,
      capturedAt,
      snapshotMode: 'full',
      lastFullReconciliationAt: capturedAt,
      githubUsage: this.fullReader.githubUsage(),
    });
    const oracleGraphQlCost = full.githubUsage!.graphqlCost - oracleGraphQlCostAtStart;
    if (!Number.isSafeInteger(oracleGraphQlCost) || oracleGraphQlCost < 0) {
      throw new Error('Full oracle returned inconsistent GraphQL usage evidence');
    }
    if (oracleGraphQlCost > FULL_SCAN_RESERVE) {
      throw new Error(
        `Full oracle consumed ${oracleGraphQlCost} GraphQL points; `
          + `the ${FULL_SCAN_RESERVE}-point acceptance threshold was exceeded`,
      );
    }
    let differences: readonly LifecycleParityDifference[] | undefined;
    if (parityCandidate !== undefined && parityUnavailableReason === undefined) {
      const candidateAtOracleCompletion = composeGitHubLifecycleSnapshot(
        parityCandidate.snapshot,
        {
          authorAllowlist: this.authorAllowlist,
          capturedAt: full.capturedAt,
          snapshotMode: 'incremental',
          lastFullReconciliationAt: parityCandidate.snapshot.lastFullReconciliationAt!,
          githubUsage: parityCandidate.snapshot.githubUsage!,
        },
      );
      differences = parityDifferences(candidateAtOracleCompletion, full);
    }
    const reconciled = differences === undefined && parityUnavailableReason === undefined
      ? full
      : composeGitHubLifecycleSnapshot(full, {
          authorAllowlist: this.authorAllowlist,
          capturedAt: full.capturedAt,
          snapshotMode: 'full',
          lastFullReconciliationAt: full.capturedAt,
          githubUsage: full.githubUsage!,
          ...(differences === undefined ? {} : { parityDifferences: differences }),
          ...(parityUnavailableReason === undefined
            ? {}
            : { parityUnavailableReason }),
        });
    const cacheBaseline = parityCandidate?.next ?? prior;
    const exactOpen = new Map<number, PullRequestSnapshot>();
    const previousOpen = cacheBaseline === null
      || cacheBaseline === undefined
      || cacheBaseline.openPullRequests === null
      ? new Map<number, PullRequestIndexEntry>()
      : uniqueByNumber(cacheBaseline.openPullRequests, 'cached open PR index');
    for (const candidate of cacheBaseline?.openPullRequestEvidence ?? []) {
      const current = openByNumber.get(candidate.number);
      const previous = previousOpen.get(candidate.number);
      if (
        current !== undefined
        && previous !== undefined
        && indexMatches(previous, current)
        && indexCoreMatches(current, candidate)
      ) {
        exactOpen.set(candidate.number, candidate);
      }
    }
    for (const candidate of reconciled.pullRequests.filter((pr) => pr.state === 'OPEN')) {
      const current = openByNumber.get(candidate.number);
      if (current === undefined || !indexCoreMatches(current, candidate)) {
        throw new IncrementalSnapshotInconsistentError(
          `full oracle PR #${candidate.number} is absent or changed in the REST baseline`,
        );
      }
      exactOpen.set(candidate.number, candidate);
    }
    const next: LifecycleDiscoveryState = {
      version: 1,
      evidence: evidence(reconciled),
      openPullRequestEvidence: [...exactOpen.values()]
        .sort((left, right) => left.number - right.number),
      openPullRequests: [...openAfter],
      recentlyClosedPullRequests: [...recentlyClosed],
      recentlyClosedCutoff: cutoff,
      restCache: this.conditionalRest.exportCache(),
    };
    await this.cacheStore.save(next);
    this.state = next;
    return reconciled;
  }

  private async readIncremental(
    rateLimitFloor: number,
    prior: LifecycleDiscoveryState | null,
  ): Promise<GitHubLifecycleSnapshot> {
    const computation = await this.computeIncremental(rateLimitFloor, prior);
    await this.cacheStore.save(computation.next);
    this.state = computation.next;
    return computation.snapshot;
  }

  private async computeIncremental(
    rateLimitFloor: number,
    prior: LifecycleDiscoveryState | null,
    allowGraphQl = true,
  ): Promise<IncrementalComputation> {
    if (prior === null) throw new IncrementalSnapshotUnavailableError();
    const lastFull = prior.evidence.lastFullReconciliationAt;
    const cycleStartedAt = exactNow(this.now);
    let liveGraphQlRemaining = await this.requireGraphQlRemaining();
    assertCompletedFloor(liveGraphQlRemaining, rateLimitFloor);
    const project = await this.restDiscovery.readProjectSnapshot({
      nowMs: Date.parse(cycleStartedAt),
    });
    const issueIndex = await this.restDiscovery.readOpenIssueIndex();
    const openIndex = await this.restDiscovery.readOpenPullRequestIndex();
    const closedIndex = await this.restDiscovery.readRecentlyClosedPullRequestIndex(
      prior.recentlyClosedCutoff,
    );
    const openByNumber = uniqueByNumber(openIndex, 'open PR index');
    const closedByNumber = uniqueByNumber(closedIndex, 'recently-closed PR index');
    for (const number of openByNumber.keys()) {
      if (closedByNumber.has(number)) {
        throw new IncrementalSnapshotInconsistentError(
          `PR #${number} appears in both open and recently-closed indexes`,
        );
      }
    }
    const issues = polledIssues(project, issueIndex);
    const openEvidence = uniqueByNumber(
      prior.openPullRequestEvidence,
      'cached open PR evidence',
    );
    const mergedEvidence = new Map(prior.evidence.pullRequests
      .filter((pr) => pr.state === 'MERGED')
      .map((pr) => [pr.number, pr]));
    const previousOpen = prior.openPullRequests === null
      ? null
      : uniqueByNumber(prior.openPullRequests, 'cached open PR index');
    const previousClosed = uniqueByNumber(
      prior.recentlyClosedPullRequests,
      'cached recently-closed PR index',
    );
    const changed = new Set<number>();

    const reviewClaimRefs = await this.requireReviewClaimRefs();
    for (const current of openIndex) {
      const cached = openEvidence.get(current.number);
      const previous = previousOpen?.get(current.number);
      if (cached === undefined) {
        if (previous === undefined || !indexMatches(previous, current)) {
          changed.add(current.number);
        }
        continue;
      }
      if (
        !indexCoreMatches(current, cached)
        || (previous !== undefined && !indexMatches(previous, current))
      ) {
        changed.add(current.number);
        continue;
      }
      const cachedClaimOid = cached.reviewClaim?.oid;
      if (reviewClaimRefs.get(current.number) !== cachedClaimOid) {
        changed.add(current.number);
        continue;
      }
      if (await this.evidenceProbe.changed(cached)) changed.add(current.number);
    }

    // A PR previously admitted as open must be re-read exactly when it drops
    // out of the complete open index; the absence alone cannot distinguish a
    // merge from a closed-unmerged PR.
    for (const cached of openEvidence.values()) {
      if (!openByNumber.has(cached.number)) {
        changed.add(cached.number);
      }
    }
    // Also discover PRs that were opened and closed entirely between polls.
    for (const closed of closedIndex) {
      const previous = previousClosed.get(closed.number);
      if (
        !openEvidence.has(closed.number)
        && !mergedEvidence.has(closed.number)
        && (previous === undefined || !indexMatches(previous, closed))
      ) {
        changed.add(closed.number);
      }
    }

    const branches = (await this.requireIncrementalBranchClaims())
      .map(decodeBranchClaimSnapshot);
    const activatedIssues = newlyActiveProjectIssues(prior.evidence.project, project);
    const hasUntrackedOpen = openIndex.some((entry) => !openEvidence.has(entry.number));
    const needsRelationRead = activatedIssues.length > 0 && hasUntrackedOpen;
    if (!allowGraphQl && (changed.size > 0 || needsRelationRead)) {
      const detail = changed.size > 0
        ? `exact PR hydration for ${[...changed]
            .sort((left, right) => left - right)
            .map((number) => `#${number}`)
            .join(', ')}`
        : `closing-PR relation discovery for issues ${activatedIssues
            .map((number) => `#${number}`)
            .join(', ')}`;
      throw new IncrementalSnapshotUnavailableError(
        `same-boundary parity candidate requires GraphQL ${detail}`,
      );
    }
    let relationRead = false;
    if (needsRelationRead) {
      liveGraphQlRemaining = await this.requireGraphQlRemaining();
      assertGraphQlReserve(
        liveGraphQlRemaining,
        TARGETED_RELATION_RESERVE,
        rateLimitFloor,
      );
      const candidates = await this.requireClosingPullRequestNumbers(activatedIssues);
      relationRead = true;
      const relationUsage = this.fullReader.githubUsage();
      if (relationUsage.graphqlRemaining === null) {
        throw new IncrementalSnapshotUnavailableError(
          'targeted closing-PR discovery returned no GraphQL quota evidence',
        );
      }
      liveGraphQlRemaining = relationUsage.graphqlRemaining;
      assertCompletedFloor(liveGraphQlRemaining, rateLimitFloor);
      for (const number of candidates) {
        if (!openByNumber.has(number)) {
          throw new IncrementalSnapshotInconsistentError(
            `targeted closing-PR candidate #${number} is absent from the open index`,
          );
        }
        if (!openEvidence.has(number)) changed.add(number);
      }
    }

    if (changed.size > 0 && !relationRead) {
      liveGraphQlRemaining = await this.requireGraphQlRemaining();
    }

    for (const number of [...changed].sort((left, right) => left - right)) {
      assertTargetedReserve(liveGraphQlRemaining, rateLimitFloor);
      const raw = await this.requireHydrator(number);
      const hydrationUsage = this.fullReader.githubUsage();
      if (hydrationUsage.graphqlRemaining === null) {
        throw new IncrementalSnapshotUnavailableError(
          `targeted hydration for PR #${number} returned no GraphQL quota evidence`,
        );
      }
      liveGraphQlRemaining = hydrationUsage.graphqlRemaining;
      assertCompletedFloor(liveGraphQlRemaining, rateLimitFloor);
      const indexedOpen = openByNumber.has(number);
      if (raw === null) {
        if (indexedOpen) {
          throw new IncrementalSnapshotInconsistentError(
            `open-index PR #${number} was closed during exact hydration`,
          );
        }
        openEvidence.delete(number);
        mergedEvidence.delete(number);
        continue;
      }
      const decoded = decodePullRequestSnapshot(raw);
      if (!indexedOpen && decoded.state === 'OPEN') {
        throw new IncrementalSnapshotInconsistentError(
          `disappeared PR #${number} remained open during exact hydration`,
        );
      }
      if (decoded.state === 'OPEN') {
        openEvidence.set(number, decoded);
        mergedEvidence.delete(number);
      } else {
        openEvidence.delete(number);
        if (relevantToLifecycle(decoded, project)) mergedEvidence.set(number, decoded);
        else mergedEvidence.delete(number);
      }
    }

    for (const [number, pr] of mergedEvidence) {
      if (!retainMerged(pr, project)) mergedEvidence.delete(number);
    }
    const usage = this.fullReader.githubUsage();
    assertCompletedFloor(usage.graphqlRemaining, rateLimitFloor);
    const capturedAt = exactNow(this.now);
    const snapshot = composeGitHubLifecycleSnapshot({
      project,
      issues,
      pullRequests: [
        ...[...openEvidence.values()].filter((pr) => relevantToLifecycle(pr, project)),
        ...mergedEvidence.values(),
      ].sort((left, right) => left.number - right.number),
      branches,
    }, {
      authorAllowlist: this.authorAllowlist,
      capturedAt,
      snapshotMode: 'incremental',
      lastFullReconciliationAt: lastFull,
      githubUsage: usage,
    });
    const next: LifecycleDiscoveryState = {
      version: 1,
      evidence: evidence(snapshot),
      openPullRequestEvidence: [...openEvidence.values()]
        .sort((left, right) => left.number - right.number),
      openPullRequests: [...openIndex],
      recentlyClosedPullRequests: [...closedIndex],
      recentlyClosedCutoff: prior.recentlyClosedCutoff,
      restCache: this.conditionalRest.exportCache(),
    };
    return { snapshot, next, openIssues: issueIndex, reviewClaimRefs };
  }

  private async parityBoundaryChange(
    candidate: IncrementalComputation,
  ): Promise<string | null> {
    const project = await this.restDiscovery.readProjectSnapshot({
      nowMs: Date.parse(candidate.snapshot.capturedAt),
    });
    if (!jsonMatches(
      projectDecisionInputs(candidate.snapshot.project),
      projectDecisionInputs(project),
    )) {
      return 'Project fields, items, Sprint, or native dependencies changed during the oracle';
    }

    const openIssues = await this.restDiscovery.readOpenIssueIndex();
    if (!jsonMatches(
      openIssueDecisionInputs(candidate.openIssues),
      openIssueDecisionInputs(openIssues),
    )) {
      return 'open issue index changed during the oracle';
    }

    const openPullRequests = await this.restDiscovery.readOpenPullRequestIndex();
    if (!indexCollectionsMatch(
      candidate.next.openPullRequests ?? [],
      openPullRequests,
      'parity open PR index',
    )) {
      return 'open PR index changed during the parity oracle';
    }
    const recentlyClosed = await this.restDiscovery.readRecentlyClosedPullRequestIndex(
      candidate.next.recentlyClosedCutoff,
    );
    if (!indexCollectionsMatch(
      candidate.next.recentlyClosedPullRequests,
      recentlyClosed,
      'parity recently-closed PR index',
    )) {
      return 'recently-closed PR index changed during the parity oracle';
    }

    for (const pr of candidate.next.openPullRequestEvidence) {
      if (await this.evidenceProbe.changed(pr)) {
        return `review, comment, or check evidence for PR #${pr.number} changed during the oracle`;
      }
    }

    const reviewClaimRefs = await this.requireReviewClaimRefs();
    if (!mapsMatch(candidate.reviewClaimRefs, reviewClaimRefs)) {
      return 'review-claim refs changed during the oracle';
    }

    const branches = (await this.requireIncrementalBranchClaims())
      .map(decodeBranchClaimSnapshot);
    if (!jsonMatches(
      branchDecisionInputs(candidate.snapshot.branches),
      branchDecisionInputs(branches),
    )) {
      return 'Autopilot branch refs changed during the oracle';
    }
    if (!jsonMatches(
      conditionalDiscoveryInputs(candidate.next.restCache),
      conditionalDiscoveryInputs(this.conditionalRest.exportCache()),
    )) {
      return 'conditional REST response fingerprint changed during the oracle';
    }
    return null;
  }

  private requireReviewClaimRefs(): Promise<ReadonlyMap<number, import('./types.js').GitOid>> {
    if (this.fullReader.readReviewClaimRefs === undefined) {
      throw new IncrementalSnapshotUnavailableError('review-claim git reader is unavailable');
    }
    return this.fullReader.readReviewClaimRefs();
  }

  private requireIncrementalBranchClaims() {
    if (this.fullReader.readIncrementalBranchClaims === undefined) {
      throw new IncrementalSnapshotUnavailableError(
        'Autopilot branch git reader is unavailable',
      );
    }
    return this.fullReader.readIncrementalBranchClaims();
  }

  private requireGraphQlRemaining(): Promise<number> {
    if (this.fullReader.readGraphQlRemaining === undefined) {
      throw new IncrementalSnapshotUnavailableError('GraphQL quota probe is unavailable');
    }
    return this.fullReader.readGraphQlRemaining();
  }

  private requireHydrator(number: number) {
    if (this.fullReader.readPullRequestForReconciliation === undefined) {
      throw new IncrementalSnapshotUnavailableError('targeted PR hydrator is unavailable');
    }
    return this.fullReader.readPullRequestForReconciliation(number);
  }

  private requireClosingPullRequestNumbers(
    issueNumbers: readonly number[],
  ): Promise<ReadonlySet<number>> {
    if (this.fullReader.readPullRequestNumbersClosingIssues === undefined) {
      throw new IncrementalSnapshotUnavailableError(
        'targeted issue-to-closing-PR discovery is unavailable',
      );
    }
    return this.fullReader.readPullRequestNumbersClosingIssues(issueNumbers);
  }
}
