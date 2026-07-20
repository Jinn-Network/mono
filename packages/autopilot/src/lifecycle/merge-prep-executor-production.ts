import { randomUUID } from 'node:crypto';
import type { CommandRunner } from '../dispatcher/issue-source.js';
import { defaultRunner } from '../dispatcher/issue-source.js';
import { parseOwnedPrefixes, touchesCodeOwnedPath } from '../dispatcher/code-owned.js';
import { REPO } from '../dispatcher/constants.js';
import { fetchFieldIds } from '../dispatcher/field-cache.js';
import { fetchProjectSnapshot } from '../dispatcher/project-snapshot.js';
import type { CreateAttemptOptions } from './attempt-workspace.js';
import { createAttemptWorkspace } from './attempt-workspace.js';
import { encodeBranchClaimTrailers } from './codecs.js';
import {
  gitPublicationArgs,
  type SelectedCredential,
} from './credentials.js';
import { makeGitProtocolPort } from './git-protocol.js';
import { CANONICAL_GITHUB_HTTPS_REMOTE } from './implementation-executor.js';
import type {
  MergePrepCandidate,
  MergePrepExecutorDeps,
} from './merge-prep-executor.js';
import { withSelectedCredential } from './production-auth.js';
import type { GitHubLifecycleSnapshot } from './snapshot.js';
import { gitOid, gitRefName } from './types.js';

export interface ProductionMergePrepActionPortOptions {
  readonly repositoryPath: string;
  readonly worktreeBase: string;
  readonly runnerId: string;
  readonly remoteName?: string;
  readonly readSnapshot: () => Promise<GitHubLifecycleSnapshot>;
  readonly runner?: CommandRunner;
  readonly environment?: NodeJS.ProcessEnv;
  readonly createWorkspace?: (
    options: CreateAttemptOptions,
    runner: CommandRunner,
  ) => Promise<Awaited<ReturnType<typeof createAttemptWorkspace>>>;
}

export type ProductionMergePrepActionPort = Pick<
MergePrepExecutorDeps,
| 'readCandidate'
| 'confirmAuthority'
| 'createClaimCommit'
| 'claimBranch'
| 'repairProjection'
| 'createAttempt'
>;

function decodeBase64(value: string): string {
  return Buffer.from(value.replace(/\n/g, ''), 'base64').toString('utf8');
}

export function makeProductionMergePrepActionPort(
  options: ProductionMergePrepActionPortOptions,
): ProductionMergePrepActionPort {
  const runner = options.runner ?? defaultRunner;
  const ambient = options.environment ?? process.env;
  const withCredential = <Value>(
    credential: SelectedCredential,
    operation: Parameters<typeof withSelectedCredential<Value>>[2],
  ) => withSelectedCredential(credential, ambient, operation, runner);
  const candidate = async (
    snapshot: GitHubLifecycleSnapshot,
    prNumber: number,
    credential?: SelectedCredential,
  ): Promise<MergePrepCandidate | null> => {
    const pr = snapshot.pullRequests.find((entry) => entry.number === prNumber);
    if (pr === undefined) return null;
    const lifecycle = snapshot.lifecycle.items.find((entry) =>
      entry.kind === 'pull-request' && entry.prNumber === prNumber);
    const diagnostic = snapshot.diagnostics.find((entry) =>
      entry.pullRequests.some((candidatePr) => candidatePr.number === prNumber));
    if (lifecycle?.kind !== 'pull-request' || diagnostic !== undefined) return null;
    const readPolicy = async (run: CommandRunner) => {
      const base = JSON.parse(await run('gh', [
        'api', `repos/${REPO}/git/ref/heads/${encodeURIComponent(pr.baseRefName)}`,
      ])) as { object?: { sha?: string } };
      const baseOid = gitOid(base.object?.sha ?? '');
      const rawFiles = JSON.parse(await run('gh', [
        'api', `repos/${REPO}/pulls/${pr.number}/files?per_page=100`,
        '--paginate', '--slurp',
      ])) as unknown;
      if (!Array.isArray(rawFiles)) throw new Error('Merge-prep changed files were incomplete');
      const pages = rawFiles as Array<Array<{ filename?: unknown }>>;
      const files = pages.flat().map((file) => {
        if (typeof file.filename !== 'string') throw new Error('Malformed changed file');
        return file.filename;
      });
      const content = JSON.parse(await run('gh', [
        'api',
        `repos/${REPO}/contents/.github/CODEOWNERS?ref=${baseOid}`,
      ])) as { content?: unknown };
      if (typeof content.content !== 'string') {
        throw new Error('Target-base CODEOWNERS read was incomplete');
      }
      return {
        baseOid,
        codeownerSensitive: touchesCodeOwnedPath(
          files,
          parseOwnedPrefixes(decodeBase64(content.content)),
        ),
      };
    };
    let policy: Awaited<ReturnType<typeof readPolicy>>;
    if (credential === undefined) {
      policy = await readPolicy(runner);
    } else {
      policy = await withCredential(credential, ({ run }) => readPolicy(run));
    }
    const terminalApprovalMatches = lifecycle.reviewClaim?.state === 'terminal-approved'
      && lifecycle.reviewClaim.head === pr.headOid
      && lifecycle.terminalVerdict?.head === pr.headOid
      && lifecycle.terminalVerdict.state === 'APPROVE'
      && lifecycle.terminalVerdict.marker === lifecycle.reviewClaim.verdict.marker;
    return {
      issueNumber: lifecycle.issueNumber,
      prNumber: pr.number,
      open: pr.state === 'OPEN',
      head: pr.headOid,
      headRefName: gitRefName(pr.headRefName),
      baseRefName: gitRefName(pr.baseRefName),
      targetBaseOid: policy.baseOid,
      draft: pr.isDraft,
      labels: [...pr.labels],
      body: pr.body,
      humanHold: lifecycle.humanHold === true
        || lifecycle.projectStatus === 'Human'
        || pr.labels.includes('review:needs-human'),
      terminalApprovalMatches,
      mergeState: lifecycle.mergeState,
      codeownerSensitive: policy.codeownerSensitive,
      changedFilesComplete: true,
      ...(pr.branchClaim === undefined ? {} : { branchClaim: pr.branchClaim }),
    };
  };
  const mutateReadback = async (
    mutate: () => Promise<unknown>,
    readback: () => Promise<boolean>,
    detail: string,
  ) => {
    let original: unknown;
    try {
      await mutate();
    } catch (error) {
      original = error;
    }
    if (await readback()) return;
    if (original !== undefined) throw original;
    throw new Error(detail);
  };

  return {
    readCandidate: async (prNumber) => candidate(await options.readSnapshot(), prNumber),
    confirmAuthority: async ({ prNumber }) =>
      candidate(await options.readSnapshot(), prNumber),

    createClaimCommit: async ({ claim, parent, credential }) =>
      withCredential(credential, async ({ run }) => {
        const tree = gitOid((await run('git', [
          '-C', options.repositoryPath,
          'rev-parse', '--verify', `${parent}^{tree}`,
        ])).trim());
        return gitOid((await run('git', [
          '-C', options.repositoryPath,
          'commit-tree', tree, '-p', parent,
          '-m', ['Autopilot merge-prep claim', '', encodeBranchClaimTrailers(claim)].join('\n'),
        ])).trim());
      }),

    claimBranch: ({ branch, expectedRemoteHead, claimOid, credential }) =>
      withCredential(credential, ({ askpass, run }) =>
        makeGitProtocolPort(
          (_command, args) => run('git', [
            ...gitPublicationArgs(askpass, []),
            '-C', options.repositoryPath,
            ...args,
          ]),
          { remote: CANONICAL_GITHUB_HTTPS_REMOTE },
        ).claimBranch({
          branch,
          candidateParent: expectedRemoteHead,
          expectedRemoteHead,
          claimOid,
        })),

    async repairProjection({ candidate: original, claimOid, credential }) {
      await withCredential(credential, async ({ run }) => {
        const readPr = async () => JSON.parse(await run('gh', [
          'pr', 'view', String(original.prNumber), '--repo', REPO,
          '--json', 'headRefOid,isDraft,labels',
        ])) as {
          headRefOid?: string;
          isDraft?: boolean;
          labels?: Array<{ name?: string }>;
        };
        const exact = (pr: Awaited<ReturnType<typeof readPr>>) =>
          pr.headRefOid === claimOid && Array.isArray(pr.labels);
        let pr = await readPr();
        if (!exact(pr)) throw new Error('Merge-prep projection head changed');
        if (pr.labels!.some((label) => label.name === 'review:needs-human')) {
          throw new Error('Merge-prep projection stopped because Human is dominant');
        }
        if (!pr.isDraft) {
          await mutateReadback(
            () => run('gh', [
              'pr', 'ready', '--undo', String(original.prNumber), '--repo', REPO,
            ]),
            async () => exact(await readPr()) && (await readPr()).isDraft === true,
            'Merge-prep draft mutation was ambiguous',
          );
        }
        pr = await readPr();
        if (!pr.labels!.some((label) => label.name === 'engine:review')) {
          await mutateReadback(
            () => run('gh', [
              'pr', 'edit', String(original.prNumber), '--repo', REPO,
              '--add-label', 'engine:review',
            ]),
            async () => {
              const after = await readPr();
              return exact(after)
                && after.labels!.some((label) => label.name === 'engine:review');
            },
            'Merge-prep label mutation was ambiguous',
          );
        }
        const project = await fetchProjectSnapshot(run);
        const item = project.items.find((entry) =>
          entry.contentType === 'Issue' && entry.number === original.issueNumber);
        if (item === undefined || item.blockedOn === 'Human' || item.status === 'Human') {
          throw new Error('Merge-prep Project authority is missing or Human-held');
        }
        if (item.status !== 'In Review') {
          const fields = await fetchFieldIds(run);
          await mutateReadback(
            () => run('gh', [
              'project', 'item-edit',
              '--id', item.id,
              '--project-id', fields.projectId,
              '--field-id', fields.status.fieldId,
              '--single-select-option-id', fields.status.options['In Review'],
            ]),
            async () => {
              const after = await fetchProjectSnapshot(run);
              const current = after.items.find((entry) =>
                entry.contentType === 'Issue' && entry.number === original.issueNumber);
              return current?.status === 'In Review' && current.blockedOn !== 'Human';
            },
            'Merge-prep Project mutation was ambiguous',
          );
        }
      });
    },

    async createAttempt(input) {
      const create = options.createWorkspace ?? createAttemptWorkspace;
      return create({
        repositoryPath: options.repositoryPath,
        worktreeBase: options.worktreeBase,
        runnerId: options.runnerId,
        phase: 'merge-prep',
        subject: `pr-${input.prNumber}`,
        issueNumber: input.issueNumber,
        prNumber: input.prNumber,
        branch: input.branch,
        targetBase: input.targetBase,
        targetBaseOid: input.targetBaseOid,
        expectedHead: input.expectedHead,
        claimOid: input.claimOid,
        selectedLogin: input.selectedLogin,
        attemptId: input.attemptId ?? randomUUID(),
        remoteName: options.remoteName ?? 'jinn-autopilot-v2',
      }, runner);
    },
  };
}
