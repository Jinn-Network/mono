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
import { ensureFieldIds } from '../dispatcher/field-cache.js';
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
import { CANONICAL_GITHUB_HTTPS_REMOTE } from './implementation-executor.js';
import { withSelectedCredential } from './production-auth.js';
import type {
  ReconciliationPullRequestState,
  ReconciliationReviewRefState,
  ReconciliationWriter,
} from './reconciler.js';
import type { GitHubLifecycleSnapshot } from './snapshot.js';
import {
  gitOid,
  type GitOid,
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
  readonly headOid: string;
  readonly isDraft: boolean;
  readonly labels: readonly string[];
  readonly body: string;
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
  /**
   * Full world snapshot, always fetched fresh. Backs only the optional
   * fallbacks below (`readPullRequestByNumber` / `readProjectItemForReconciliation`,
   * when a caller omits them). No writer method should call this directly —
   * see `readPullRequestByNumber` / `readProjectItemForReconciliation` /
   * `readDominanceSnapshot` below (jinn-mono#1883: a full snapshot per PR or
   * per project-status check burned the hourly GitHub GraphQL budget in a
   * single reconciliation cycle — one measured cycle made ~12 full
   * snapshots, ~4,700 points).
   */
  readonly readSnapshot: () => Promise<GitHubLifecycleSnapshot>;
  /**
   * Cheap, always-fresh single-PR read (~7-8 GraphQL points, versus ~390 for
   * a full `readSnapshot`) backing every exact-state PR pre-check and
   * post-mutation read-back in this writer. Returns `null` when the PR is
   * not open or merged. Optional for backward compatibility: omitting it
   * falls back to plucking the PR out of a full `readSnapshot()` call, i.e.
   * the pre-fix behavior — every production caller should wire this.
   */
  readonly readPullRequestByNumber?: (
    prNumber: number,
  ) => Promise<ReconciliationPullRequestNode | null>;
  /**
   * Cheap, always-fresh single-issue Project-item read (a targeted
   * `Issue.projectItems` lookup, not a full board paginate) backing
   * `readProjectStatus` and `setProjectStatus`'s exact-state pre-check and
   * post-mutation read-back. Optional for backward compatibility: omitting
   * it falls back to plucking the item out of a full `readSnapshot()` call,
   * i.e. the pre-fix behavior — every production caller should wire this.
   */
  readonly readProjectItemForReconciliation?: (
    issueNumber: number,
  ) => Promise<ReconciliationProjectItemNode | null>;
  /**
   * Full world snapshot backing every writer pre-check that needs
   * Project/lifecycle context no single-object read can supply: the
   * Human-dominance safety check (`humanDominatesPullRequest`, in
   * `setPullRequestDraft` / `setPullRequestLabel` / `updateReviewRef`),
   * `readIssueHead` / `readBranchHead`, the `issueHead` half of
   * `setProjectStatus`'s pre-check and read-back, and `ensureDraftPullRequest`'s
   * issue-existence + Project-item pre-check. The caller may (and in
   * production does) memoize this for the lifetime of one reconciliation
   * cycle: the projection plan being executed was itself derived from that
   * same snapshot, so reusing it here adds no staleness beyond what planning
   * already assumed, and bounds the worst case to one cycle. This must NOT
   * be reused for the specific field a write just changed — e.g.
   * `setProjectStatus`'s `status` read-back — those need a fresh
   * per-mutation read, which a memoized snapshot cannot provide (it would
   * make every such check trivially match the plan it was memoized from).
   * Optional: defaults to `readSnapshot` (an unmemoized full fetch per
   * call), i.e. the pre-fix behavior.
   */
  readonly readDominanceSnapshot?: () => Promise<GitHubLifecycleSnapshot>;
  readonly credential: SelectedCredential;
  readonly runner?: CommandRunner;
  readonly environment?: NodeJS.ProcessEnv;
  readonly now?: () => Date;
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

// Fallback for `readPullRequestByNumber` when a caller doesn't wire in the
// cheap reader-backed version (jinn-mono#1883) — reproduces the pre-fix
// behavior exactly by plucking the PR out of a full `readSnapshot()` call.
function nodeFromSnapshotPr(
  pr: GitHubLifecycleSnapshot['pullRequests'][number] | undefined,
): ReconciliationPullRequestNode | null {
  if (pr === undefined) return null;
  return {
    state: pr.state,
    headOid: pr.headOid,
    isDraft: pr.isDraft,
    labels: pr.labels,
    body: pr.body,
    reviewClaim: pr.reviewClaim === undefined
      ? null
      : { oid: pr.reviewClaim.oid, payload: encodeReviewClaimPayload(pr.reviewClaim.record) },
  };
}

// Fallback for `readProjectItemForReconciliation` when a caller doesn't wire
// in the cheap reader-backed version (jinn-mono#1883) — reproduces the
// pre-fix behavior exactly by plucking the item out of a full
// `readSnapshot()` call.
function nodeFromSnapshotProjectItem(
  item: GitHubLifecycleSnapshot['project']['items'][number] | undefined,
): ReconciliationProjectItemNode | null {
  if (item === undefined) return null;
  return { id: item.id, status: item.status, blockedOn: item.blockedOn };
}

function issueHead(
  snapshot: GitHubLifecycleSnapshot,
  issueNumber: number,
): GitOid | null {
  const lifecyclePr = snapshot.lifecycle.items.find((item) =>
    item.kind === 'pull-request' && item.issueNumber === issueNumber);
  if (lifecyclePr?.kind === 'pull-request') return lifecyclePr.head;
  return snapshot.branches.find((branch) =>
    branch.issueNumber === issueNumber)?.headOid ?? null;
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
  state: 'fixing' | 'terminal-approved' | 'stale',
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
  const runner = options.runner ?? defaultRunner;
  const ambient = options.environment ?? process.env;
  const now = options.now ?? (() => new Date());
  const snapshot = options.readSnapshot;
  const readRawPr = options.readPullRequestByNumber
    ?? (async (prNumber: number) => nodeFromSnapshotPr(
      (await snapshot()).pullRequests.find((pr) => pr.number === prNumber),
    ));
  const readProjectItem = options.readProjectItemForReconciliation
    ?? (async (issueNumber: number) => nodeFromSnapshotProjectItem(
      (await snapshot()).project.items.find((item) =>
        item.contentType === 'Issue' && item.number === issueNumber),
    ));
  const dominanceSnapshot = options.readDominanceSnapshot ?? snapshot;
  const selected = <Value>(
    operation: Parameters<typeof withSelectedCredential<Value>>[2],
  ): Promise<Value> => withSelectedCredential(
    options.credential,
    ambient,
    operation,
    runner,
  );
  const readPr = async (prNumber: number) =>
    pullRequestStateFromRaw(await readRawPr(prNumber));
  const readReview = async (prNumber: number) =>
    reviewRefStateFromRaw(await readRawPr(prNumber));
  const findOpenPullRequest = async (headRefName: string) => {
    // Cheap, headRefName-scoped lookup (not a `readPullRequestByNumber`
    // shape, since the PR's number isn't known yet) — a small `gh pr list`
    // filter, not the full world snapshot (jinn-mono#1883).
    const raw = await runner('gh', [
      'pr', 'list', '--repo', REPO,
      '--head', headRefName,
      '--state', 'open',
      '--json', 'number,headRefOid,isDraft,labels',
    ]);
    const parsed = JSON.parse(raw) as ReadonlyArray<{
      readonly number: number;
      readonly headRefOid: string;
      readonly isDraft: boolean;
      readonly labels: ReadonlyArray<{ readonly name: string }>;
    }>;
    const pr = parsed[0];
    return pr === undefined ? null : {
      number: pr.number,
      head: gitOid(pr.headRefOid),
      draft: pr.isDraft,
      labels: pr.labels.map((label) => label.name),
    };
  };

  const updateReviewRef = async (
    prNumber: number,
    expectedReviewRefOid: GitOid,
    desired: 'fixing' | 'terminal-approved' | 'stale',
  ): Promise<void> => {
    const beforeRaw = await readRawPr(prNumber);
    const beforeClaim = beforeRaw?.reviewClaim;
    if (
      beforeClaim === undefined
      || beforeClaim === null
      || gitOid(beforeClaim.oid) !== expectedReviewRefOid
    ) {
      throw new Error('Review-ref authority changed before reconciliation');
    }
    const beforeRecord = decodeReviewClaimPayload(beforeClaim.payload);
    // Dominance needs Project/lifecycle context a single-PR read can't
    // supply, so it comes from the (per-cycle-memoized) dominance snapshot
    // rather than another full fetch here — see `readDominanceSnapshot`.
    if (humanDominatesPullRequest(await dominanceSnapshot(), prNumber)) {
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
    async readIssueHead(issueNumber) {
      // Pre-check-only read (never a post-mutation confirmation — see
      // `readDominanceSnapshot`'s doc comment) so the per-cycle-memoized
      // snapshot is safe here.
      return issueHead(await dominanceSnapshot(), issueNumber);
    },

    async readBranchHead(headRefName) {
      const current = await dominanceSnapshot();
      return current.branches.find((branch) =>
        branch.headRefName === headRefName)?.headOid
        ?? current.pullRequests.find((pr) =>
          pr.state === 'OPEN' && pr.headRefName === headRefName)?.headOid
        ?? null;
    },

    async readProjectStatus(issueNumber) {
      return (await readProjectItem(issueNumber))?.status ?? null;
    },

    async setProjectStatus(issueNumber, status: ProjectStatus, expectedHead) {
      const item = await readProjectItem(issueNumber);
      if (item === null) throw new Error('Issue is missing from Project');
      if (
        status !== 'Human'
        && (item.status === 'Human' || item.blockedOn === 'Human')
      ) {
        throw new Error('Human is dominant over Project reconciliation');
      }
      if (
        expectedHead !== undefined
        && issueHead(await dominanceSnapshot(), issueNumber) !== expectedHead
      ) {
        throw new Error('Project reconciliation lost exact-head authority');
      }
      if (item.status === status) return;
      await selected(async ({ run }) => {
        const secureRunner: CommandRunner = (command, args) => run(command, args);
        const fields = await ensureFieldIds(secureRunner);
        await mutateWithExactReadback(
          () => run('gh', [
            'project', 'item-edit',
            '--id', item.id,
            '--project-id', fields.projectId,
            '--field-id', fields.status.fieldId,
            '--single-select-option-id', fields.status.options[status],
          ]),
          async () => {
            const afterItem = await readProjectItem(issueNumber);
            return afterItem?.status === status
              && (
                status === 'Human'
                || afterItem.blockedOn !== 'Human'
              )
              && (
                expectedHead === undefined
                || issueHead(await dominanceSnapshot(), issueNumber) === expectedHead
              );
          },
          'Project status reconciliation was ambiguous',
        );
      });
    },

    readPullRequest: readPr,

    async setPullRequestDraft(prNumber, draft, expectedHead) {
      const beforePr = await readPr(prNumber);
      if (expectedHead !== undefined && beforePr?.head !== expectedHead) {
        throw new Error('Pull-request draft reconciliation lost exact-head authority');
      }
      if (!draft && humanDominatesPullRequest(await dominanceSnapshot(), prNumber)) {
        throw new Error('Human is dominant over pull-request draft reconciliation');
      }
      await selected(({ run }) => mutateWithExactReadback(
        () => run('gh', [
          'pr', 'ready', String(prNumber), '--repo', REPO,
          ...(draft ? ['--undo'] : []),
        ]),
        async () => {
          const after = await readPr(prNumber);
          return after?.draft === draft
            && (expectedHead === undefined || after.head === expectedHead);
        },
        'Pull-request draft reconciliation was ambiguous',
      ));
    },

    async setPullRequestLabel(prNumber, label, present, expectedHead) {
      const beforePr = await readPr(prNumber);
      if (expectedHead !== undefined && beforePr?.head !== expectedHead) {
        throw new Error('Pull-request label reconciliation lost exact-head authority');
      }
      if (
        humanDominatesPullRequest(await dominanceSnapshot(), prNumber)
        && !(label === NEEDS_HUMAN_LABEL && present)
      ) {
        throw new Error('Human is dominant over pull-request label reconciliation');
      }
      await selected(({ run }) => mutateWithExactReadback(
        () => run('gh', [
          'pr', 'edit', String(prNumber), '--repo', REPO,
          present ? '--add-label' : '--remove-label', label,
        ]),
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
        const bodies = await run('gh', [
          'api', `repos/${REPO}/issues/${prNumber}/comments`,
          '--paginate', '--jq', '.[].body',
        ]);
        return bodies.includes(marker);
      });
    },

    async ensureHumanComment(prNumber, marker, body, expectedHead) {
      if (!body.includes(marker)) {
        throw new Error('Human comment body is missing its exact marker');
      }
      const before = await readPr(prNumber);
      if (expectedHead !== undefined && before?.head !== expectedHead) {
        throw new Error('Human comment reconciliation lost exact-head authority');
      }
      await selected(async ({ run }) => {
        const hasMarker = async () => (
          await run('gh', [
            'api', `repos/${REPO}/issues/${prNumber}/comments`,
            '--paginate', '--jq', '.[].body',
          ])
        ).includes(marker);
        await mutateWithExactReadback(
          () => run('gh', [
            'pr', 'comment', String(prNumber), '--repo', REPO, '--body', body,
          ]),
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
      const pr = await readRawPr(prNumber);
      if (pr === null || pr.state !== 'OPEN' || gitOid(pr.headOid) !== expectedHead) {
        throw new Error('Implementation summary head changed');
      }
      const desired = completionBody(pr.body, summary);
      if (desired === pr.body) return;
      await selected(({ run }) => mutateWithExactReadback(
        () => run('gh', [
          'pr', 'edit', String(prNumber), '--repo', REPO, '--body', desired,
        ]),
        async () => {
          const after = await readRawPr(prNumber);
          return after !== null
            && after.state === 'OPEN'
            && gitOid(after.headOid) === expectedHead
            && after.body === desired;
        },
        'Implementation summary reconciliation was ambiguous',
      ));
    },

    findOpenPullRequest,

    async ensureDraftPullRequest(input) {
      // Pure pre-check (the read-back below uses `findOpenPullRequest`,
      // already cheap) needing issue existence/title + Project context no
      // single-object read can supply — the memoized dominance snapshot is
      // safe here for the same reason it's safe for the Human-dominance
      // check (see `readDominanceSnapshot`'s doc comment).
      const current = await dominanceSnapshot();
      const issue = current.issues.find((candidate) =>
        candidate.number === input.issueNumber);
      if (issue === undefined) throw new Error('Issue is absent from the lifecycle snapshot');
      const projectItem = current.project.items.find((candidate) =>
        candidate.contentType === 'Issue'
        && candidate.number === input.issueNumber);
      if (
        projectItem?.status === 'Human'
        || projectItem?.blockedOn === 'Human'
      ) {
        throw new Error('Human is dominant over draft PR reconciliation');
      }
      if (issueHead(current, input.issueNumber) !== input.expectedHead) {
        throw new Error('Draft PR reconciliation lost exact-head authority');
      }
      const marker =
        `<!-- jinn-autopilot:v2 issue=${input.issueNumber} branch=${input.headRefName} -->`;
      await selected(({ run }) => mutateWithExactReadback(
        () => run('gh', [
          'pr', 'create', '--repo', REPO,
          '--head', input.headRefName,
          '--base', input.baseRefName,
          '--title', issue.title,
          '--body', `Closes #${input.issueNumber}\n\n${marker}`,
          '--draft',
          '--label', 'engine:review',
        ]),
        async () => {
          const after = await findOpenPullRequest(input.headRefName);
          return after?.head === input.expectedHead
            && after.draft
            && after.labels.includes('engine:review');
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
