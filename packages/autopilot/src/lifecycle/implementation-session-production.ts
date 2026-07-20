import type { CommandRunner } from '../dispatcher/issue-source.js';
import { defaultRunner } from '../dispatcher/issue-source.js';
import { REPO } from '../dispatcher/constants.js';
import { fetchFieldIds } from '../dispatcher/field-cache.js';
import { fetchProjectSnapshot } from '../dispatcher/project-snapshot.js';
import {
  advanceAttemptExpectedHead,
  readAttemptManifest,
  type AttemptManifest,
} from './attempt-workspace.js';
import {
  decodeBranchClaimTrailers,
  encodeBranchClaimTrailers,
} from './codecs.js';
import {
  gitPublicationArgs,
  isolatedGitCommandOverlay,
  sanitizedGitHubCommandOverlay,
} from './credentials.js';
import { validateCanonicalGitHubHttpsRemote } from './implementation-executor.js';
import type {
  ImplementationAuthority,
  ImplementationSessionPort,
  ImplementationSessionPullRequest,
} from './implementation-session.js';
import {
  IMPLEMENTATION_SUMMARY_END,
  IMPLEMENTATION_SUMMARY_START,
} from './implementation-session.js';
import { makeGitProtocolPort } from './git-protocol.js';
import { gitOid, gitRefName, type GitOid } from './types.js';

export interface ProductionImplementationSessionPortOptions {
  readonly runner?: CommandRunner;
  readonly environment?: NodeJS.ProcessEnv;
  readonly now?: () => Date;
  readonly readManifest?: (path: string) => AttemptManifest;
}

function parsePullRequest(raw: string): ImplementationSessionPullRequest {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    throw new Error('Malformed implementation PR readback');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Malformed implementation PR readback');
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.number !== 'number'
    || typeof record.headRefOid !== 'string'
    || typeof record.headRefName !== 'string'
    || typeof record.baseRefName !== 'string'
    || typeof record.isDraft !== 'boolean'
    || typeof record.body !== 'string'
    || !Array.isArray(record.labels)
  ) {
    throw new Error('Malformed implementation PR readback');
  }
  const labels = record.labels.map((label) => {
    if (typeof label !== 'object' || label === null || !('name' in label)) {
      throw new Error('Malformed implementation PR label readback');
    }
    const name = (label as { name?: unknown }).name;
    if (typeof name !== 'string') throw new Error('Malformed implementation PR label readback');
    return name;
  });
  return {
    number: record.number,
    head: gitOid(record.headRefOid),
    headRefName: record.headRefName,
    baseRefName: record.baseRefName,
    draft: record.isDraft,
    labels,
    body: record.body,
  };
}

function exactRemoteLine(raw: string, ref: string): GitOid {
  const matches = raw
    .trimEnd()
    .split('\n')
    .filter((line) => line.endsWith(`\t${ref}`));
  if (matches.length !== 1) throw new Error('Remote implementation branch readback is ambiguous');
  const [oid, observedRef, extra] = matches[0]!.split('\t');
  if (extra !== undefined || observedRef !== ref || oid === undefined) {
    throw new Error('Malformed remote implementation branch readback');
  }
  return gitOid(oid);
}

function claimTrailers(message: string): string | null {
  const lines = message
    .split(/\r?\n/)
    .filter((line) => line.startsWith('Jinn-Autopilot-'));
  return lines.length === 0 ? null : lines.join('\n');
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

export function makeProductionImplementationSessionPort(
  options: ProductionImplementationSessionPortOptions = {},
): ImplementationSessionPort {
  const runner = options.runner ?? defaultRunner;
  const ambient = options.environment ?? process.env;
  const token = ambient.GH_TOKEN;
  if (token === undefined || token.length === 0) {
    throw new Error('Implementation session requires its selected GH_TOKEN');
  }
  const manifestPath = ambient.JINN_AUTOPILOT_SESSION_MANIFEST;
  const currentManifest = (): AttemptManifest => {
    if (manifestPath === undefined || manifestPath.length === 0) {
      throw new Error('Implementation session manifest path is unavailable');
    }
    return (options.readManifest ?? readAttemptManifest)(manifestPath);
  };

  const environmentFor = (manifest: AttemptManifest): Record<string, string> => ({
    ...sanitizedGitHubCommandOverlay(ambient, { GH_TOKEN: token }),
    ...isolatedGitCommandOverlay(ambient, manifest.paths.askpass),
    GH_CONFIG_DIR: manifest.paths.ghConfigDir,
  });
  const run = async (
    manifest: AttemptManifest,
    command: string,
    args: string[],
  ): Promise<string> => runner(command, args, { env: environmentFor(manifest) });
  const runGit = (
    manifest: AttemptManifest,
    args: readonly string[],
  ): Promise<string> => run(manifest, 'git', [
    ...gitPublicationArgs(manifest.paths.askpass, []),
    '-C', manifest.paths.worktree,
    ...args,
  ]);
  const secureCommandRunner = (manifest: AttemptManifest) =>
    (command: 'git', args: readonly string[]): Promise<string> => {
      if (command !== 'git') throw new Error('Expected Git command');
      return runGit(manifest, args);
    };
  const validateRemote = async (manifest: AttemptManifest): Promise<void> => {
    const url = (await runGit(manifest, [
      'remote', 'get-url', manifest.repository.remoteName,
    ])).trim();
    validateCanonicalGitHubHttpsRemote(url);
  };
  const validateIdentity = async (manifest: AttemptManifest): Promise<void> => {
    const login = (await run(manifest, 'gh', [
      'api', 'user', '--jq', '.login',
    ])).trim();
    if (login.toLowerCase() !== manifest.selectedLogin.toLowerCase()) {
      throw new Error('Implementation session credential no longer matches the manifest identity');
    }
  };
  const readPullRequest = async (
    manifest: AttemptManifest,
    prNumber: number,
  ): Promise<ImplementationSessionPullRequest> => parsePullRequest(
    await run(manifest, 'gh', [
      'pr', 'view', String(prNumber),
      '--repo', REPO,
      '--json', 'number,headRefName,baseRefName,headRefOid,isDraft,labels,body',
    ]),
  );
  const requirePullRequestHead = async (
    manifest: AttemptManifest,
    prNumber: number,
    expectedHead: GitOid,
  ): Promise<ImplementationSessionPullRequest> => {
    const pullRequest = await readPullRequest(manifest, prNumber);
    if (pullRequest.head !== expectedHead) {
      throw new Error('Implementation PR head changed');
    }
    return pullRequest;
  };
  const readBranchClaim = async (
    manifest: AttemptManifest,
    oid: GitOid,
  ) => {
    const message = await runGit(manifest, [
      'show', '-s', '--format=%B', oid,
    ]);
    const trailers = claimTrailers(message);
    if (trailers === null) return null;
    try {
      return decodeBranchClaimTrailers(trailers);
    } catch {
      throw new Error('Branch ancestry contains malformed lifecycle metadata');
    }
  };

  return {
    readManifest: readAttemptManifest,

    async readAuthority(manifest): Promise<ImplementationAuthority> {
      await validateRemote(manifest);
      await validateIdentity(manifest);
      const ref = `refs/heads/${manifest.branch}`;
      const remoteHead = exactRemoteLine(
        await runGit(manifest, [
          'ls-remote', manifest.repository.remoteName, ref,
        ]),
        ref,
      );
      await runGit(manifest, [
        'fetch', '--quiet', manifest.repository.remoteName, ref,
      ]);
      const ancestry = (await runGit(manifest, [
        'rev-list', '--max-count=1000', remoteHead,
      ])).trim().split('\n').filter(Boolean);
      for (const rawOid of ancestry) {
        const oid = gitOid(rawOid);
        const latestClaim = await readBranchClaim(manifest, oid);
        if (latestClaim !== null) {
          return { remoteHead, latestClaimOid: oid, latestClaim };
        }
      }
      throw new Error('Winning implementation claim is missing from branch ancestry');
    },

    async readLocalHead(manifest) {
      return gitOid((await runGit(manifest, [
        'rev-parse', '--verify', 'HEAD^{commit}',
      ])).trim());
    },

    readBranchClaim,

    async isAncestor(manifest, ancestor, descendant) {
      try {
        await runGit(manifest, [
          'merge-base', '--is-ancestor', ancestor, descendant,
        ]);
        return true;
      } catch {
        return false;
      }
    },

    async treesDiffer(manifest, left, right) {
      const [leftTree, rightTree] = await Promise.all([
        runGit(manifest, ['rev-parse', '--verify', `${left}^{tree}`]),
        runGit(manifest, ['rev-parse', '--verify', `${right}^{tree}`]),
      ]);
      return gitOid(leftTree.trim()) !== gitOid(rightTree.trim());
    },

    async publishBranch({ manifest, expectedRemoteHead, newHead }) {
      await validateRemote(manifest);
      return makeGitProtocolPort(
        secureCommandRunner(manifest),
        { remote: manifest.repository.remoteName },
      ).publishMergePrep({
        branch: gitRefName(manifest.branch),
        expectedRemoteHead,
        newHead,
      });
    },

    advanceManifestHead: (path, expectedHead, nextHead) =>
      advanceAttemptExpectedHead(path, expectedHead, nextHead, options.now),

    async createCompletionCommit({ manifest, parent, completionClaim, summary }) {
      const tree = gitOid((await runGit(manifest, [
        'rev-parse', '--verify', `${parent}^{tree}`,
      ])).trim());
      const message = [
        'Autopilot implementation phase complete',
        '',
        summary.trim(),
        '',
        encodeBranchClaimTrailers(completionClaim),
      ].join('\n');
      const oid = gitOid((await runGit(manifest, [
        'commit-tree', tree,
        '-p', parent,
        '-m', message,
      ])).trim());
      await runGit(manifest, [
        'update-ref', 'HEAD', oid, parent,
      ]);
      return oid;
    },

    async readPullRequest(prNumber, expectedHead) {
      const manifest = currentManifest();
      return requirePullRequestHead(manifest, prNumber, expectedHead);
    },

    async ensureCompletionSummary(prNumber, expectedHead, summary) {
      const manifest = currentManifest();
      const before = await requirePullRequestHead(manifest, prNumber, expectedHead);
      const desired = completionBody(before.body, summary);
      if (before.body === desired) return;
      await run(manifest, 'gh', [
        'pr', 'edit', String(prNumber),
        '--repo', REPO,
        '--body', desired,
      ]);
      const after = await requirePullRequestHead(manifest, prNumber, expectedHead);
      if (after.body !== desired) throw new Error('Implementation summary PR edit was ambiguous');
    },

    async setPullRequestLabel(prNumber, expectedHead, label, present) {
      const manifest = currentManifest();
      const before = await requirePullRequestHead(manifest, prNumber, expectedHead);
      if (before.labels.includes(label) === present) return;
      await run(manifest, 'gh', [
        'pr', 'edit', String(prNumber),
        '--repo', REPO,
        present ? '--add-label' : '--remove-label',
        label,
      ]);
      const after = await requirePullRequestHead(manifest, prNumber, expectedHead);
      if (after.labels.includes(label) !== present) {
        throw new Error('Implementation PR label mutation was ambiguous');
      }
    },

    async setProjectStatus(issueNumber, expectedHead, status) {
      const manifest = currentManifest();
      await requirePullRequestHead(manifest, manifest.prNumber!, expectedHead);
      const secureRunner: CommandRunner = (cmd, args) => run(manifest, cmd, args);
      const snapshot = await fetchProjectSnapshot(secureRunner);
      const item = snapshot.items.find((candidate) =>
        candidate.contentType === 'Issue' && candidate.number === issueNumber);
      if (item === undefined) throw new Error('Implementation issue is missing from Project');
      if (item.status === status) return;
      const fields = await fetchFieldIds(secureRunner);
      await run(manifest, 'gh', [
        'project', 'item-edit',
        '--id', item.id,
        '--project-id', fields.projectId,
        '--field-id', fields.status.fieldId,
        '--single-select-option-id', fields.status.options[status],
      ]);
      await requirePullRequestHead(manifest, manifest.prNumber!, expectedHead);
      const after = await fetchProjectSnapshot(secureRunner);
      const updated = after.items.find((candidate) =>
        candidate.contentType === 'Issue' && candidate.number === issueNumber);
      if (updated?.status !== status) {
        throw new Error('Implementation Project projection was ambiguous');
      }
    },

    async readProjectStatus(issueNumber, expectedHead) {
      const manifest = currentManifest();
      await requirePullRequestHead(manifest, manifest.prNumber!, expectedHead);
      const secureRunner: CommandRunner = (cmd, args) => run(manifest, cmd, args);
      const snapshot = await fetchProjectSnapshot(secureRunner);
      return snapshot.items.find((candidate) =>
        candidate.contentType === 'Issue' && candidate.number === issueNumber)?.status ?? null;
    },

    async setPullRequestDraft(prNumber, expectedHead, draft) {
      const manifest = currentManifest();
      const before = await requirePullRequestHead(manifest, prNumber, expectedHead);
      if (before.draft === draft) return;
      await run(manifest, 'gh', [
        'pr', 'ready', String(prNumber),
        '--repo', REPO,
        ...(draft ? ['--undo'] : []),
      ]);
      const after = await requirePullRequestHead(manifest, prNumber, expectedHead);
      if (after.draft !== draft) {
        throw new Error('Implementation PR draft mutation was ambiguous');
      }
    },

    async hasHumanComment(prNumber, expectedHead, marker) {
      const manifest = currentManifest();
      await requirePullRequestHead(manifest, prNumber, expectedHead);
      const bodies = await run(manifest, 'gh', [
        'api', `repos/${REPO}/issues/${prNumber}/comments`,
        '--paginate',
        '--jq', '.[].body',
      ]);
      return bodies.includes(marker);
    },

    async ensureHumanComment(prNumber, expectedHead, marker, body) {
      const manifest = currentManifest();
      await requirePullRequestHead(manifest, prNumber, expectedHead);
      await run(manifest, 'gh', [
        'pr', 'comment', String(prNumber),
        '--repo', REPO,
        '--body', body,
      ]);
      await requirePullRequestHead(manifest, prNumber, expectedHead);
      const bodies = await run(manifest, 'gh', [
        'api', `repos/${REPO}/issues/${prNumber}/comments`,
        '--paginate',
        '--jq', '.[].body',
      ]);
      if (!bodies.includes(marker)) {
        throw new Error('Implementation Human comment mutation was ambiguous');
      }
    },
  };
}
