import {
  chmodSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CommandRunner } from '../dispatcher/issue-source.js';
import { defaultRunner } from '../dispatcher/issue-source.js';
import {
  parseOwnedPrefixes,
  touchesCodeOwnedPath,
} from '../dispatcher/code-owned.js';
import { REPO } from '../dispatcher/constants.js';
import { fetchFieldIds } from '../dispatcher/field-cache.js';
import { fetchProjectSnapshot } from '../dispatcher/project-snapshot.js';
import type {
  CreateAttemptOptions,
} from './attempt-workspace.js';
import { createAttemptWorkspace } from './attempt-workspace.js';
import { encodeReviewClaimPayload } from './codecs.js';
import {
  gitPublicationArgs,
  isolatedGitCommandOverlay,
  sanitizedGitHubCommandOverlay,
} from './credentials.js';
import { makeGitProtocolPort } from './git-protocol.js';
import { readExactChangedFiles } from './github-changed-files.js';
import { CANONICAL_GITHUB_HTTPS_REMOTE } from './implementation-executor.js';
import type {
  ReviewActionCandidate,
  ReviewAttemptBinding,
  ReviewExecutorDeps,
} from './review-executor.js';
import type { GitHubLifecycleSnapshot } from './snapshot.js';
import {
  gitOid,
  gitRefName,
  type GitOid,
} from './types.js';

export interface ProductionReviewActionPortOptions {
  readonly repositoryPath: string;
  readonly worktreeBase: string;
  readonly runnerId: string;
  readonly remoteName?: string;
  readonly readSnapshot: () => Promise<GitHubLifecycleSnapshot>;
  readonly changedFiles?: (prNumber: number) => Promise<readonly string[]>;
  readonly codeownersText?: (input: {
    readonly prNumber: number;
    readonly expectedHead: GitOid;
    readonly baseRefName: string;
    readonly baseOid: GitOid;
  }) => string | Promise<string>;
  readonly runner?: CommandRunner;
  readonly environment?: NodeJS.ProcessEnv;
  readonly createWorkspace?: (
    options: CreateAttemptOptions,
    runner: CommandRunner,
  ) => Promise<ReviewAttemptBinding>;
}

export type ProductionReviewActionPort = Pick<
ReviewExecutorDeps,
| 'readCandidate'
| 'confirmAcquisition'
| 'createReviewRecord'
| 'publishReviewClaim'
| 'createAttempt'
| 'repairProjection'
>;

export function makeProductionReviewActionPort(
  options: ProductionReviewActionPortOptions,
): ProductionReviewActionPort {
  const runner = options.runner ?? defaultRunner;
  const ambient = options.environment ?? process.env;
  const runRepositoryGit = (
    args: string[],
    env: Record<string, string> = {},
  ) => runner('git', ['-C', options.repositoryPath, ...args], { env });
  const secureEnvironment = (
    credential: Parameters<ReviewExecutorDeps['createReviewRecord']>[0]['credential'],
    askpassPath: string,
  ): Record<string, string> => ({
    ...sanitizedGitHubCommandOverlay(ambient, { GH_TOKEN: credential.secret() }),
    ...isolatedGitCommandOverlay(ambient, askpassPath),
  });
  const withCredential = async <T>(
    credential: Parameters<ReviewExecutorDeps['createReviewRecord']>[0]['credential'],
    operation: (askpass: string, environment: Record<string, string>) => Promise<T>,
  ): Promise<T> => {
    const directory = mkdtempSync(join(tmpdir(), 'jinn-review-auth-'));
    const askpass = join(directory, 'askpass');
    writeFileSync(askpass, [
      '#!/bin/sh',
      'case "$1" in',
      "  *Username*) printf '%s\\n' 'x-access-token' ;;",
      "  *Password*) printf '%s\\n' \"$GH_TOKEN\" ;;",
      '  *) exit 1 ;;',
      'esac',
      '',
    ].join('\n'), { mode: 0o700 });
    chmodSync(askpass, 0o700);
    try {
      return await operation(askpass, secureEnvironment(credential, askpass));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  };
  const mutateWithExactReadback = async (
    mutate: () => Promise<unknown>,
    confirmed: () => Promise<boolean>,
    ambiguityMessage: string,
  ): Promise<void> => {
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
  };
  const readCodeownersText = async (input: {
    readonly prNumber: number;
    readonly expectedHead: GitOid;
    readonly baseRefName: string;
    readonly baseOid: GitOid;
  }): Promise<string> => {
    if (options.codeownersText !== undefined) {
      return options.codeownersText(input);
    }
    const contents = JSON.parse(await runner('gh', [
      'api', `repos/${REPO}/contents/.github/CODEOWNERS`,
      '--method', 'GET',
      '-f', `ref=${input.baseOid}`,
    ])) as {
      encoding?: unknown;
      content?: unknown;
    };
    if (contents.encoding !== 'base64' || typeof contents.content !== 'string') {
      throw new Error('Review CODEOWNERS response was incomplete');
    }
    return Buffer.from(contents.content.replaceAll('\n', ''), 'base64')
      .toString('utf8');
  };
  const candidateFromSnapshot = async (
    snapshot: GitHubLifecycleSnapshot,
    prNumber: number,
  ): Promise<ReviewActionCandidate | null> => {
    const pr = snapshot.pullRequests.find((candidate) => candidate.number === prNumber);
    if (pr === undefined) return null;
    const lifecycle = snapshot.lifecycle.items.find((item) =>
      item.kind === 'pull-request' && item.prNumber === prNumber);
    const diagnostic = snapshot.diagnostics.find((entry) =>
      entry.pullRequests.some((candidate) => candidate.number === prNumber));
    const marker = /<!-- jinn-autopilot:v2 issue=([1-9][0-9]*) branch=([^ >]+) -->/
      .exec(pr.body);
    const issueNumber = lifecycle?.issueNumber
      ?? diagnostic?.issueNumbers[0]
      ?? (marker === null ? undefined : Number(marker[1]));
    if (issueNumber === undefined) return null;
    const changedFiles = await readExactChangedFiles({
      run: runner,
      prNumber,
      expectedHead: pr.headOid,
      expectedBaseRefName: pr.baseRefName,
      context: 'Review',
      ...(options.changedFiles === undefined
        ? {}
        : { readFiles: options.changedFiles }),
    });
    const humanSurface = !changedFiles.complete || touchesCodeOwnedPath(
      [...changedFiles.files],
      parseOwnedPrefixes(await readCodeownersText({
        prNumber,
        expectedHead: pr.headOid,
        baseRefName: pr.baseRefName,
        baseOid: changedFiles.baseOid,
      })),
    );
    const reviewClaim = pr.reviewClaim;
    const terminalApprovalMatches = lifecycle?.kind === 'pull-request'
      && lifecycle.reviewClaim?.state === 'terminal-approved'
      && lifecycle.reviewClaim.head === pr.headOid
      && lifecycle.terminalVerdict?.head === pr.headOid
      && lifecycle.terminalVerdict.state === 'APPROVE'
      && lifecycle.terminalVerdict.marker === lifecycle.reviewClaim.verdict.marker;
    return {
      issueNumber,
      number: pr.number,
      open: pr.state === 'OPEN',
      head: pr.headOid,
      headChangedAt: pr.headCommittedAt,
      headRefName: gitRefName(pr.headRefName),
      baseRefName: gitRefName(pr.baseRefName),
      draft: pr.isDraft,
      author: pr.author,
      labels: [...pr.labels],
      body: pr.body,
      humanHold: lifecycle?.humanHold === true
        || lifecycle?.projectStatus === 'Human'
        || pr.labels.includes('review:needs-human'),
      approvalPolicy: humanSurface ? 'human-codeowner' : 'approve-eligible',
      nativeReviews: pr.reviews.map((review) => ({
        reviewer: review.reviewer,
        state: review.state,
        commitId: review.commitId,
        body: review.body,
        submittedAt: review.submittedAt,
      })),
      ...(reviewClaim === undefined
        ? {}
        : { reviewRef: { oid: reviewClaim.oid, record: reviewClaim.record } }),
      ...(terminalApprovalMatches ? { terminalApprovalMatches: true } : {}),
      ...(diagnostic === undefined ? {} : { mappingProblem: diagnostic.detail }),
    };
  };
  const createMetadataCommit = async (
    payload: string,
    parent: GitOid | null,
    environment: Record<string, string>,
  ): Promise<GitOid> => {
    const directory = mkdtempSync(join(tmpdir(), 'jinn-review-record-'));
    const payloadPath = join(directory, 'jinn-autopilot-review.json');
    const indexPath = join(directory, 'index');
    writeFileSync(payloadPath, `${payload}\n`, { mode: 0o600 });
    const env = { ...environment, GIT_INDEX_FILE: indexPath };
    try {
      await runRepositoryGit(['read-tree', '--empty'], env);
      const blob = gitOid((await runRepositoryGit([
        'hash-object', '-w', payloadPath,
      ], env)).trim());
      await runRepositoryGit([
        'update-index', '--add',
        '--cacheinfo', `100644,${blob},jinn-autopilot-review.json`,
      ], env);
      const tree = gitOid((await runRepositoryGit(['write-tree'], env)).trim());
      return gitOid((await runRepositoryGit([
        'commit-tree', tree,
        ...(parent === null ? [] : ['-p', parent]),
        '-m', 'Autopilot review claim metadata',
      ], env)).trim());
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  };

  return {
    readCandidate: async (prNumber) =>
      candidateFromSnapshot(await options.readSnapshot(), prNumber),

    confirmAcquisition: async ({ prNumber }) =>
      candidateFromSnapshot(await options.readSnapshot(), prNumber),

    createReviewRecord: ({ record, parent, credential }) =>
      withCredential(credential, (_askpass, environment) =>
        createMetadataCommit(encodeReviewClaimPayload(record), parent, environment)),

    publishReviewClaim: ({
      prNumber,
      recordParent,
      expectedRemoteRecordOid,
      recordOid,
      credential,
    }) => withCredential(credential, (askpass, environment) => {
      const secureRunner = (
        _command: 'git',
        args: readonly string[],
      ) => runner('git', [
        ...gitPublicationArgs(askpass, []),
        '-C', options.repositoryPath,
        ...args,
      ], { env: environment });
      return makeGitProtocolPort(secureRunner, {
        remote: CANONICAL_GITHUB_HTTPS_REMOTE,
      }).publishReviewClaim({
        prNumber,
        recordParent,
        expectedRemoteRecordOid,
        recordOid,
      });
    }),

    async createAttempt(input) {
      const create = options.createWorkspace ?? createAttemptWorkspace;
      return create({
        repositoryPath: options.repositoryPath,
        worktreeBase: options.worktreeBase,
        runnerId: options.runnerId,
        phase: 'review',
        subject: `pr-${input.prNumber}`,
        issueNumber: input.issueNumber,
        prNumber: input.prNumber,
        branch: input.branch,
        targetBase: input.targetBase,
        expectedHead: input.expectedHead,
        claimOid: input.claimOid,
        reviewGeneration: input.reviewGeneration,
        reviewRefOid: input.reviewRefOid,
        reviewApprovalPolicy: input.approvalPolicy,
        selectedLogin: input.selectedLogin,
        attemptId: input.attemptId,
        remoteName: options.remoteName ?? 'jinn-autopilot-v2',
      }, runner);
    },

    async repairProjection({ candidate, expectedReviewRefOid, credential }) {
      await withCredential(credential, async (askpass, environment) => {
        const git = (args: string[]) => runner('git', [
          ...gitPublicationArgs(askpass, []),
          '-C', options.repositoryPath,
          ...args,
        ], { env: environment });
        const ref = `refs/jinn-autopilot/review-claims/v1/${candidate.number}`;
        const raw = await git(['ls-remote', CANONICAL_GITHUB_HTTPS_REMOTE, ref]);
        if (!raw.includes(`${expectedReviewRefOid}\t${ref}`)) {
          throw new Error('Review projection lost exact review-ref authority');
        }
        const gh: CommandRunner = (cmd, args) => runner(cmd, args, { env: environment });
        const readPr = async () => JSON.parse(await gh('gh', [
          'pr', 'view', String(candidate.number), '--repo', REPO,
          '--json', 'headRefOid,labels,isDraft',
        ])) as {
          headRefOid?: string;
          labels?: Array<{ name?: string }>;
          isDraft?: boolean;
        };
        const exactPr = (pr: Awaited<ReturnType<typeof readPr>>) => (
          pr.headRefOid === candidate.head
          && pr.isDraft === candidate.draft
          && Array.isArray(pr.labels)
        );
        const pr = await readPr();
        if (
          !exactPr(pr)
        ) {
          throw new Error('Review projection PR authority changed');
        }
        const labels = pr.labels!.map((label) => label.name);
        if (labels.includes('review:needs-human')) {
          throw new Error('Review projection stopped because Human is dominant');
        }
        if (!labels.includes('engine:review')) {
          await mutateWithExactReadback(
            () => gh('gh', [
              'pr', 'edit', String(candidate.number), '--repo', REPO,
              '--add-label', 'engine:review',
            ]),
            async () => {
              const repaired = await readPr();
              return exactPr(repaired)
                && repaired.labels!.some((label) => label.name === 'engine:review')
                && !repaired.labels!.some((label) => label.name === 'review:needs-human');
            },
            'Review label projection was ambiguous',
          );
        }
        const project = await fetchProjectSnapshot(gh);
        const item = project.items.find((entry) =>
          entry.contentType === 'Issue' && entry.number === candidate.issueNumber);
        if (item === undefined) throw new Error('Review issue is missing from Project');
        if (item.status === 'Human' || item.blockedOn === 'Human') {
          throw new Error('Review projection stopped because Human is dominant');
        }
        if (item.status !== 'In Review') {
          const fields = await fetchFieldIds(gh);
          await mutateWithExactReadback(
            () => gh('gh', [
              'project', 'item-edit',
              '--id', item.id,
              '--project-id', fields.projectId,
              '--field-id', fields.status.fieldId,
              '--single-select-option-id', fields.status.options['In Review'],
            ]),
            async () => {
              const repaired = await fetchProjectSnapshot(gh);
              const repairedItem = repaired.items.find((entry) =>
                entry.contentType === 'Issue' && entry.number === candidate.issueNumber);
              return repairedItem?.status === 'In Review'
                && repairedItem.blockedOn !== 'Human';
            },
            'Review Project projection was ambiguous',
          );
        }
        const finalRef = await git(['ls-remote', CANONICAL_GITHUB_HTTPS_REMOTE, ref]);
        if (!finalRef.includes(`${expectedReviewRefOid}\t${ref}`)) {
          throw new Error('Review projection lost exact review-ref authority');
        }
        const finalPr = await readPr();
        if (
          !exactPr(finalPr)
          || !finalPr.labels!.some((label) => label.name === 'engine:review')
          || finalPr.labels!.some((label) => label.name === 'review:needs-human')
        ) {
          throw new Error('Review projection final PR authority changed');
        }
        const finalProject = await fetchProjectSnapshot(gh);
        const finalItem = finalProject.items.find((entry) =>
          entry.contentType === 'Issue' && entry.number === candidate.issueNumber);
        if (
          finalItem?.status !== 'In Review'
          || finalItem.blockedOn === 'Human'
        ) {
          throw new Error('Review projection stopped because Human is dominant');
        }
      });
    },
  };
}

export type { ReviewActionCandidate };
