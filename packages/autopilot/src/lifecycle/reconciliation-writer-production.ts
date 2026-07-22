import {
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CommandRunner } from '../dispatcher/issue-source.js';
import { defaultRunner } from '../dispatcher/issue-source.js';
import { REPO } from '../dispatcher/constants.js';
import { NEEDS_HUMAN_LABEL } from '../dispatcher/merge-sweep.js';
import type { BlockedOn, ProjectStatus } from '../dispatcher/types.js';
import {
  IMPLEMENTATION_SUMMARY_END,
  IMPLEMENTATION_SUMMARY_START,
} from './implementation-session.js';
import {
  decodeReviewClaimPayload,
  encodeReviewClaimPayload,
} from './codecs.js';
import {
  gitPublicationArgs,
  type SelectedCredential,
} from './credentials.js';
import { makeGitProtocolPort } from './git-protocol.js';
import { readIssueCommentBodies } from './github-comments.js';
import { CANONICAL_GITHUB_HTTPS_REMOTE } from './implementation-executor.js';
import { withSelectedCredential } from './production-auth.js';
import type {
  ReconciliationPullRequestState,
  ReconciliationReviewRefState,
  ReconciliationWriter,
} from './reconciler.js';
import type { GitHubLifecycleSnapshot } from './snapshot.js';
import type {
  TargetedIssueActionContext,
  TargetedNativeIssue,
  TargetedOpenPullRequest,
} from './targeted-action-reader.js';
import {
  gitOid,
  type GitOid,
  type HumanReason,
  type ReviewClaimRecord,
} from './types.js';

/**
 * Minimal per-PR node shape the writer's exact-state pre-checks and
 * read-backs need. `RawPullRequest` (the shape github-reader.ts's
 * `readPullRequestForReconciliation` returns) satisfies this structurally,
 * so callers can wire that method straight in as `readPullRequestByNumber`.
 */
export interface ReconciliationPullRequestNode {
  readonly state: 'OPEN' | 'MERGED';
  readonly headRefName: string;
  readonly headOid: string;
  readonly baseRefName: string;
  readonly isDraft: boolean;
  readonly labels: readonly string[];
  readonly body: string;
  readonly closingIssueNumbers: readonly number[];
  readonly humanIssueNumber?: number | null;
  readonly humanReason?: HumanReason | null;
  readonly reviewClaim: { readonly oid: string; readonly payload: string } | null;
}

/**
 * Minimal per-issue Project item shape the writer's `readProjectStatus` /
 * `setProjectStatus` need. `github-reader.ts`'s
 * `readProjectItemForReconciliation` satisfies this structurally.
 */
export interface ReconciliationProjectItemNode {
  readonly id: string;
  readonly status: ProjectStatus | null;
  readonly blockedOn: BlockedOn | null;
}

export interface ProductionReconciliationWriterOptions {
  readonly repositoryPath: string;
  /** Immutable complete snapshot that produced this cycle's projection plan. */
  readonly cycleSnapshot: GitHubLifecycleSnapshot;
  /**
   * Cheap, always-fresh single-PR read (~7-8 GraphQL points, versus ~390 for
   * a full `readSnapshot`) backing every exact-state PR pre-check and
   * post-mutation read-back in this writer. Returns `null` when the PR is
   * not open or merged. Required: there is deliberately no full-world
   * fallback.
   */
  readonly readPullRequestByNumber: (
    prNumber: number,
  ) => Promise<ReconciliationPullRequestNode | null>;
  /**
   * Cheap, always-fresh single-issue Project-item read (a targeted
   * `Issue.projectItems` lookup, not a full board paginate) backing
   * `readProjectStatus` and `setProjectStatus`'s exact-state pre-check and
   * post-mutation read-back. Required: there is deliberately no full-world
   * fallback.
   */
  readonly readProjectItemForReconciliation: (
    issueNumber: number,
  ) => Promise<ReconciliationProjectItemNode | null>;
  /** Exact git-transport branch/ref read. Never backed by a world snapshot. */
  readonly readBranchHeadByName: (headRefName: string) => Promise<GitOid | null>;
  readonly readIssueByNumber: (issueNumber: number) => Promise<TargetedNativeIssue | null>;
  readonly readBlockedByIssueNumbers: (issueNumber: number) => Promise<readonly number[]>;
  readonly readOpenPullRequestsByIssue: (
    issueNumber: number,
  ) => Promise<readonly TargetedOpenPullRequest[]>;
  /** Combined Project + native closing-relation authority (two-point budget). */
  readonly readIssueActionContext: (
    issueNumber: number,
  ) => Promise<TargetedIssueActionContext>;
  readonly credential: SelectedCredential;
  readonly runner?: CommandRunner;
  readonly environment?: NodeJS.ProcessEnv;
  readonly now?: () => Date;
}

interface ActionAuthorityScope {
  readonly pullRequests: Map<number, Promise<ReconciliationPullRequestNode | null>>;
  readonly issues: Map<number, Promise<TargetedIssueActionContext>>;
}

function completionBody(body: string, summary: string): string {
  const section =
    `${IMPLEMENTATION_SUMMARY_START}\n${summary.trim()}\n${IMPLEMENTATION_SUMMARY_END}`;
  const start = body.indexOf(IMPLEMENTATION_SUMMARY_START);
  const end = body.indexOf(IMPLEMENTATION_SUMMARY_END);
  if (start === -1 && end === -1) return `${body.trimEnd()}\n\n${section}\n`;
  if (start === -1 || end < start) {
    throw new Error('Contradictory implementation summary markers in PR body');
  }
  return `${body.slice(0, start)}${section}${
    body.slice(end + IMPLEMENTATION_SUMMARY_END.length)
  }`;
}

async function mutateWithExactReadback(
  mutate: () => Promise<unknown>,
  confirmed: () => Promise<boolean>,
  ambiguityMessage: string,
): Promise<void> {
  let mutationError: unknown;
  try {
    await mutate();
  } catch (error) {
    mutationError = error;
  }
  let exact = false;
  try {
    exact = await confirmed();
  } catch (readbackError) {
    if (mutationError !== undefined) throw mutationError;
    throw readbackError;
  }
  if (exact) return;
  if (mutationError !== undefined) throw mutationError;
  throw new Error(ambiguityMessage);
}

// The helpers below all read a single already-fetched PR node — no world
// snapshot involved (jinn-mono#1883). `raw` comes from the writer's cheap
// `readPullRequestByNumber` per-PR read.

function pullRequestStateFromRaw(
  raw: ReconciliationPullRequestNode | null,
): ReconciliationPullRequestState | null {
  if (raw === null || raw.state !== 'OPEN') return null;
  return {
    head: gitOid(raw.headOid),
    draft: raw.isDraft,
    labels: [...raw.labels],
  };
}

function reviewRefStateFromRaw(
  raw: ReconciliationPullRequestNode | null,
): ReconciliationReviewRefState | null {
  const claim = raw?.reviewClaim;
  if (claim === undefined || claim === null) return null;
  const record = decodeReviewClaimPayload(claim.payload);
  return {
    oid: gitOid(claim.oid),
    head: record.head,
    state: record.state,
  };
}

function autopilotMarkers(body: string): readonly {
  readonly issueNumber: number;
  readonly headRefName: string;
}[] {
  return [...body.matchAll(
    /<!-- jinn-autopilot:v2 issue=([1-9][0-9]*) branch=([^ >]+) -->/g,
  )].map((match) => ({
    issueNumber: Number(match[1]),
    headRefName: match[2]!,
  }));
}

function exactDraftRelation(
  pullRequest: TargetedOpenPullRequest,
  expected: {
    readonly headRefName: string;
    readonly head: GitOid;
    readonly baseRefName: string;
    readonly body: string;
  },
): boolean {
  return pullRequest.headRefName === expected.headRefName
    && gitOid(pullRequest.headOid) === expected.head
    && pullRequest.baseRefName === expected.baseRefName
    && pullRequest.body === expected.body
    && pullRequest.draft
    && pullRequest.labels.includes('engine:review');
}

function exactDraftIdentity(
  pullRequest: TargetedOpenPullRequest,
  expected: {
    readonly headRefName: string;
    readonly head: GitOid;
    readonly baseRefName: string;
    readonly body: string;
  },
): boolean {
  return pullRequest.headRefName === expected.headRefName
    && gitOid(pullRequest.headOid) === expected.head
    && pullRequest.baseRefName === expected.baseRefName
    && pullRequest.body === expected.body;
}

function humanDominatesPullRequest(
  snapshot: GitHubLifecycleSnapshot,
  prNumber: number,
): boolean {
  const pr = snapshot.pullRequests.find((candidate) => candidate.number === prNumber);
  const lifecycle = snapshot.lifecycle.items.find((item) =>
    item.kind === 'pull-request' && item.prNumber === prNumber);
  return pr?.labels.includes(NEEDS_HUMAN_LABEL) === true
    || (
      lifecycle?.kind === 'pull-request'
      && (
        lifecycle.humanHold === true
        || lifecycle.projectStatus === 'Human'
      )
    );
}

function nextReviewRecord(
  current: ReviewClaimRecord,
  state: 'terminal-approved' | 'stale',
  recordedAt: string,
): ReviewClaimRecord {
  const common = {
    kind: 'review-claim' as const,
    protocolVersion: 2 as const,
    prNumber: current.prNumber,
    generation: current.generation,
    attempt: current.attempt,
    reviewer: current.reviewer,
    head: current.head,
    recordedAt,
  };
  if (state === 'terminal-approved') {
    if (
      current.state !== 'verdict-intent'
      || current.verdict.state !== 'APPROVE'
    ) {
      throw new Error('Only an APPROVE verdict intent can become terminal-approved');
    }
    return {
      ...common,
      state,
      verdict: {
        marker: current.verdict.marker,
        state: 'APPROVE',
      },
    };
  }
  return { ...common, state };
}

export function makeProductionReconciliationWriter(
  options: ProductionReconciliationWriterOptions,
): ReconciliationWriter {
  return makeProductionReconciliationWriterWithScope(options, null);
}

function makeProductionReconciliationWriterWithScope(
  options: ProductionReconciliationWriterOptions,
  actionAuthority: ActionAuthorityScope | null,
): ReconciliationWriter {
  const runner = options.runner ?? defaultRunner;
  const ambient = options.environment ?? process.env;
  const now = options.now ?? (() => new Date());
  if (options.cycleSnapshot.snapshotComplete !== true) {
    throw new Error('Reconciliation writer requires a complete cycle snapshot');
  }
  const invalidateActionAuthority = (): void => {
    actionAuthority?.pullRequests.clear();
    actionAuthority?.issues.clear();
  };
  const readRawPr = (prNumber: number): Promise<ReconciliationPullRequestNode | null> => {
    if (actionAuthority === null) return options.readPullRequestByNumber(prNumber);
    const cached = actionAuthority.pullRequests.get(prNumber);
    if (cached !== undefined) return cached;
    const read = options.readPullRequestByNumber(prNumber);
    actionAuthority.pullRequests.set(prNumber, read);
    return read;
  };
  const readIssueContext = (issueNumber: number): Promise<TargetedIssueActionContext> => {
    const load = () => options.readIssueActionContext(issueNumber);
    if (actionAuthority === null) return load();
    const cached = actionAuthority.issues.get(issueNumber);
    if (cached !== undefined) return cached;
    const read = load();
    actionAuthority.issues.set(issueNumber, read);
    return read;
  };
  const readProjectItem = async (issueNumber: number) => (
    await readIssueContext(issueNumber)
  ).projectItem;
  const readOpenPullRequestsByIssue = async (issueNumber: number) => (
    await readIssueContext(issueNumber)
  ).openPullRequests;
  const selected = <Value>(
    operation: Parameters<typeof withSelectedCredential<Value>>[2],
  ): Promise<Value> => withSelectedCredential(
    options.credential,
    ambient,
    operation,
    runner,
  );
  type LiveMapping =
    | { readonly kind: 'normal'; readonly issueNumber: number }
    | { readonly kind: 'diagnostic' };
  const validateLiveMapping = (
    prNumber: number,
    raw: ReconciliationPullRequestNode,
  ): LiveMapping => {
    const lifecycle = options.cycleSnapshot.lifecycle.items.find((item) => (
      item.kind === 'pull-request' && item.prNumber === prNumber
    ));
    const cyclePr = options.cycleSnapshot.pullRequests.find((pr) => pr.number === prNumber);
    const diagnostics = options.cycleSnapshot.diagnostics.filter((diagnostic) => (
      diagnostic.pullRequests.some((pr) => pr.number === prNumber)
    ));
    if (lifecycle?.kind !== 'pull-request') {
      const diagnosticPrs = diagnostics.flatMap((diagnostic) => (
        diagnostic.pullRequests.filter((pr) => pr.number === prNumber)
      ));
      if (
        cyclePr !== undefined
        && diagnostics.length === 1
        && diagnosticPrs.length === 1
        && diagnosticPrs[0]!.head === gitOid(raw.headOid)
        && cyclePr.headOid === gitOid(raw.headOid)
        && cyclePr.headRefName === raw.headRefName
      ) {
        return { kind: 'diagnostic' };
      }
      throw new Error(`Live PR #${prNumber} mapping is absent from cycle context`);
    }
    if (cyclePr === undefined) {
      throw new Error(`Live PR #${prNumber} mapping is absent from cycle context`);
    }
    const issueNumber = lifecycle.issueNumber;
    const closing = new Set(raw.closingIssueNumbers);
    if (
      closing.size !== raw.closingIssueNumbers.length
      || closing.size !== 1
      || !closing.has(issueNumber)
    ) {
      throw new Error(`Live PR #${prNumber} closing-ref mapping no longer names issue #${issueNumber}`);
    }
    const markers = autopilotMarkers(raw.body);
    if (
      raw.headRefName !== cyclePr.headRefName
      || markers.length !== 1
      || markers[0]!.issueNumber !== issueNumber
      || markers[0]!.headRefName !== raw.headRefName
    ) {
      throw new Error(`Live PR #${prNumber} marker mapping no longer names issue #${issueNumber}`);
    }
    if (
      raw.humanIssueNumber !== undefined
      && raw.humanIssueNumber !== null
      && raw.humanIssueNumber !== issueNumber
    ) {
      throw new Error(`Live PR #${prNumber} Human mapping no longer names issue #${issueNumber}`);
    }
    if (raw.humanReason !== undefined && raw.humanReason !== null) {
      if (raw.humanIssueNumber !== issueNumber) {
        throw new Error(`Live PR #${prNumber} Human reason has no exact issue mapping`);
      }
    }
    return { kind: 'normal', issueNumber };
  };
  const readMappedRawPr = async (
    prNumber: number,
  ): Promise<ReconciliationPullRequestNode | null> => {
    const raw = await readRawPr(prNumber);
    if (raw !== null) validateLiveMapping(prNumber, raw);
    return raw;
  };
  const readPr = async (prNumber: number) =>
    pullRequestStateFromRaw(await readMappedRawPr(prNumber));
  const readReview = async (prNumber: number) =>
    reviewRefStateFromRaw(await readMappedRawPr(prNumber));
  const liveIssueHead = async (issueNumber: number): Promise<GitOid | null> => {
    const lifecyclePr = options.cycleSnapshot.lifecycle.items.find((item) => (
      item.kind === 'pull-request' && item.issueNumber === issueNumber
    ));
    if (lifecyclePr?.kind === 'pull-request') {
      const pr = await readRawPr(lifecyclePr.prNumber);
      const mapping = pr === null ? null : validateLiveMapping(lifecyclePr.prNumber, pr);
      if (mapping !== null && (
        mapping.kind !== 'normal' || mapping.issueNumber !== issueNumber
      )) {
        throw new Error(`Live PR mapping no longer names issue #${issueNumber}`);
      }
      return pr === null ? null : gitOid(pr.headOid);
    }
    const branch = options.cycleSnapshot.branches.find((entry) => (
      entry.issueNumber === issueNumber
    ));
    return branch === undefined
      ? null
      : options.readBranchHeadByName(branch.headRefName);
  };
  const liveHumanDominatesPullRequest = async (
    prNumber: number,
    supplied?: ReconciliationPullRequestNode | null,
  ): Promise<boolean> => {
    const raw = supplied === undefined ? await readMappedRawPr(prNumber) : supplied;
    const mapping = raw === null ? null : validateLiveMapping(prNumber, raw);
    if (mapping?.kind === 'diagnostic') return true;
    if (humanDominatesPullRequest(options.cycleSnapshot, prNumber)) return true;
    if (raw?.labels.includes(NEEDS_HUMAN_LABEL) === true) return true;
    if (raw?.humanReason !== undefined && raw.humanReason !== null) return true;
    const lifecycle = options.cycleSnapshot.lifecycle.items.find((item) => (
      item.kind === 'pull-request' && item.prNumber === prNumber
    ));
    if (lifecycle?.kind !== 'pull-request') return true;
    const project = await readProjectItem(lifecycle.issueNumber);
    return project === null || project.status === 'Human' || project.blockedOn === 'Human';
  };
  const updateReviewRef = async (
    prNumber: number,
    expectedReviewRefOid: GitOid,
    desired: 'terminal-approved' | 'stale',
  ): Promise<void> => {
    const beforeRaw = await readMappedRawPr(prNumber);
    const beforeClaim = beforeRaw?.reviewClaim;
    if (
      beforeClaim === undefined
      || beforeClaim === null
      || gitOid(beforeClaim.oid) !== expectedReviewRefOid
    ) {
      throw new Error('Review-ref authority changed before reconciliation');
    }
    const beforeRecord = decodeReviewClaimPayload(beforeClaim.payload);
    // The immutable cycle supplies lifecycle context; targeted PR and Project
    // reads refresh the mutable Human-dominance evidence.
    if (await liveHumanDominatesPullRequest(prNumber, beforeRaw)) {
      throw new Error('Human is dominant over review-ref reconciliation');
    }
    if (
      desired !== 'stale'
      && (beforeRaw === null || gitOid(beforeRaw.headOid) !== beforeRecord.head)
    ) {
      throw new Error('Review-ref reconciliation lost exact-head authority');
    }
    const record = nextReviewRecord(
      beforeRecord,
      desired,
      now().toISOString(),
    );
    await selected(async ({ askpass, run }) => {
      const directory = mkdtempSync(join(tmpdir(), 'jinn-reconcile-review-'));
      const payloadPath = join(directory, 'jinn-autopilot-review.json');
      const indexPath = join(directory, 'index');
      const localEnvironment = { GIT_INDEX_FILE: indexPath };
      const git = (args: readonly string[], env = localEnvironment) => run(
        'git',
        ['-C', options.repositoryPath, ...args],
        { env },
      );
      try {
        writeFileSync(
          payloadPath,
          `${encodeReviewClaimPayload(record)}\n`,
          { mode: 0o600 },
        );
        await git(['read-tree', '--empty']);
        const blob = gitOid((await git([
          'hash-object', '-w', payloadPath,
        ])).trim());
        await git([
          'update-index', '--add',
          '--cacheinfo', `100644,${blob},jinn-autopilot-review.json`,
        ]);
        const tree = gitOid((await git(['write-tree'])).trim());
        const recordOid = gitOid((await git([
          'commit-tree', tree,
          '-p', expectedReviewRefOid,
          '-m', 'Autopilot reconciliation review metadata',
        ])).trim());
        const secureGit = (
          _command: 'git',
          args: readonly string[],
        ) => run('git', [
          ...gitPublicationArgs(askpass, []),
          '-C', options.repositoryPath,
          ...args,
        ]);
        await mutateWithExactReadback(
          async () => {
            invalidateActionAuthority();
            const outcome = await makeGitProtocolPort(secureGit, {
              remote: CANONICAL_GITHUB_HTTPS_REMOTE,
            }).publishReviewClaim({
              prNumber,
              recordParent: expectedReviewRefOid,
              expectedRemoteRecordOid: expectedReviewRefOid,
              recordOid,
            });
            if (
              outcome.status !== 'won'
              && outcome.status !== 'already-applied'
            ) {
              throw new Error(`Review-ref reconciliation ${outcome.status}`);
            }
          },
          async () => {
            const after = await readReview(prNumber);
            return after?.oid === recordOid
              && after.head === record.head
              && after.state === desired;
          },
          'Review-ref reconciliation was ambiguous',
        );
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    });
  };

  return {
    actionScope() {
      return makeProductionReconciliationWriterWithScope(options, {
        pullRequests: new Map(),
        issues: new Map(),
      });
    },

    async readIssueHead(issueNumber) {
      return liveIssueHead(issueNumber);
    },

    async readBranchHead(headRefName) {
      const currentPr = options.cycleSnapshot.pullRequests.find((pr) => (
        pr.state === 'OPEN' && pr.headRefName === headRefName
      ));
      if (currentPr !== undefined) {
        const raw = await readRawPr(currentPr.number);
        if (raw !== null) validateLiveMapping(currentPr.number, raw);
        return raw === null ? null : gitOid(raw.headOid);
      }
      return options.readBranchHeadByName(headRefName);
    },



    readPullRequest: readPr,

    async setPullRequestDraft(prNumber, draft, expectedHead) {
      const beforeRaw = await readMappedRawPr(prNumber);
      const mapping = beforeRaw === null ? null : validateLiveMapping(prNumber, beforeRaw);
      const beforePr = pullRequestStateFromRaw(beforeRaw);
      if (expectedHead !== undefined && beforePr?.head !== expectedHead) {
        throw new Error('Pull-request draft reconciliation lost exact-head authority');
      }
      if (!draft && await liveHumanDominatesPullRequest(prNumber, beforeRaw)) {
        throw new Error('Human is dominant over pull-request draft reconciliation');
      }
      if (mapping?.kind === 'diagnostic' && !draft) {
        throw new Error('Diagnostic reconciliation may only make a PR draft');
      }
      await selected(({ run }) => mutateWithExactReadback(
        () => {
          invalidateActionAuthority();
          return run('gh', [
            'pr', 'ready', String(prNumber), '--repo', REPO,
            ...(draft ? ['--undo'] : []),
          ]);
        },
        async () => {
          const after = await readPr(prNumber);
          return after?.draft === draft
            && (expectedHead === undefined || after.head === expectedHead);
        },
        'Pull-request draft reconciliation was ambiguous',
      ));
    },

    async setPullRequestLabel(prNumber, label, present, expectedHead) {
      const beforeRaw = await readMappedRawPr(prNumber);
      const mapping = beforeRaw === null ? null : validateLiveMapping(prNumber, beforeRaw);
      const beforePr = pullRequestStateFromRaw(beforeRaw);
      if (expectedHead !== undefined && beforePr?.head !== expectedHead) {
        throw new Error('Pull-request label reconciliation lost exact-head authority');
      }
      if (
        await liveHumanDominatesPullRequest(prNumber, beforeRaw)
        && !(
          present
          && (
            label === NEEDS_HUMAN_LABEL
            || (mapping?.kind === 'diagnostic' && label === 'engine:review')
          )
        )
      ) {
        throw new Error('Human is dominant over pull-request label reconciliation');
      }
      await selected(({ run }) => mutateWithExactReadback(
        () => {
          invalidateActionAuthority();
          return run('gh', [
            'pr', 'edit', String(prNumber), '--repo', REPO,
            present ? '--add-label' : '--remove-label', label,
          ]);
        },
        async () => {
          const after = await readPr(prNumber);
          return after !== null
            && after.labels.includes(label) === present
            && (expectedHead === undefined || after.head === expectedHead);
        },
        'Pull-request label reconciliation was ambiguous',
      ));
    },

    async hasHumanComment(prNumber, marker) {
      return selected(async ({ run }) => {
        const bodies = await readIssueCommentBodies(run, prNumber);
        return bodies.some((body) => body.includes(marker));
      });
    },

    async ensureHumanComment(prNumber, marker, body, expectedHead) {
      if (!body.includes(marker)) {
        throw new Error('Human comment body is missing its exact marker');
      }
      const beforeRaw = await readMappedRawPr(prNumber);
      const before = pullRequestStateFromRaw(beforeRaw);
      if (expectedHead !== undefined && before?.head !== expectedHead) {
        throw new Error('Human comment reconciliation lost exact-head authority');
      }
      await selected(async ({ run }) => {
        const hasMarker = async () => (
          await readIssueCommentBodies(run, prNumber)
        ).some((body) => body.includes(marker));
        await mutateWithExactReadback(
          () => {
            invalidateActionAuthority();
            return run('gh', [
              'pr', 'comment', String(prNumber), '--repo', REPO, '--body', body,
            ]);
          },
          async () => {
            if (!await hasMarker()) return false;
            const after = await readPr(prNumber);
            return expectedHead === undefined || after?.head === expectedHead;
          },
          'Human comment reconciliation was ambiguous',
        );
      });
    },

    async ensureImplementationSummary(prNumber, expectedHead, summary) {
      const pr = await readMappedRawPr(prNumber);
      if (pr !== null && validateLiveMapping(prNumber, pr).kind === 'diagnostic') {
        throw new Error('Diagnostic reconciliation cannot write an implementation summary');
      }
      if (pr === null || pr.state !== 'OPEN' || gitOid(pr.headOid) !== expectedHead) {
        throw new Error('Implementation summary head changed');
      }
      const desired = completionBody(pr.body, summary);
      if (desired === pr.body) return;
      await selected(({ run }) => mutateWithExactReadback(
        () => {
          invalidateActionAuthority();
          return run('gh', [
            'pr', 'edit', String(prNumber), '--repo', REPO, '--body', desired,
          ]);
        },
        async () => {
          const after = await readMappedRawPr(prNumber);
          return after !== null
            && after.state === 'OPEN'
            && gitOid(after.headOid) === expectedHead
            && after.body === desired;
        },
        'Implementation summary reconciliation was ambiguous',
      ));
    },

    async readDraftPullRequestAuthority(input) {
      const marker =
        `<!-- jinn-autopilot:v2 issue=${input.issueNumber} branch=${input.headRefName} -->`;
      const expected = {
        headRefName: input.headRefName,
        head: input.expectedHead,
        baseRefName: input.baseRefName,
        body: `Closes #${input.issueNumber}\n\n${marker}`,
      };
      const relations = await readOpenPullRequestsByIssue(input.issueNumber);
      if (relations.length > 1) {
        throw new Error('Draft PR reconciliation found duplicate issue closing relations');
      }
      const relation = relations[0];
      if (relation === undefined) return { kind: 'missing' };
      if (!exactDraftIdentity(relation, expected)) {
        throw new Error('Draft PR reconciliation found a malformed issue closing relation');
      }
      return {
        kind: 'linked',
        number: relation.number,
        head: gitOid(relation.headOid),
        draft: relation.draft,
        labels: [...relation.labels],
      };
    },

    async ensureDraftPullRequest(input) {
      // The cycle supplies immutable stack/projection context. Every mutable
      // authority used to create the draft is re-read through a target seam.
      const current = options.cycleSnapshot;
      const issue = current.issues.find((candidate) =>
        candidate.number === input.issueNumber);
      if (issue === undefined) throw new Error('Issue is absent from the lifecycle snapshot');
      const nativeIssue = await options.readIssueByNumber(input.issueNumber);
      if (
        nativeIssue === null
        || nativeIssue.number !== input.issueNumber
        || !nativeIssue.open
      ) {
        throw new Error('Draft PR reconciliation native issue is missing or closed');
      }
      const projectItem = await readProjectItem(input.issueNumber);
      if (projectItem === null) {
        throw new Error('Draft PR reconciliation issue is missing from Project');
      }
      if (projectItem.status === 'Human' || projectItem.blockedOn === 'Human') {
        throw new Error('Human is dominant over draft PR reconciliation');
      }
      if (projectItem.status !== 'In Progress') {
        throw new Error('Draft PR reconciliation Project status is not In Progress');
      }
      const dependencies = await options.readBlockedByIssueNumbers(input.issueNumber);
      const expectedDependencies = [...issue.blockedByIssues].sort((left, right) => left - right);
      const liveDependencies = [...dependencies].sort((left, right) => left - right);
      if (
        expectedDependencies.length !== liveDependencies.length
        || expectedDependencies.some((number, index) => number !== liveDependencies[index])
      ) {
        throw new Error('Draft PR reconciliation native dependencies changed');
      }
      const cycleOpenBlockers = new Map<number, GitHubLifecycleSnapshot['pullRequests'][number]>();
      for (const dependency of expectedDependencies) {
        const linked = current.pullRequests.filter((pr) => (
          pr.closingIssueNumbers.includes(dependency)
        ));
        // Merged evidence is immutable and already satisfies this dependency.
        // Only the one still-open stacking base needs a live authority check.
        if (linked.some((pr) => pr.state === 'MERGED')) continue;
        const open = linked.filter((pr) => pr.state === 'OPEN');
        if (open.length === 0) {
          throw new Error('Draft PR reconciliation dependency is not satisfied in cycle context');
        }
        for (const blocker of open) cycleOpenBlockers.set(blocker.number, blocker);
      }
      if (cycleOpenBlockers.size > 1) {
        throw new Error('Draft PR reconciliation has more than one open blocker PR');
      }
      const cycleOpenBlocker = [...cycleOpenBlockers.values()][0];
      if (cycleOpenBlocker === undefined) {
        if (expectedDependencies.length > 0 && input.baseRefName !== 'next') {
          throw new Error('Draft PR reconciliation merged blockers require the next base');
        }
      } else {
        if (input.baseRefName !== cycleOpenBlocker.headRefName) {
          throw new Error('Draft PR reconciliation blocker base changed');
        }
        const liveBlocker = await readRawPr(cycleOpenBlocker.number);
        const liveClosing = liveBlocker === null
          ? new Set<number>()
          : new Set(liveBlocker.closingIssueNumbers);
        const blockerMarkers = liveBlocker === null ? [] : autopilotMarkers(liveBlocker.body);
        const blockerDependency = expectedDependencies.find((dependency) => (
          cycleOpenBlocker.closingIssueNumbers.includes(dependency)
        ));
        if (
          liveBlocker === null
          || liveBlocker.state !== 'OPEN'
          || gitOid(liveBlocker.headOid) !== cycleOpenBlocker.headOid
          || liveBlocker.headRefName !== cycleOpenBlocker.headRefName
          || blockerDependency === undefined
          || liveClosing.size !== liveBlocker.closingIssueNumbers.length
          || liveClosing.size !== 1
          || !liveClosing.has(blockerDependency)
          || (
            blockerMarkers.length > 0
            && (
              blockerMarkers.length !== 1
              || blockerMarkers[0]!.issueNumber !== blockerDependency
              || blockerMarkers[0]!.headRefName !== liveBlocker.headRefName
            )
          )
        ) {
          throw new Error('Draft PR reconciliation blocker PR authority changed');
        }
      }
      if (await liveIssueHead(input.issueNumber) !== input.expectedHead) {
        throw new Error('Draft PR reconciliation lost exact-head authority');
      }
      const marker =
        `<!-- jinn-autopilot:v2 issue=${input.issueNumber} branch=${input.headRefName} -->`;
      const expectedBody = `Closes #${input.issueNumber}\n\n${marker}`;
      const expectedRelation = {
        headRefName: input.headRefName,
        head: input.expectedHead,
        baseRefName: input.baseRefName,
        body: expectedBody,
      };
      const beforeRelations = await readOpenPullRequestsByIssue(input.issueNumber);
      if (beforeRelations.length > 1) {
        throw new Error('Draft PR reconciliation found duplicate issue closing relations');
      }
      if (beforeRelations.length === 1) {
        if (exactDraftRelation(beforeRelations[0]!, expectedRelation)) return;
        throw new Error('Draft PR reconciliation found a malformed issue closing relation');
      }
      await selected(({ run }) => mutateWithExactReadback(
        () => {
          invalidateActionAuthority();
          return run('gh', [
            'pr', 'create', '--repo', REPO,
            '--head', input.headRefName,
            '--base', input.baseRefName,
            '--title', nativeIssue.title,
            '--body', expectedBody,
            '--draft',
            '--label', 'engine:review',
          ]);
        },
        async () => {
          const after = await readOpenPullRequestsByIssue(input.issueNumber);
          return after.length === 1 && exactDraftRelation(after[0]!, expectedRelation);
        },
        'Draft pull-request reconciliation was ambiguous',
      ));
    },

    readReviewRef: readReview,

    markReviewStale: (prNumber, expectedReviewRefOid) =>
      updateReviewRef(prNumber, expectedReviewRefOid, 'stale'),

    completeVerdictIntent: (prNumber, expectedReviewRefOid, state) =>
      updateReviewRef(prNumber, expectedReviewRefOid, state),
  };
}
