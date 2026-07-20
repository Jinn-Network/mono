import type { CommandRunner } from '../dispatcher/issue-source.js';
import { defaultRunner } from '../dispatcher/issue-source.js';
import { parseOwnedPrefixes, touchesCodeOwnedPath } from '../dispatcher/code-owned.js';
import { REPO } from '../dispatcher/constants.js';
import { fetchFieldIds } from '../dispatcher/field-cache.js';
import { fetchProjectSnapshot } from '../dispatcher/project-snapshot.js';
import type { SelectedCredential } from './credentials.js';
import type {
  MergeCandidate,
  MergeExecutorDeps,
  ExactMergeOutcome,
} from './merge-executor.js';
import { withSelectedCredential } from './production-auth.js';
import type { GitHubLifecycleSnapshot } from './snapshot.js';
import { gitOid, gitRefName } from './types.js';

export interface ProductionMergeActionPortOptions {
  readonly readSnapshot: () => Promise<GitHubLifecycleSnapshot>;
  readonly authorAllowlist: ReadonlySet<string>;
  readonly expectedBaseRefName?: string;
  readonly runner?: CommandRunner;
  readonly environment?: NodeJS.ProcessEnv;
}

export type ProductionMergeActionPort = Pick<
MergeExecutorDeps,
'readCandidate' | 'mergeExactHead' | 'reconcileDone'
>;

function decodeBase64(value: string): string {
  return Buffer.from(value.replace(/\n/g, ''), 'base64').toString('utf8');
}

export function makeProductionMergeActionPort(
  options: ProductionMergeActionPortOptions,
): ProductionMergeActionPort {
  const runner = options.runner ?? defaultRunner;
  const ambient = options.environment ?? process.env;
  const expectedBase = gitRefName(options.expectedBaseRefName ?? 'next');
  const withCredential = <Value>(
    credential: SelectedCredential,
    operation: Parameters<typeof withSelectedCredential<Value>>[2],
  ) => withSelectedCredential(credential, ambient, operation, runner);
  const readCandidate = async (prNumber: number): Promise<MergeCandidate | null> => {
    const snapshot = await options.readSnapshot();
    const pr = snapshot.pullRequests.find((entry) => entry.number === prNumber);
    if (pr === undefined) return null;
    const lifecycle = snapshot.lifecycle.items.find((entry) =>
      entry.kind === 'pull-request' && entry.prNumber === prNumber);
    const diagnostic = snapshot.diagnostics.find((entry) =>
      entry.pullRequests.some((candidate) => candidate.number === prNumber));
    if (lifecycle?.kind !== 'pull-request') return null;
    const base = JSON.parse(await runner('gh', [
      'api', `repos/${REPO}/git/ref/heads/${encodeURIComponent(pr.baseRefName)}`,
    ])) as { object?: { sha?: string } };
    const baseOid = gitOid(base.object?.sha ?? '');
    const filesRaw = JSON.parse(await runner('gh', [
      'api', `repos/${REPO}/pulls/${pr.number}/files?per_page=100`,
      '--paginate', '--slurp',
    ])) as unknown;
    if (!Array.isArray(filesRaw)) throw new Error('Merge changed-file read was incomplete');
    const files = (filesRaw as Array<Array<{ filename?: unknown }>>).flat().map((file) => {
      if (typeof file.filename !== 'string') throw new Error('Malformed merge changed file');
      return file.filename;
    });
    const codeownersRaw = JSON.parse(await runner('gh', [
      'api', `repos/${REPO}/contents/.github/CODEOWNERS?ref=${baseOid}`,
    ])) as { content?: unknown };
    if (typeof codeownersRaw.content !== 'string') {
      throw new Error('Merge CODEOWNERS read was incomplete');
    }
    const compare = JSON.parse(await runner('gh', [
      'api',
      `repos/${REPO}/compare/${baseOid}...${pr.headOid}`,
    ])) as { status?: unknown };
    const compareStatus = typeof compare.status === 'string'
      && ['ahead', 'identical', 'behind', 'diverged'].includes(compare.status)
      ? compare.status as 'ahead' | 'identical' | 'behind' | 'diverged'
      : 'unknown';
    const terminalApprovalMatches = lifecycle.reviewClaim?.state === 'terminal-approved'
      && lifecycle.reviewClaim.head === pr.headOid
      && lifecycle.terminalVerdict?.head === pr.headOid
      && lifecycle.terminalVerdict.state === 'APPROVE'
      && lifecycle.terminalVerdict.marker === lifecycle.reviewClaim.verdict.marker;
    return {
      issueNumber: lifecycle.issueNumber,
      prNumber: pr.number,
      open: pr.state === 'OPEN',
      merged: pr.state === 'MERGED',
      head: pr.headOid,
      baseRefName: gitRefName(pr.baseRefName),
      expectedBaseRefName: expectedBase,
      draft: pr.isDraft,
      labels: [...pr.labels],
      humanHold: lifecycle.humanHold === true
        || lifecycle.projectStatus === 'Human'
        || pr.labels.includes('review:needs-human'),
      author: pr.author,
      authorAllowed: options.authorAllowlist.has(pr.author.toLowerCase()),
      uniqueIssueMapping: diagnostic === undefined,
      terminalApprovalMatches,
      effectiveReviews: pr.reviews
        .filter((review) => review.commitId === pr.headOid)
        .map((review) => ({
          reviewer: review.reviewer,
          state: review.state,
          commitId: review.commitId,
        })),
      checks: pr.checks.map((check) => ({ ...check })),
      mergeable: pr.mergeability,
      mergeStateStatus: pr.mergeStateStatus,
      compareStatus,
      changedFilesComplete: true,
      codeownersComplete: true,
      codeownerSensitive: touchesCodeOwnedPath(
        files,
        parseOwnedPrefixes(decodeBase64(codeownersRaw.content)),
      ),
    };
  };

  return {
    readCandidate,
    mergeExactHead: ({ prNumber, head, credential }): Promise<ExactMergeOutcome> =>
      withCredential(credential, async ({ run }) => {
        try {
          const response = JSON.parse(await run('gh', [
            'api', '-X', 'PUT', `repos/${REPO}/pulls/${prNumber}/merge`,
            '-f', `sha=${head}`,
            '-f', 'merge_method=squash',
          ])) as { merged?: unknown; sha?: unknown; message?: unknown };
          if (response.merged === true && typeof response.sha === 'string') {
            return {
              status: 'merged',
              head,
              mergeCommitOid: gitOid(response.sha),
            };
          }
        } catch {
          // Exact PR readback below classifies accepted ambiguity versus rejection.
        }
        const readback = JSON.parse(await run('gh', [
          'pr', 'view', String(prNumber), '--repo', REPO,
          '--json', 'state,headRefOid,mergeCommit',
        ])) as {
          state?: unknown;
          headRefOid?: unknown;
          mergeCommit?: { oid?: unknown } | null;
        };
        if (
          readback.state === 'MERGED'
          && readback.headRefOid === head
          && typeof readback.mergeCommit?.oid === 'string'
        ) {
          return {
            status: 'already-merged',
            head,
            mergeCommitOid: gitOid(readback.mergeCommit.oid),
          };
        }
        if (typeof readback.headRefOid === 'string' && readback.headRefOid !== head) {
          return { status: 'changed-head', head: gitOid(readback.headRefOid) };
        }
        return { status: 'rejected', head, reason: 'GitHub rejected the exact-head merge gate' };
      }),

    reconcileDone: ({ issueNumber, prNumber, expectedHead, credential }) =>
      withCredential(credential, async ({ run }) => {
        const pr = JSON.parse(await run('gh', [
          'pr', 'view', String(prNumber), '--repo', REPO,
          '--json', 'state,headRefOid,mergeCommit',
        ])) as { state?: unknown; headRefOid?: unknown; mergeCommit?: unknown };
        if (pr.state !== 'MERGED' || pr.headRefOid !== expectedHead || pr.mergeCommit === null) {
          throw new Error('Merged readback is not exact');
        }
        const snapshot = await fetchProjectSnapshot(run);
        const item = snapshot.items.find((entry) =>
          entry.contentType === 'Issue' && entry.number === issueNumber);
        if (item === undefined) throw new Error('Merged issue is missing from Project');
        if (item.status !== 'Done') {
          const fields = await fetchFieldIds(run);
          let mutationError: unknown;
          try {
            await run('gh', [
              'project', 'item-edit',
              '--id', item.id,
              '--project-id', fields.projectId,
              '--field-id', fields.status.fieldId,
              '--single-select-option-id', fields.status.options.Done,
            ]);
          } catch (error) {
            mutationError = error;
          }
          const after = await fetchProjectSnapshot(run);
          const current = after.items.find((entry) =>
            entry.contentType === 'Issue' && entry.number === issueNumber);
          if (current?.status !== 'Done') {
            if (mutationError !== undefined) throw mutationError;
            throw new Error('Merged Done projection was ambiguous');
          }
        }
      }),
  };
}
