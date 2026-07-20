import type { CommandRunner } from '../dispatcher/issue-source.js';
import { defaultRunner } from '../dispatcher/issue-source.js';
import { parseOwnedPrefixes, touchesCodeOwnedPath } from '../dispatcher/code-owned.js';
import { REPO } from '../dispatcher/constants.js';
import { ensureFieldIds } from '../dispatcher/field-cache.js';
import { fetchProjectSnapshot } from '../dispatcher/project-snapshot.js';
import {
  advanceAttemptExpectedHead,
  readAttemptManifest,
  type AttemptManifest,
} from './attempt-workspace.js';
import {
  decodeBranchClaimTrailers,
  encodeBranchClaimTrailers,
  extractMergePrepCompletionSummary,
  terminalBranchClaimTrailers,
} from './codecs.js';
import {
  gitPublicationArgs,
  isolatedGitCommandOverlay,
  sanitizedGitHubCommandOverlay,
} from './credentials.js';
import { makeGitProtocolPort } from './git-protocol.js';
import { readExactChangedFiles } from './github-changed-files.js';
import { validateCanonicalGitHubHttpsRemote } from './implementation-executor.js';
import type {
  MergePrepAuthority,
  MergePrepSessionPort,
  MergePrepSessionPullRequest,
} from './merge-prep-session.js';
import { gitOid, gitRefName, type GitOid } from './types.js';

export const MERGE_PREP_SUMMARY_START =
  '<!-- jinn-autopilot:v2 merge-prep-summary:start -->';
export const MERGE_PREP_SUMMARY_END =
  '<!-- jinn-autopilot:v2 merge-prep-summary:end -->';

export interface ProductionMergePrepSessionPortOptions {
  readonly runner?: CommandRunner;
  readonly environment?: NodeJS.ProcessEnv;
  readonly now?: () => Date;
  readonly readManifest?: (path: string) => AttemptManifest;
}

function exactRemote(raw: string, ref: string): GitOid {
  const lines = raw.trimEnd().split('\n').filter((line) => line.endsWith(`\t${ref}`));
  if (lines.length !== 1) throw new Error(`Remote ref ${ref} readback is incomplete`);
  return gitOid(lines[0]!.split('\t')[0]!);
}

function summaryBody(body: string, summary: string): string {
  const section = `${MERGE_PREP_SUMMARY_START}\n${summary.trim()}\n${MERGE_PREP_SUMMARY_END}`;
  const start = body.indexOf(MERGE_PREP_SUMMARY_START);
  const end = body.indexOf(MERGE_PREP_SUMMARY_END);
  if (start === -1 && end === -1) return `${body.trimEnd()}\n\n${section}\n`;
  if (start === -1 || end < start) throw new Error('Contradictory merge-prep summary markers');
  return `${body.slice(0, start)}${section}${body.slice(end + MERGE_PREP_SUMMARY_END.length)}`;
}

function labelsFrom(raw: unknown): string[] {
  if (!Array.isArray(raw)) throw new Error('Malformed PR labels');
  return raw.map((label) => {
    if (typeof label !== 'object' || label === null || !('name' in label)) {
      throw new Error('Malformed PR label');
    }
    const name = (label as { name?: unknown }).name;
    if (typeof name !== 'string') throw new Error('Malformed PR label');
    return name;
  });
}

export function rangeDiffProvesMechanical(raw: string): boolean {
  const rows = raw.split('\n').filter((line) => line.trim().length > 0);
  return rows.length > 0 && rows.every((line) =>
    /^\s*\d+:\s+[0-9a-f]{4,}\s+=\s+\d+:\s+[0-9a-f]{4,}\s+/.test(line));
}

export function makeProductionMergePrepSessionPort(
  options: ProductionMergePrepSessionPortOptions = {},
): MergePrepSessionPort {
  const runner = options.runner ?? defaultRunner;
  const ambient = options.environment ?? process.env;
  const token = ambient.GH_TOKEN;
  if (!token) throw new Error('Merge-prep session requires its selected GH_TOKEN');
  const manifestPath = ambient.JINN_AUTOPILOT_SESSION_MANIFEST;
  const currentManifest = () => {
    if (!manifestPath) throw new Error('Merge-prep session manifest path is unavailable');
    return (options.readManifest ?? readAttemptManifest)(manifestPath);
  };
  const envFor = (manifest: AttemptManifest) => ({
    ...sanitizedGitHubCommandOverlay(ambient, { GH_TOKEN: token }),
    ...isolatedGitCommandOverlay(ambient, manifest.paths.askpass),
    GH_CONFIG_DIR: manifest.paths.ghConfigDir,
  });
  const run = (manifest: AttemptManifest, command: string, args: string[]) =>
    runner(command, args, { env: envFor(manifest) });
  const git = (manifest: AttemptManifest, args: readonly string[]) => run(
    manifest,
    'git',
    [...gitPublicationArgs(manifest.paths.askpass, []), '-C', manifest.paths.worktree, ...args],
  );
  const secureRunner = (manifest: AttemptManifest): CommandRunner =>
    (command, args) => run(manifest, command, [...args]);
  const readPr = async (
    manifest: AttemptManifest,
  ): Promise<MergePrepSessionPullRequest & { readonly rawBody: string }> => {
    const parsed = JSON.parse(await run(manifest, 'gh', [
      'pr', 'view', String(manifest.prNumber), '--repo', REPO,
      '--json', 'number,headRefOid,headRefName,baseRefName,isDraft,labels,body',
    ])) as Record<string, unknown>;
    if (
      typeof parsed.number !== 'number'
      || typeof parsed.headRefOid !== 'string'
      || typeof parsed.headRefName !== 'string'
      || typeof parsed.baseRefName !== 'string'
      || typeof parsed.isDraft !== 'boolean'
      || typeof parsed.body !== 'string'
    ) {
      throw new Error('Malformed merge-prep PR readback');
    }
    const labels = labelsFrom(parsed.labels);
    const project = await fetchProjectSnapshot(secureRunner(manifest));
    const item = project.items.find((entry) =>
      entry.contentType === 'Issue' && entry.number === manifest.issueNumber);
    if (item === undefined) throw new Error('Merge-prep issue is missing from Project');
    const changedFiles = await readExactChangedFiles({
      run: secureRunner(manifest),
      prNumber: manifest.prNumber as number,
      expectedHead: gitOid(parsed.headRefOid),
      expectedBaseRefName: parsed.baseRefName,
      context: 'Merge-prep',
    });
    if (
      manifest.targetBaseOid === undefined
      || changedFiles.baseOid !== manifest.targetBaseOid
    ) {
      throw new Error('Merge-prep target base changed');
    }
    const content = JSON.parse(await run(manifest, 'gh', [
      'api',
      `repos/${REPO}/contents/.github/CODEOWNERS?ref=${changedFiles.baseOid}`,
    ])) as { content?: unknown };
    if (typeof content.content !== 'string') throw new Error('CODEOWNERS read was incomplete');
    const codeowners = Buffer.from(content.content.replace(/\n/g, ''), 'base64').toString('utf8');
    return {
      number: parsed.number,
      issueNumber: manifest.issueNumber,
      head: gitOid(parsed.headRefOid),
      headRefName: parsed.headRefName,
      baseRefName: parsed.baseRefName,
      draft: parsed.isDraft,
      labels,
      body: parsed.body,
      rawBody: parsed.body,
      humanHold: item.status === 'Human'
        || item.blockedOn === 'Human'
        || labels.includes('review:needs-human'),
      codeownerSensitive: touchesCodeOwnedPath(
        [...changedFiles.files],
        parseOwnedPrefixes(codeowners),
      ),
      changedFilesComplete: changedFiles.complete,
    };
  };
  const mutateReadback = async (
    mutation: () => Promise<unknown>,
    readback: () => Promise<boolean>,
    detail: string,
  ) => {
    let original: unknown;
    try {
      await mutation();
    } catch (error) {
      original = error;
    }
    if (await readback()) return;
    if (original !== undefined) throw original;
    throw new Error(detail);
  };
  const assertExactHead = async (manifest: AttemptManifest, expected: GitOid) => {
    const pr = await readPr(manifest);
    if (pr.head !== expected) throw new Error('Merge-prep PR head changed');
    return pr;
  };

  return {
    readManifest: options.readManifest ?? readAttemptManifest,

    async readAuthority(manifest): Promise<MergePrepAuthority> {
      const url = (await git(manifest, ['remote', 'get-url', manifest.repository.remoteName])).trim();
      validateCanonicalGitHubHttpsRemote(url);
      const login = (await run(manifest, 'gh', ['api', 'user', '--jq', '.login'])).trim();
      if (login.toLowerCase() !== manifest.selectedLogin.toLowerCase()) {
        throw new Error('Merge-prep credential no longer matches manifest identity');
      }
      const branchRef = `refs/heads/${manifest.branch}`;
      const baseRef = `refs/heads/${manifest.targetBase}`;
      const remoteHead = exactRemote(
        await git(manifest, ['ls-remote', manifest.repository.remoteName, branchRef]),
        branchRef,
      );
      const targetBaseOid = exactRemote(
        await git(manifest, ['ls-remote', manifest.repository.remoteName, baseRef]),
        baseRef,
      );
      await git(manifest, ['fetch', '--quiet', manifest.repository.remoteName, branchRef, baseRef]);
      const ancestry = (await git(manifest, [
        'rev-list', '--max-count=1000', remoteHead,
      ])).trim().split('\n').filter(Boolean);
      for (const raw of ancestry) {
        const oid = gitOid(raw);
        const message = await git(manifest, ['show', '-s', '--format=%B', oid]);
        const trailers = terminalBranchClaimTrailers(message);
        if (trailers === null) continue;
        const latestClaim = decodeBranchClaimTrailers(trailers);
        if (
          latestClaim.phase === 'merge-prep'
          && latestClaim.issueNumber === manifest.issueNumber
          && latestClaim.prNumber === manifest.prNumber
        ) {
          return {
            remoteHead,
            latestClaimOid: oid,
            latestClaim,
            targetBaseOid,
            pullRequest: await readPr(manifest),
          };
        }
      }
      throw new Error('Winning merge-prep claim is missing from branch ancestry');
    },

    readLocalHead: async (manifest) =>
      gitOid((await git(manifest, ['rev-parse', '--verify', 'HEAD^{commit}'])).trim()),
    readLocalStatusClean: async (manifest) =>
      (await git(manifest, ['status', '--porcelain', '--untracked-files=all'])).trim() === '',
    classifyPreparedResult: async (manifest) => {
      const pr = await readPr(manifest);
      if (pr.codeownerSensitive) return 'codeowner';
      if (manifest.targetBaseOid === undefined) return 'unproven';
      try {
        const originalHead = gitOid((await git(manifest, [
          'rev-parse', '--verify', `${manifest.claimOid}^`,
        ])).trim());
        const originalBase = gitOid((await git(manifest, [
          'merge-base', originalHead, manifest.targetBaseOid,
        ])).trim());
        const preparedHead = gitOid((await git(manifest, [
          'rev-parse', '--verify', 'HEAD^{commit}',
        ])).trim());
        const rangeDiff = await git(manifest, [
          'range-diff',
          '--no-color',
          '--no-dual-color',
          '--no-patch',
          `${originalBase}..${originalHead}`,
          `${manifest.targetBaseOid}..${preparedHead}`,
        ]);
        return rangeDiffProvesMechanical(rangeDiff)
          ? 'mechanical'
          : 'unproven';
      } catch {
        return 'unproven';
      }
    },
    async isAncestor(manifest, ancestor, descendant) {
      try {
        await git(manifest, ['merge-base', '--is-ancestor', ancestor, descendant]);
        return true;
      } catch {
        return false;
      }
    },
    async treesDiffer(manifest, left, right) {
      const [a, b] = await Promise.all([
        git(manifest, ['rev-parse', `${left}^{tree}`]),
        git(manifest, ['rev-parse', `${right}^{tree}`]),
      ]);
      return a.trim() !== b.trim();
    },
    async readBranchClaim(manifest, oid) {
      const message = await git(manifest, ['show', '-s', '--format=%B', oid]);
      const trailers = terminalBranchClaimTrailers(message);
      return trailers === null ? null : decodeBranchClaimTrailers(trailers);
    },
    async readCompletionSummary(manifest, oid) {
      const message = await git(manifest, ['show', '-s', '--format=%B', oid]);
      const trailers = terminalBranchClaimTrailers(message);
      return trailers === null ? null : extractMergePrepCompletionSummary(message, trailers);
    },
    async createCompletionCommit({ manifest, preparedHead, completionClaim, summary }) {
      const tree = gitOid((await git(manifest, [
        'rev-parse', '--verify', `${preparedHead}^{tree}`,
      ])).trim());
      const message = [
        'Autopilot merge-prep phase complete',
        '',
        summary.trim(),
        '',
        encodeBranchClaimTrailers(completionClaim),
      ].join('\n');
      const oid = gitOid((await git(manifest, [
        'commit-tree', tree, '-p', preparedHead, '-m', message,
      ])).trim());
      await git(manifest, ['update-ref', 'HEAD', oid, preparedHead]);
      return oid;
    },
    publishPrepared: ({ manifest, expectedRemoteHead, newHead }) =>
      makeGitProtocolPort(
        (_command, args) => git(manifest, args),
        { remote: manifest.repository.remoteName },
      ).publishMergePrep({
        branch: gitRefName(manifest.branch),
        expectedRemoteHead,
        newHead,
      }),
    advanceManifestHead: (path, expected, next) =>
      advanceAttemptExpectedHead(path, expected, next, options.now),

    async ensureCompletionSummary(prNumber, expectedHead, summary) {
      const manifest = currentManifest();
      const before = await assertExactHead(manifest, expectedHead);
      const desired = summaryBody(before.body, summary);
      if (before.body === desired) return;
      await mutateReadback(
        () => run(manifest, 'gh', [
          'pr', 'edit', String(prNumber), '--repo', REPO, '--body', desired,
        ]),
        async () => (await assertExactHead(manifest, expectedHead)).body === desired,
        'Merge-prep summary mutation was ambiguous',
      );
    },
    async setPullRequestLabel(prNumber, expectedHead, label, present) {
      const manifest = currentManifest();
      const before = await assertExactHead(manifest, expectedHead);
      if (before.labels.includes(label) === present) return;
      await mutateReadback(
        () => run(manifest, 'gh', [
          'pr', 'edit', String(prNumber), '--repo', REPO,
          present ? '--add-label' : '--remove-label', label,
        ]),
        async () => (await assertExactHead(manifest, expectedHead)).labels.includes(label) === present,
        'Merge-prep label mutation was ambiguous',
      );
    },
    async setProjectStatus(issueNumber, expectedHead, status) {
      const manifest = currentManifest();
      const pr = await assertExactHead(manifest, expectedHead);
      if (status === 'In Review' && pr.humanHold) throw new Error('Human is dominant');
      const secure = secureRunner(manifest);
      const snapshot = await fetchProjectSnapshot(secure);
      const item = snapshot.items.find((entry) =>
        entry.contentType === 'Issue' && entry.number === issueNumber);
      if (item === undefined) throw new Error('Merge-prep issue is missing from Project');
      if (item.status === status) return;
      const fields = await ensureFieldIds(secure);
      await mutateReadback(
        () => run(manifest, 'gh', [
          'project', 'item-edit',
          '--id', item.id,
          '--project-id', fields.projectId,
          '--field-id', fields.status.fieldId,
          '--single-select-option-id', fields.status.options[status],
        ]),
        async () => {
          await assertExactHead(manifest, expectedHead);
          const after = await fetchProjectSnapshot(secure);
          const current = after.items.find((entry) =>
            entry.contentType === 'Issue' && entry.number === issueNumber);
          return current?.status === status
            && (status !== 'In Review' || current.blockedOn !== 'Human');
        },
        'Merge-prep Project mutation was ambiguous',
      );
    },
    async setPullRequestDraft(prNumber, expectedHead, draft) {
      const manifest = currentManifest();
      const before = await assertExactHead(manifest, expectedHead);
      if (before.draft === draft) return;
      if (!draft && before.humanHold) throw new Error('Human is dominant');
      await mutateReadback(
        () => run(manifest, 'gh', [
          'pr', 'ready', String(prNumber), '--repo', REPO, ...(draft ? ['--undo'] : []),
        ]),
        async () => (await assertExactHead(manifest, expectedHead)).draft === draft,
        'Merge-prep draft mutation was ambiguous',
      );
    },
    async hasHumanComment(prNumber, expectedHead, marker) {
      const manifest = currentManifest();
      await assertExactHead(manifest, expectedHead);
      const bodies = await run(manifest, 'gh', [
        'api', `repos/${REPO}/issues/${prNumber}/comments`,
        '--paginate', '--jq', '.[].body',
      ]);
      return bodies.includes(marker);
    },
    async ensureHumanComment(prNumber, expectedHead, marker, body) {
      const manifest = currentManifest();
      await assertExactHead(manifest, expectedHead);
      await mutateReadback(
        () => run(manifest, 'gh', [
          'pr', 'comment', String(prNumber), '--repo', REPO, '--body', body,
        ]),
        async () => {
          await assertExactHead(manifest, expectedHead);
          const bodies = await run(manifest, 'gh', [
            'api', `repos/${REPO}/issues/${prNumber}/comments`,
            '--paginate', '--jq', '.[].body',
          ]);
          return bodies.includes(marker);
        },
        'Merge-prep Human comment mutation was ambiguous',
      );
    },
  };
}
