import type { CommandRunner } from '../dispatcher/issue-source.js';
import { defaultRunner } from '../dispatcher/issue-source.js';
import { REPO } from '../dispatcher/constants.js';
import { ensureFieldIds } from '../dispatcher/field-cache.js';
import { selectReady } from '../dispatcher/ready-filter.js';
import { resolveStackReady } from '../dispatcher/stack-readiness.js';
import type { PrLink } from '../dispatcher/pr-links.js';
import type { CreateAttemptOptions } from './attempt-workspace.js';
import { createAttemptWorkspace } from './attempt-workspace.js';
import { encodeBranchClaimTrailers } from './codecs.js';
import {
  gitPublicationArgs,
  selectCredential,
  type CredentialPool,
  type SelectedCredential,
} from './credentials.js';
import { makeGitProtocolPort } from './git-protocol.js';
import { parseChildMarker } from './child-issues.js';
import {
  CANONICAL_GITHUB_HTTPS_REMOTE,
  runCanonicalImplementationRealityCheck,
  type ImplementationExecutorDeps,
  type ImplementationPullRequest,
} from './implementation-executor.js';
import { withSelectedCredential } from './production-auth.js';
import type { GitHubLifecycleSnapshot } from './snapshot.js';
import { gitOid, gitRefName } from './types.js';

export interface ProductionImplementationActionPortOptions {
  readonly repositoryPath: string;
  readonly worktreeBase: string;
  readonly runnerId: string;
  readonly remoteName?: string;
  readonly credentials: CredentialPool;
  readonly authorAllowlist: ReadonlySet<string>;
  readonly readSnapshot: () => Promise<GitHubLifecycleSnapshot>;
  readonly runner?: CommandRunner;
  readonly environment?: NodeJS.ProcessEnv;
  readonly createWorkspace?: (
    options: CreateAttemptOptions,
    runner: CommandRunner,
  ) => Promise<Awaited<ReturnType<typeof createAttemptWorkspace>>>;
}

export type ProductionImplementationActionPort = Pick<
ImplementationExecutorDeps,
| 'readIssue'
| 'runRealityCheck'
| 'listOpenPullRequests'
| 'readTargetBaseHead'
| 'createClaimCommit'
| 'claimBranch'
| 'ensureDraftPullRequest'
| 'readParentPullRequest'
| 'setProjectInProgress'
| 'createAttempt'
| 'escalateHuman'
| 'closeChildIssue'
>;

function parsePullRequest(raw: string): ImplementationPullRequest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error('Malformed implementation PR readback');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Malformed implementation PR readback');
  }
  const pr = parsed as Record<string, unknown>;
  if (
    typeof pr.number !== 'number'
    || typeof pr.headRefName !== 'string'
    || typeof pr.headRefOid !== 'string'
    || typeof pr.baseRefName !== 'string'
    || typeof pr.isDraft !== 'boolean'
    || typeof pr.body !== 'string'
    || !Array.isArray(pr.labels)
  ) {
    throw new Error('Malformed implementation PR readback');
  }
  const labels = pr.labels.map((entry) => {
    if (
      typeof entry !== 'object'
      || entry === null
      || typeof (entry as { name?: unknown }).name !== 'string'
    ) {
      throw new Error('Malformed implementation PR label readback');
    }
    return (entry as { name: string }).name;
  });
  return {
    number: pr.number,
    headRefName: gitRefName(pr.headRefName),
    head: gitOid(pr.headRefOid),
    baseRefName: gitRefName(pr.baseRefName),
    draft: pr.isDraft,
    labels,
    body: pr.body,
  };
}

const READBACK_CONFIRMATION_ATTEMPTS = 6;
const READBACK_CONFIRMATION_DELAY_MS = 750;

async function mutateWithExactReadback(
  mutate: () => Promise<unknown>,
  confirmed: () => Promise<boolean>,
  detail: string,
): Promise<void> {
  let mutationError: unknown;
  try {
    await mutate();
  } catch (error) {
    mutationError = error;
  }
  for (let attempt = 0; attempt < READBACK_CONFIRMATION_ATTEMPTS; attempt += 1) {
    if (await confirmed()) return;
    if (attempt < READBACK_CONFIRMATION_ATTEMPTS - 1) {
      await new Promise((resolve) => {
        setTimeout(resolve, READBACK_CONFIRMATION_DELAY_MS);
      });
    }
  }
  if (mutationError !== undefined) throw mutationError;
  throw new Error(detail);
}

function prLinks(snapshot: GitHubLifecycleSnapshot): Map<number, PrLink[]> {
  const links = new Map<number, PrLink[]>();
  for (const pr of snapshot.pullRequests) {
    const link: PrLink = {
      prNumber: pr.number,
      headRefName: pr.headRefName,
      baseRefName: pr.baseRefName,
      state: pr.state,
      isDraft: pr.isDraft,
      author: pr.author,
      labels: [...pr.labels],
    };
    for (const issueNumber of pr.closingIssueNumbers) {
      const current = links.get(issueNumber) ?? [];
      current.push(link);
      links.set(issueNumber, current);
    }
  }
  return links;
}

export function makeProductionImplementationActionPort(
  options: ProductionImplementationActionPortOptions,
): ProductionImplementationActionPort {
  const runner = options.runner ?? defaultRunner;
  const ambient = options.environment ?? process.env;
  const withCredential = <Value>(
    credential: SelectedCredential,
    operation: Parameters<typeof withSelectedCredential<Value>>[2],
  ) => withSelectedCredential(credential, ambient, operation, runner);
  const readPr = (
    branch: string,
    run: CommandRunner,
  ): Promise<ImplementationPullRequest> => run('gh', [
    'pr', 'list', '--repo', REPO,
    '--head', branch,
    '--state', 'open',
    '--json', 'number,headRefName,headRefOid,baseRefName,isDraft,labels,body',
    '--limit', '1',
  ]).then((raw) => {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed) || parsed.length === 0) {
      throw new Error('Open implementation PR is missing');
    }
    if (parsed.length > 1) {
      throw new Error('Open implementation PR mapping is ambiguous');
    }
    return parsePullRequest(JSON.stringify(parsed[0]));
  });
  const exactPr = (
    pr: ImplementationPullRequest,
    input: Parameters<ImplementationExecutorDeps['ensureDraftPullRequest']>[0],
  ) => pr.headRefName === input.branch
    && pr.head === input.claimOid
    && pr.baseRefName === input.targetBase
    && pr.draft
    && pr.labels.includes(input.label)
    && pr.body === input.body;
  const selectedImplementationCredential = (): SelectedCredential => {
    const selection = selectCredential(options.credentials, { phase: 'implement' });
    if (selection.status !== 'selected') throw new Error(selection.detail);
    return selection.credential;
  };

  return {
    async readIssue(issueNumber) {
      const snapshot = await options.readSnapshot();
      const source = snapshot.issues.find((issue) => issue.number === issueNumber);
      const lifecycle = snapshot.lifecycle.items.find((item) =>
        item.issueNumber === issueNumber);
      if (source === undefined || lifecycle === undefined) return null;
      const stackReady = resolveStackReady(
        [...snapshot.issues],
        prLinks(snapshot),
        options.authorAllowlist,
      );
      const selected = selectReady(
        [...snapshot.issues],
        new Set(),
        options.authorAllowlist,
        stackReady,
      ).ready.some((issue) => issue.number === issueNumber);
      const existing = snapshot.pullRequests.find((pr) =>
        pr.state === 'OPEN' && (
          pr.closingIssueNumbers.includes(issueNumber)
          || pr.body.includes(`<!-- jinn-autopilot:v2 issue=${issueNumber} `)
        ));
      const eligible = lifecycle.kind === 'issue'
        ? lifecycle.eligible && lifecycle.humanHold !== true
        : selected
          && lifecycle.humanHold !== true
          && lifecycle.branchClaim?.phase === 'implement'
          && lifecycle.branchClaim.phaseComplete !== true
          && lifecycle.isDraft;
      return {
        number: source.number,
        title: source.title,
        open: true,
        eligible,
        targetBase: gitRefName(
          existing?.baseRefName
          ?? stackReady.get(issueNumber)?.baseBranch
          ?? 'next',
        ),
        effort: source.effort,
        ...((): { child?: { parentPr: number; kind: 'review-finding' | 'reconcile' } } => {
          const marker = parseChildMarker(source.body ?? '');
          return marker === null
            ? {}
            : { child: { parentPr: marker.parentPr, kind: marker.kind } };
        })(),
      };
    },

    runRealityCheck: (issueNumber) =>
      runCanonicalImplementationRealityCheck(issueNumber, runner),

    async listOpenPullRequests(issueNumber) {
      const snapshot = await options.readSnapshot();
      return snapshot.pullRequests
        .filter((pr) => pr.state === 'OPEN' && (
          pr.closingIssueNumbers.includes(issueNumber)
          || pr.body.includes(`<!-- jinn-autopilot:v2 issue=${issueNumber} `)
        ))
        .map((pr) => ({
          number: pr.number,
          headRefName: gitRefName(pr.headRefName),
          head: pr.headOid,
          baseRefName: gitRefName(pr.baseRefName),
          draft: pr.isDraft,
          labels: [...pr.labels],
          body: pr.body,
        }));
    },

    async readParentPullRequest(prNumber) {
      const snapshot = await options.readSnapshot();
      const pr = snapshot.pullRequests.find((entry) =>
        entry.number === prNumber && entry.state === 'OPEN');
      if (pr === undefined) return null;
      return {
        number: pr.number,
        headRefName: gitRefName(pr.headRefName),
        head: pr.headOid,
        baseRefName: gitRefName(pr.baseRefName),
        draft: pr.isDraft,
        labels: [...pr.labels],
        body: pr.body,
      };
    },

    readTargetBaseHead: (targetBase, credential) =>
      withCredential(credential, async ({ askpass, run }) => {
        const ref = `refs/heads/${targetBase}`;
        const raw = await run('git', [
          ...gitPublicationArgs(askpass, []),
          '-C', options.repositoryPath,
          'ls-remote', CANONICAL_GITHUB_HTTPS_REMOTE, ref,
        ]);
        const lines = raw.trimEnd().split('\n').filter((line) =>
          line.endsWith(`\t${ref}`));
        if (lines.length !== 1) throw new Error('Target-base readback is ambiguous');
        return gitOid(lines[0]!.split('\t')[0]!);
      }),

    createClaimCommit: ({ claim, parent, credential }) =>
      withCredential(credential, async ({ run }) => {
        const tree = gitOid((await run('git', [
          '-C', options.repositoryPath,
          'rev-parse', '--verify', `${parent}^{tree}`,
        ])).trim());
        return gitOid((await run('git', [
          '-C', options.repositoryPath,
          'commit-tree', tree, '-p', parent,
          '-m', [
            'Autopilot implementation claim',
            '',
            encodeBranchClaimTrailers(claim),
          ].join('\n'),
        ])).trim());
      }),

    claimBranch: ({
      branch,
      candidateParent,
      expectedRemoteHead,
      claimOid,
      credential,
    }) => withCredential(credential, ({ askpass, run }) =>
      makeGitProtocolPort(
        (_command, args) => run('git', [
          ...gitPublicationArgs(askpass, []),
          '-C', options.repositoryPath,
          ...args,
        ]),
        { remote: CANONICAL_GITHUB_HTTPS_REMOTE },
      ).claimBranch({
        branch,
        candidateParent,
        expectedRemoteHead,
        claimOid,
      })),

    ensureDraftPullRequest: (input) =>
      withCredential(input.credential, async ({ run }) => {
        const secureRunner: CommandRunner = (command, args) => run(command, args);
        let before: ImplementationPullRequest | null = null;
        try {
          before = await readPr(input.branch, secureRunner);
        } catch {
          // A missing PR is expected for a first claim; exact create readback follows.
        }
        if (before === null) {
          await mutateWithExactReadback(
            () => run('gh', [
              'pr', 'create', '--repo', REPO,
              '--head', input.branch,
              '--base', input.targetBase,
              '--title', input.title,
              '--body', input.body,
              '--draft',
              '--label', input.label,
            ]),
            async () => exactPr(await readPr(input.branch, secureRunner), input),
            'Draft implementation PR creation was ambiguous',
          );
          return readPr(input.branch, secureRunner);
        }
        if (before.head !== input.claimOid) {
          throw new Error('Existing implementation PR head differs from the exact claim');
        }
        if (!before.draft) {
          await mutateWithExactReadback(
            () => run('gh', [
              'pr', 'ready', String(before!.number), '--repo', REPO, '--undo',
            ]),
            async () => (await readPr(input.branch, secureRunner)).draft,
            'Implementation PR draft repair was ambiguous',
          );
        }
        const afterDraft = await readPr(input.branch, secureRunner);
        if (
          afterDraft.baseRefName !== input.targetBase
          || afterDraft.body !== input.body
          || !afterDraft.labels.includes(input.label)
        ) {
          await mutateWithExactReadback(
            () => run('gh', [
              'pr', 'edit', String(before.number), '--repo', REPO,
              '--base', input.targetBase,
              '--title', input.title,
              '--body', input.body,
              '--add-label', input.label,
            ]),
            async () => exactPr(await readPr(input.branch, secureRunner), input),
            'Implementation PR projection repair was ambiguous',
          );
        }
        return readPr(input.branch, secureRunner);
      }),

    setProjectInProgress: (issueNumber, expectedHead, credential) =>
      withCredential(credential, async ({ run }) => {
        const current = await options.readSnapshot();
        const item = current.project.items.find((candidate) =>
          candidate.contentType === 'Issue' && candidate.number === issueNumber);
        if (item === undefined) throw new Error('Implementation issue is missing from Project');
        if (item.status === 'Human' || item.blockedOn === 'Human') {
          throw new Error('Human is dominant over implementation Project acquisition');
        }
        if (item.status === 'In Progress') return;
        const branch = current.pullRequests.find((pr) =>
          pr.closingIssueNumbers.includes(issueNumber))?.headOid
          ?? current.branches.find((candidate) =>
            candidate.issueNumber === issueNumber)?.headOid;
        if (branch !== expectedHead) {
          throw new Error('Implementation Project mutation lost exact-head authority');
        }
        const secureRunner: CommandRunner = (command, args) => run(command, args);
        const fields = await ensureFieldIds(secureRunner);
        await mutateWithExactReadback(
          () => run('gh', [
            'project', 'item-edit',
            '--id', item.id,
            '--project-id', fields.projectId,
            '--field-id', fields.status.fieldId,
            '--single-select-option-id', fields.status.options['In Progress'],
          ]),
          async () => {
            const after = (await options.readSnapshot()).project.items.find((candidate) =>
              candidate.contentType === 'Issue'
              && candidate.number === issueNumber);
            return after?.status === 'In Progress'
              && after.blockedOn !== 'Human';
          },
          'Implementation Project projection was ambiguous',
        );
      }),

    async createAttempt(input) {
      const create = options.createWorkspace ?? createAttemptWorkspace;
      return create({
        repositoryPath: options.repositoryPath,
        worktreeBase: options.worktreeBase,
        runnerId: options.runnerId,
        phase: 'implement',
        subject: `issue-${input.issueNumber}`,
        issueNumber: input.issueNumber,
        prNumber: input.prNumber,
        branch: input.branch,
        targetBase: input.targetBase,
        expectedHead: input.expectedHead,
        claimOid: input.claimOid,
        selectedLogin: input.selectedLogin,
        credential: input.credential,
        attemptId: input.attemptId,
        remoteName: options.remoteName ?? 'jinn-autopilot-v2',
      }, runner);
    },

    async closeChildIssue({ issueNumber, comment, credential }) {
      await withCredential(credential, async ({ run }) => {
        await run('gh', [
          'issue', 'close', String(issueNumber),
          '--repo', REPO,
          '--comment', comment,
        ]);
      });
    },

    async escalateHuman({ issueNumber, reason }) {
      const credential = selectedImplementationCredential();
      await withCredential(credential, async ({ run }) => {
        const current = await options.readSnapshot();
        const item = current.project.items.find((candidate) =>
          candidate.contentType === 'Issue' && candidate.number === issueNumber);
        if (item === undefined) throw new Error('Escalated issue is missing from Project');
        const secureRunner: CommandRunner = (command, args) => run(command, args);
        const fields = await ensureFieldIds(secureRunner);
        if (item.status !== 'Human') {
          await mutateWithExactReadback(
            () => run('gh', [
              'project', 'item-edit',
              '--id', item.id,
              '--project-id', fields.projectId,
              '--field-id', fields.status.fieldId,
              '--single-select-option-id', fields.status.options.Human,
            ]),
            async () => (await options.readSnapshot()).project.items.find((candidate) =>
              candidate.contentType === 'Issue'
              && candidate.number === issueNumber)?.status === 'Human',
            'Implementation Human projection was ambiguous',
          );
        }
        const marker =
          `<!-- jinn-autopilot-human:v2 issue=${issueNumber} phase=${reason.phase} code=${reason.code} -->`;
        const comments = async () => run('gh', [
          'api', `repos/${REPO}/issues/${issueNumber}/comments`,
          '--paginate', '--jq', '.[].body',
        ]);
        if (!(await comments()).includes(marker)) {
          await mutateWithExactReadback(
            () => run('gh', [
              'issue', 'comment', String(issueNumber), '--repo', REPO,
              '--body', `${marker}\n\n${reason.detail}`,
            ]),
            async () => (await comments()).includes(marker),
            'Implementation Human comment was ambiguous',
          );
        }
      });
    },
  };
}
