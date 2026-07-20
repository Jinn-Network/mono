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
import { fetchFieldIds } from '../dispatcher/field-cache.js';
import { NEEDS_HUMAN_LABEL } from '../dispatcher/merge-sweep.js';
import type { ProjectStatus } from '../dispatcher/types.js';
import {
  IMPLEMENTATION_SUMMARY_END,
  IMPLEMENTATION_SUMMARY_START,
} from './implementation-session.js';
import {
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

export interface ProductionReconciliationWriterOptions {
  readonly repositoryPath: string;
  readonly readSnapshot: () => Promise<GitHubLifecycleSnapshot>;
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

function pullRequestState(
  snapshot: GitHubLifecycleSnapshot,
  prNumber: number,
): ReconciliationPullRequestState | null {
  const pr = snapshot.pullRequests.find((candidate) =>
    candidate.number === prNumber && candidate.state === 'OPEN');
  return pr === undefined ? null : {
    head: pr.headOid,
    draft: pr.isDraft,
    labels: [...pr.labels],
  };
}

function reviewRefState(
  snapshot: GitHubLifecycleSnapshot,
  prNumber: number,
): ReconciliationReviewRefState | null {
  const pr = snapshot.pullRequests.find((candidate) => candidate.number === prNumber);
  const claim = pr?.reviewClaim;
  return claim === undefined ? null : {
    oid: claim.oid,
    head: claim.record.head,
    state: claim.record.state,
  };
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
  const selected = <Value>(
    operation: Parameters<typeof withSelectedCredential<Value>>[2],
  ): Promise<Value> => withSelectedCredential(
    options.credential,
    ambient,
    operation,
    runner,
  );
  const readPr = async (prNumber: number) =>
    pullRequestState(await snapshot(), prNumber);
  const readReview = async (prNumber: number) =>
    reviewRefState(await snapshot(), prNumber);
  const findOpenPullRequest = async (headRefName: string) => {
    const pr = (await snapshot()).pullRequests.find((candidate) =>
      candidate.state === 'OPEN' && candidate.headRefName === headRefName);
    return pr === undefined ? null : {
      number: pr.number,
      head: pr.headOid,
      draft: pr.isDraft,
      labels: [...pr.labels],
    };
  };

  const updateReviewRef = async (
    prNumber: number,
    expectedReviewRefOid: GitOid,
    desired: 'fixing' | 'terminal-approved' | 'stale',
  ): Promise<void> => {
    const beforeSnapshot = await snapshot();
    const beforePr = beforeSnapshot.pullRequests.find((candidate) =>
      candidate.number === prNumber);
    const before = beforePr?.reviewClaim;
    if (before === undefined || before.oid !== expectedReviewRefOid) {
      throw new Error('Review-ref authority changed before reconciliation');
    }
    if (humanDominatesPullRequest(beforeSnapshot, prNumber)) {
      throw new Error('Human is dominant over review-ref reconciliation');
    }
    if (
      desired !== 'stale'
      && beforePr?.headOid !== before.record.head
    ) {
      throw new Error('Review-ref reconciliation lost exact-head authority');
    }
    const record = nextReviewRecord(
      before.record,
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
      const current = await snapshot();
      return issueHead(current, issueNumber);
    },

    async readBranchHead(headRefName) {
      const current = await snapshot();
      return current.branches.find((branch) =>
        branch.headRefName === headRefName)?.headOid
        ?? current.pullRequests.find((pr) =>
          pr.state === 'OPEN' && pr.headRefName === headRefName)?.headOid
        ?? null;
    },

    async readProjectStatus(issueNumber) {
      const current = await snapshot();
      return current.project.items.find((item) =>
        item.contentType === 'Issue' && item.number === issueNumber)?.status ?? null;
    },

    async setProjectStatus(issueNumber, status: ProjectStatus, expectedHead) {
      const current = await snapshot();
      const item = current.project.items.find((candidate) =>
        candidate.contentType === 'Issue' && candidate.number === issueNumber);
      if (item === undefined) throw new Error('Issue is missing from Project');
      if (
        status !== 'Human'
        && (item.status === 'Human' || item.blockedOn === 'Human')
      ) {
        throw new Error('Human is dominant over Project reconciliation');
      }
      if (
        expectedHead !== undefined
        && issueHead(current, issueNumber) !== expectedHead
      ) {
        throw new Error('Project reconciliation lost exact-head authority');
      }
      if (item.status === status) return;
      await selected(async ({ run }) => {
        const secureRunner: CommandRunner = (command, args) => run(command, args);
        const fields = await fetchFieldIds(secureRunner);
        await mutateWithExactReadback(
          () => run('gh', [
            'project', 'item-edit',
            '--id', item.id,
            '--project-id', fields.projectId,
            '--field-id', fields.status.fieldId,
            '--single-select-option-id', fields.status.options[status],
          ]),
          async () => {
            const after = await snapshot();
            const afterItem = after.project.items.find((candidate) =>
              candidate.contentType === 'Issue'
              && candidate.number === issueNumber);
            return afterItem?.status === status
              && (
                status === 'Human'
                || afterItem.blockedOn !== 'Human'
              )
              && (
                expectedHead === undefined
                || issueHead(after, issueNumber) === expectedHead
              );
          },
          'Project status reconciliation was ambiguous',
        );
      });
    },

    readPullRequest: readPr,

    async setPullRequestDraft(prNumber, draft, expectedHead) {
      const before = await snapshot();
      const beforePr = pullRequestState(before, prNumber);
      if (expectedHead !== undefined && beforePr?.head !== expectedHead) {
        throw new Error('Pull-request draft reconciliation lost exact-head authority');
      }
      if (!draft && humanDominatesPullRequest(before, prNumber)) {
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
      const before = await snapshot();
      const beforePr = pullRequestState(before, prNumber);
      if (expectedHead !== undefined && beforePr?.head !== expectedHead) {
        throw new Error('Pull-request label reconciliation lost exact-head authority');
      }
      if (
        humanDominatesPullRequest(before, prNumber)
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
      const current = await snapshot();
      const pr = current.pullRequests.find((candidate) =>
        candidate.number === prNumber && candidate.state === 'OPEN');
      if (pr === undefined || pr.headOid !== expectedHead) {
        throw new Error('Implementation summary head changed');
      }
      const desired = completionBody(pr.body, summary);
      if (desired === pr.body) return;
      await selected(({ run }) => mutateWithExactReadback(
        () => run('gh', [
          'pr', 'edit', String(prNumber), '--repo', REPO, '--body', desired,
        ]),
        async () => {
          const after = (await snapshot()).pullRequests.find((candidate) =>
            candidate.number === prNumber && candidate.state === 'OPEN');
          return after?.headOid === expectedHead && after.body === desired;
        },
        'Implementation summary reconciliation was ambiguous',
      ));
    },

    findOpenPullRequest,

    async ensureDraftPullRequest(input) {
      const current = await snapshot();
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
