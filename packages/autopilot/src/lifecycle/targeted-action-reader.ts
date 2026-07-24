import type { PolledIssue } from '../dispatcher/types.js';
import type {
  BlockedOn,
  Effort,
  IssueShape,
  Priority,
  ProjectStatus,
} from '../dispatcher/types.js';
import {
  assertRateLimitReserve,
  TARGETED_PROJECT_ITEM_RESERVE,
  TARGETED_PR_RESERVE,
  TARGETED_RELATION_RESERVE,
} from './github-usage.js';
import {
  composeGitHubLifecycleSnapshot,
  decodePullRequestSnapshot,
  type GitHubLifecycleSnapshot,
  type RawPullRequest,
} from './snapshot.js';

export interface TargetedNativeIssue {
  readonly number: number;
  readonly title: string;
  readonly open: boolean;
  readonly author: string;
  readonly labels: readonly string[];
}

export interface TargetedProjectItem {
  readonly id: string;
  readonly status: ProjectStatus | null;
  readonly priority?: Priority | null;
  readonly effort?: Effort | null;
  readonly blockedOn: BlockedOn | null;
  readonly issueType?: IssueShape | null;
}

export interface TargetedOpenPullRequest {
  readonly number: number;
  readonly headRefName: string;
  readonly headOid: string;
  readonly baseRefName: string;
  readonly draft: boolean;
  readonly labels: readonly string[];
  readonly body: string;
}

export interface TargetedIssueActionContext {
  readonly projectItem: TargetedProjectItem | null;
  readonly openPullRequests: readonly TargetedOpenPullRequest[];
}

export interface TargetedActionReaderOptions {
  readonly authorAllowlist: ReadonlySet<string>;
  readonly rateLimitFloor: number;
  readonly readGraphQlRemaining: () => Promise<number>;
  readonly readPullRequest: (prNumber: number) => Promise<RawPullRequest | null>;
  readonly readProjectItem: (issueNumber: number) => Promise<TargetedProjectItem | null>;
  readonly readIssue: (issueNumber: number) => Promise<TargetedNativeIssue | null>;
  readonly readBlockedByIssueNumbers: (issueNumber: number) => Promise<readonly number[]>;
  readonly readOpenPullRequestNumbersClosingIssue?: (
    issueNumber: number,
  ) => Promise<ReadonlySet<number>>;
  readonly readPullRequestDetails?: (
    prNumber: number,
  ) => Promise<TargetedOpenPullRequest | null>;
  /** One targeted GraphQL lookup combining Project and closing-PR relation evidence. */
  readonly readIssueActionContext?: (
    issueNumber: number,
  ) => Promise<{
    readonly projectItem: TargetedProjectItem | null;
    readonly openPullRequestNumbers: ReadonlySet<number>;
  }>;
}

export interface TargetedIssueSnapshot {
  readonly native: TargetedNativeIssue;
  readonly source: PolledIssue;
  readonly projectItem: TargetedProjectItem;
  readonly openPullRequests?: readonly TargetedOpenPullRequest[];
  readonly snapshot: GitHubLifecycleSnapshot;
}

export interface TargetedActionReader {
  readPullRequest(
    cycleSnapshot: GitHubLifecycleSnapshot,
    prNumber: number,
  ): Promise<GitHubLifecycleSnapshot | null>;
  readIssue(
    cycleSnapshot: GitHubLifecycleSnapshot,
    issueNumber: number,
  ): Promise<TargetedIssueSnapshot | null>;
  readProjectItem(issueNumber: number): Promise<TargetedProjectItem | null>;
  readOpenPullRequests(issueNumber: number): Promise<readonly TargetedOpenPullRequest[]>;
  readIssueActionContext?(issueNumber: number): Promise<TargetedIssueActionContext>;
}

function positiveNumber(value: number, subject: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${subject} must be a positive integer`);
  }
}

function completeCycle(snapshot: GitHubLifecycleSnapshot): asserts snapshot is GitHubLifecycleSnapshot & {
  readonly lastFullReconciliationAt: string;
  readonly githubUsage: NonNullable<GitHubLifecycleSnapshot['githubUsage']>;
} {
  if (
    snapshot.snapshotComplete !== true
    || snapshot.lastFullReconciliationAt === null
    || snapshot.lastFullReconciliationAt === undefined
    || snapshot.githubUsage === undefined
  ) {
    throw new Error('Targeted action authority requires a complete cycle snapshot');
  }
}

function issueNumbers(raw: RawPullRequest): readonly number[] {
  const numbers = new Set(raw.closingIssueNumbers);
  const marker = /<!-- jinn-autopilot:v2 issue=([1-9][0-9]*) branch=([^ >]+) -->/
    .exec(raw.body);
  if (marker?.[1] !== undefined) numbers.add(Number(marker[1]));
  if (raw.humanIssueNumber !== undefined && raw.humanIssueNumber !== null) {
    numbers.add(raw.humanIssueNumber);
  }
  return [...numbers];
}

function exactLiveBlocker(
  live: RawPullRequest,
  cycle: GitHubLifecycleSnapshot['pullRequests'][number],
  dependencies: readonly number[],
): boolean {
  const closing = new Set(live.closingIssueNumbers);
  const dependency = dependencies.find((number) => cycle.closingIssueNumbers.includes(number));
  if (
    dependency === undefined
    || live.headOid !== cycle.headOid
    || live.headRefName !== cycle.headRefName
    || closing.size !== live.closingIssueNumbers.length
    || closing.size !== 1
    || !closing.has(dependency)
  ) return false;
  const markers = [...live.body.matchAll(
    /<!-- jinn-autopilot:v2 issue=([1-9][0-9]*) branch=([^ >]+) -->/g,
  )];
  return markers.length === 0 || (
    markers.length === 1
    && Number(markers[0]![1]) === dependency
    && markers[0]![2] === live.headRefName
  );
}

function projectWithTarget(
  cycle: GitHubLifecycleSnapshot,
  issueNumber: number,
  target: TargetedProjectItem,
): GitHubLifecycleSnapshot['project'] {
  const found = cycle.project.items.some((item) => (
    item.contentType === 'Issue' && item.number === issueNumber
  ));
  if (!found) throw new Error(`Target issue #${issueNumber} is absent from the cycle Project`);
  return {
    ...cycle.project,
    items: cycle.project.items.map((item) => (
      item.contentType === 'Issue' && item.number === issueNumber
        ? {
            ...item,
            id: target.id,
            status: target.status,
            priority: target.priority === undefined ? item.priority : target.priority,
            effort: target.effort === undefined ? item.effort : target.effort,
            blockedOn: target.blockedOn,
            issueType: target.issueType === undefined ? item.issueType : target.issueType,
          }
        : item
    )),
  };
}

function composeTargeted(
  cycle: GitHubLifecycleSnapshot,
  evidence: {
    readonly project?: GitHubLifecycleSnapshot['project'];
    readonly issues?: readonly PolledIssue[];
    readonly pullRequests?: GitHubLifecycleSnapshot['pullRequests'];
  },
  authorAllowlist: ReadonlySet<string>,
): GitHubLifecycleSnapshot {
  completeCycle(cycle);
  return composeGitHubLifecycleSnapshot({
    project: evidence.project ?? cycle.project,
    issues: evidence.issues ?? cycle.issues,
    pullRequests: evidence.pullRequests ?? cycle.pullRequests,
    branches: cycle.branches,
  }, {
    authorAllowlist,
    capturedAt: cycle.capturedAt,
    snapshotMode: cycle.snapshotMode ?? 'incremental',
    lastFullReconciliationAt: cycle.lastFullReconciliationAt,
    githubUsage: cycle.githubUsage,
  });
}

export function makeTargetedActionReader(
  options: TargetedActionReaderOptions,
): TargetedActionReader {
  const reserve = async (points: number): Promise<void> => {
    assertRateLimitReserve(
      await options.readGraphQlRemaining(),
      points,
      options.rateLimitFloor,
    );
  };
  const hydrateIssueContext = async (
    issueNumber: number,
  ): Promise<TargetedIssueActionContext> => {
    if (
      options.readIssueActionContext === undefined
      || options.readPullRequestDetails === undefined
    ) {
      if (
        options.readOpenPullRequestNumbersClosingIssue === undefined
        || options.readPullRequestDetails === undefined
      ) {
        throw new Error('Targeted issue-action context reader is unavailable');
      }
      const [projectItem, numbers] = await Promise.all([
        options.readProjectItem(issueNumber),
        options.readOpenPullRequestNumbersClosingIssue(issueNumber),
      ]);
      const openPullRequests: TargetedOpenPullRequest[] = [];
      for (const number of [...numbers].sort((left, right) => left - right)) {
        const pr = await options.readPullRequestDetails(number);
        if (pr === null) continue;
        if (pr.number !== number) {
          throw new Error('Targeted PR detail reader returned a different PR');
        }
        openPullRequests.push(pr);
      }
      return { projectItem, openPullRequests };
    }
    const raw = await options.readIssueActionContext(issueNumber);
    const openPullRequests: TargetedOpenPullRequest[] = [];
    for (const number of [...raw.openPullRequestNumbers].sort((left, right) => left - right)) {
      const pr = await options.readPullRequestDetails(number);
      if (pr === null) continue;
      if (pr.number !== number) {
        throw new Error('Targeted PR detail reader returned a different PR');
      }
      openPullRequests.push(pr);
    }
    return { projectItem: raw.projectItem, openPullRequests };
  };
  const readCombinedContext = async (
    issueNumber: number,
  ): Promise<TargetedIssueActionContext> => {
    positiveNumber(issueNumber, 'Target issue number');
    await reserve(TARGETED_RELATION_RESERVE);
    return hydrateIssueContext(issueNumber);
  };
  return {
    async readPullRequest(cycleSnapshot, prNumber) {
      positiveNumber(prNumber, 'Target PR number');
      completeCycle(cycleSnapshot);
      await reserve(TARGETED_PR_RESERVE);
      const raw = await options.readPullRequest(prNumber);
      if (raw === null) return null;
      if (raw.number !== prNumber) throw new Error('Targeted PR reader returned a different PR');
      const mapped = issueNumbers(raw);
      if (mapped.length !== 1) {
        throw new Error(`Target PR #${prNumber} does not map to exactly one native issue`);
      }
      const issueNumber = mapped[0]!;
      const native = await options.readIssue(issueNumber);
      if (native === null || native.number !== issueNumber) {
        throw new Error(`Target PR #${prNumber} mapped native issue is missing`);
      }
      if (!native.open && raw.state === 'OPEN') {
        throw new Error(`Target PR #${prNumber} mapped native issue #${issueNumber} is closed`);
      }
      const item = await options.readProjectItem(issueNumber);
      if (item === null) {
        throw new Error(`Target issue #${issueNumber} has no live Project item`);
      }
      const existingIssue = cycleSnapshot.issues.find((issue) => issue.number === issueNumber);
      if (existingIssue === undefined) {
        throw new Error(`Target issue #${issueNumber} is absent from the cycle snapshot`);
      }
      const dependencies = await options.readBlockedByIssueNumbers(issueNumber);
      const liveIssue: PolledIssue = {
        ...existingIssue,
        title: native.title,
        author: native.author,
        labels: [...native.labels],
        status: item.status,
        priority: item.priority === undefined ? existingIssue.priority : item.priority,
        effort: item.effort === undefined ? existingIssue.effort : item.effort,
        shape: item.issueType === undefined ? existingIssue.shape : item.issueType,
        blockedOn: item.blockedOn,
        blockedByIssues: [...dependencies],
        projectItemId: item.id,
      };
      const issues = cycleSnapshot.issues.map((issue) => (
        issue.number === issueNumber ? liveIssue : issue
      ));
      const project = projectWithTarget(cycleSnapshot, issueNumber, item);
      const decoded = decodePullRequestSnapshot(raw);
      const pullRequests = cycleSnapshot.pullRequests.some((pr) => pr.number === prNumber)
        ? cycleSnapshot.pullRequests.map((pr) => pr.number === prNumber ? decoded : pr)
        : [...cycleSnapshot.pullRequests, decoded];
      return composeTargeted(
        cycleSnapshot,
        { project, issues, pullRequests },
        options.authorAllowlist,
      );
    },

    async readIssue(cycleSnapshot, issueNumber) {
      positiveNumber(issueNumber, 'Target issue number');
      completeCycle(cycleSnapshot);
      await reserve(TARGETED_PR_RESERVE);
      const native = await options.readIssue(issueNumber);
      if (native === null) return null;
      if (native.number !== issueNumber) {
        throw new Error('Targeted issue reader returned a different issue');
      }
      const existing = cycleSnapshot.issues.find((issue) => issue.number === issueNumber);
      if (existing === undefined) {
        throw new Error(`Target issue #${issueNumber} is absent from the cycle snapshot`);
      }
      const context = options.readIssueActionContext === undefined
        ? { projectItem: await options.readProjectItem(issueNumber), openPullRequests: [] }
        : await hydrateIssueContext(issueNumber);
      const item = context.projectItem;
      if (item === null) throw new Error(`Target issue #${issueNumber} has no live Project item`);
      const dependencies = await options.readBlockedByIssueNumbers(issueNumber);
      const expectedDependencies = [...existing.blockedByIssues].sort((left, right) => left - right);
      const liveDependencies = [...dependencies].sort((left, right) => left - right);
      if (
        expectedDependencies.length !== liveDependencies.length
        || expectedDependencies.some((number, index) => number !== liveDependencies[index])
      ) {
        throw new Error('Targeted implementation dependencies changed since the cycle snapshot');
      }
      const openBlockerPullRequests = cycleSnapshot.pullRequests.filter((pr) => (
        pr.state === 'OPEN'
        && liveDependencies.some((blocker) => pr.closingIssueNumbers.includes(blocker))
      ));
      if (openBlockerPullRequests.length > 1) {
        throw new Error('Targeted implementation has more than one open blocker PR');
      }
      let pullRequests = cycleSnapshot.pullRequests;
      const blocker = openBlockerPullRequests[0];
      if (blocker !== undefined) {
        const liveBlocker = await options.readPullRequest(blocker.number);
        if (
          liveBlocker === null
          || liveBlocker.number !== blocker.number
          || liveBlocker.state !== 'OPEN'
          || !exactLiveBlocker(liveBlocker, blocker, liveDependencies)
        ) {
          throw new Error('Targeted blocker PR authority changed');
        }
        const decodedBlocker = decodePullRequestSnapshot(liveBlocker);
        pullRequests = cycleSnapshot.pullRequests.map((pr) => (
          pr.number === blocker.number ? decodedBlocker : pr
        ));
      }
      const source: PolledIssue = {
        ...existing,
        title: native.title,
        author: native.author,
        labels: [...native.labels],
        status: item.status,
        priority: item.priority === undefined ? existing.priority : item.priority,
        effort: item.effort === undefined ? existing.effort : item.effort,
        shape: item.issueType === undefined ? existing.shape : item.issueType,
        blockedOn: item.blockedOn,
        blockedByIssues: [...dependencies],
        projectItemId: item.id,
      };
      const issues = cycleSnapshot.issues.map((issue) => (
        issue.number === issueNumber ? source : issue
      ));
      const project = projectWithTarget(cycleSnapshot, issueNumber, item);
      return {
        native,
        source,
        projectItem: item,
        ...(options.readIssueActionContext === undefined
          ? {}
          : { openPullRequests: context.openPullRequests }),
        snapshot: composeTargeted(
          cycleSnapshot,
          { project, issues, pullRequests },
          options.authorAllowlist,
        ),
      };
    },

    async readProjectItem(issueNumber) {
      positiveNumber(issueNumber, 'Target issue number');
      await reserve(TARGETED_PROJECT_ITEM_RESERVE);
      return options.readProjectItem(issueNumber);
    },

    async readOpenPullRequests(issueNumber) {
      return (await readCombinedContext(issueNumber)).openPullRequests ?? [];
    },

    readIssueActionContext(issueNumber) {
      return readCombinedContext(issueNumber);
    },
  };
}
