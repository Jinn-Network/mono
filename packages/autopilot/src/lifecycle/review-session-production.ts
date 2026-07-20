import { randomUUID } from 'node:crypto';
import {
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { CommandRunner } from '../dispatcher/issue-source.js';
import { defaultRunner } from '../dispatcher/issue-source.js';
import { REPO } from '../dispatcher/constants.js';
import { fetchFieldIds } from '../dispatcher/field-cache.js';
import { fetchProjectSnapshot } from '../dispatcher/project-snapshot.js';
import type { AttemptManifest } from './attempt-workspace.js';
import {
  advanceAttemptReviewPair,
  readAttemptManifest,
} from './attempt-workspace.js';
import {
  decodeReviewClaimPayload,
  encodeReviewClaimPayload,
} from './codecs.js';
import {
  gitPublicationArgs,
  isolatedGitCommandOverlay,
  sanitizedGitHubCommandOverlay,
} from './credentials.js';
import { makeGitProtocolPort } from './git-protocol.js';
import { validateCanonicalGitHubHttpsRemote } from './implementation-executor.js';
import type { ReviewSessionPort } from './review-session.js';
import {
  gitOid,
  gitRefName,
  type GitOid,
} from './types.js';

export interface ProductionReviewSessionPortOptions {
  readonly runner?: CommandRunner;
  readonly environment?: NodeJS.ProcessEnv;
  readonly now?: () => Date;
  readonly readManifest?: (path: string) => AttemptManifest;
  readonly writeMetadataFile?: (payload: string) => string;
  readonly removeMetadataFile?: (path: string) => void;
}

export function makeProductionReviewSessionPort(
  options: ProductionReviewSessionPortOptions = {},
): ReviewSessionPort {
  const runner = options.runner ?? defaultRunner;
  const ambient = options.environment ?? process.env;
  const token = ambient.GH_TOKEN;
  if (token === undefined || token.length === 0) {
    throw new Error('Review session requires its selected GH_TOKEN');
  }
  const manifestPath = ambient.JINN_AUTOPILOT_SESSION_MANIFEST;
  const currentManifest = (): AttemptManifest => {
    if (manifestPath === undefined || manifestPath.length === 0) {
      throw new Error('Review session manifest path is unavailable');
    }
    return (options.readManifest ?? readAttemptManifest)(manifestPath);
  };
  const environmentFor = (
    manifest: AttemptManifest,
    extra: Record<string, string> = {},
  ): Record<string, string> => ({
    ...sanitizedGitHubCommandOverlay(ambient, { GH_TOKEN: token }),
    ...isolatedGitCommandOverlay(ambient, manifest.paths.askpass),
    GH_CONFIG_DIR: manifest.paths.ghConfigDir,
    ...extra,
  });
  const run = (
    manifest: AttemptManifest,
    command: string,
    args: string[],
    extra: Record<string, string> = {},
  ): Promise<string> => runner(command, args, {
    env: environmentFor(manifest, extra),
  });
  const runGit = (
    manifest: AttemptManifest,
    args: readonly string[],
    extra: Record<string, string> = {},
  ): Promise<string> => run(manifest, 'git', [
    ...gitPublicationArgs(manifest.paths.askpass, []),
    '-C', manifest.paths.worktree,
    ...args,
  ], extra);
  const secureGitRunner = (manifest: AttemptManifest) =>
    (_command: 'git', args: readonly string[]) => runGit(manifest, args);
  const validateIdentity = async (manifest: AttemptManifest): Promise<void> => {
    const login = (await run(manifest, 'gh', ['api', 'user', '--jq', '.login'])).trim();
    if (login.toLowerCase() !== manifest.selectedLogin.toLowerCase()) {
      throw new Error('Review session credential no longer matches the manifest identity');
    }
  };
  const validateRemote = async (manifest: AttemptManifest): Promise<void> => {
    const remote = (await runGit(manifest, [
      'remote', 'get-url', manifest.repository.remoteName,
    ])).trim();
    validateCanonicalGitHubHttpsRemote(remote);
  };
  const exactRemoteOid = (raw: string, ref: string): GitOid => {
    const lines = raw.trimEnd().split('\n').filter((line) => line.endsWith(`\t${ref}`));
    if (lines.length !== 1) throw new Error('Remote review ref readback is ambiguous');
    const [oid, observed, extra] = lines[0]!.split('\t');
    if (oid === undefined || observed !== ref || extra !== undefined) {
      throw new Error('Malformed remote review ref readback');
    }
    return gitOid(oid);
  };
  const parsePullRequest = (raw: string, manifest: AttemptManifest) => {
    let value: unknown;
    try {
      value = JSON.parse(raw) as unknown;
    } catch {
      throw new Error('Malformed review PR readback');
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new Error('Malformed review PR readback');
    }
    const record = value as Record<string, unknown>;
    if (
      typeof record.number !== 'number'
      || typeof record.headRefOid !== 'string'
      || typeof record.headRefName !== 'string'
      || typeof record.baseRefName !== 'string'
      || typeof record.isDraft !== 'boolean'
      || typeof record.body !== 'string'
      || typeof record.author !== 'object'
      || record.author === null
      || !Array.isArray(record.labels)
    ) {
      throw new Error('Malformed review PR readback');
    }
    const author = (record.author as { login?: unknown }).login;
    if (typeof author !== 'string') throw new Error('Malformed review PR author');
    const labels = record.labels.map((label) => {
      const name = typeof label === 'object' && label !== null
        ? (label as { name?: unknown }).name
        : undefined;
      if (typeof name !== 'string') throw new Error('Malformed review PR labels');
      return name;
    });
    return {
      number: record.number,
      issueNumber: manifest.issueNumber,
      head: gitOid(record.headRefOid),
      headRefName: record.headRefName,
      baseRefName: record.baseRefName,
      draft: record.isDraft,
      author,
      labels,
      body: record.body,
    };
  };
  const readPullRequest = async (
    manifest: AttemptManifest,
    prNumber: number,
  ) => parsePullRequest(await run(manifest, 'gh', [
    'pr', 'view', String(prNumber),
    '--repo', REPO,
    '--json', 'number,headRefName,baseRefName,headRefOid,isDraft,labels,body,author',
  ]), manifest);
  const requireHead = async (
    manifest: AttemptManifest,
    prNumber: number,
    expectedHead: GitOid,
  ) => {
    const pullRequest = await readPullRequest(manifest, prNumber);
    if (pullRequest.head !== expectedHead) throw new Error('Review PR head changed');
    return pullRequest;
  };
  const defaultWriteMetadata = (payload: string): string => {
    const path = join(
      currentManifest().paths.attemptDir,
      `.review-metadata-${process.pid}-${randomUUID()}.json`,
    );
    writeFileSync(path, `${payload}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    return path;
  };
  const writeMetadata = options.writeMetadataFile ?? defaultWriteMetadata;
  const removeMetadata = options.removeMetadataFile ?? ((path: string) => rmSync(path, {
    force: true,
  }));

  return {
    readManifest: options.readManifest ?? readAttemptManifest,

    async readAuthority(manifest) {
      await validateRemote(manifest);
      await validateIdentity(manifest);
      const ref = `refs/jinn-autopilot/review-claims/v1/${manifest.prNumber}`;
      const oid = exactRemoteOid(
        await runGit(manifest, [
          'ls-remote', manifest.repository.remoteName, ref,
        ]),
        ref,
      );
      await runGit(manifest, [
        'fetch', '--quiet', manifest.repository.remoteName, ref,
      ]);
      const payload = await runGit(manifest, [
        'show', `${oid}:jinn-autopilot-review.json`,
      ]);
      return { reviewRefOid: oid, record: decodeReviewClaimPayload(payload.trim()) };
    },

    async readPullRequest(prNumber, expectedHead) {
      return requireHead(currentManifest(), prNumber, expectedHead);
    },

    async readNativeReviews(prNumber, expectedHead) {
      const manifest = currentManifest();
      await requireHead(manifest, prNumber, expectedHead);
      const raw = await run(manifest, 'gh', [
        'api', `repos/${REPO}/pulls/${prNumber}/reviews`,
        '--paginate',
      ]);
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw) as unknown;
      } catch {
        throw new Error('Malformed native review readback');
      }
      if (!Array.isArray(parsed)) throw new Error('Malformed native review readback');
      return parsed.map((value) => {
        if (typeof value !== 'object' || value === null) {
          throw new Error('Malformed native review readback');
        }
        const review = value as Record<string, unknown>;
        const user = review.user as { login?: unknown } | undefined;
        if (
          typeof user?.login !== 'string'
          || typeof review.state !== 'string'
          || typeof review.commit_id !== 'string'
          || typeof review.body !== 'string'
          || typeof review.submitted_at !== 'string'
        ) {
          throw new Error('Malformed native review readback');
        }
        if (![
          'APPROVED',
          'CHANGES_REQUESTED',
          'COMMENTED',
          'DISMISSED',
          'PENDING',
        ].includes(review.state)) {
          throw new Error('Malformed native review state');
        }
        return {
          reviewer: user.login,
          state: review.state as 'APPROVED' | 'CHANGES_REQUESTED'
            | 'COMMENTED' | 'DISMISSED' | 'PENDING',
          commitId: gitOid(review.commit_id),
          body: review.body,
          submittedAt: review.submitted_at,
        };
      });
    },

    async hasHumanHold(issueNumber, prNumber, expectedHead) {
      const manifest = currentManifest();
      const pullRequest = await requireHead(manifest, prNumber, expectedHead);
      if (pullRequest.labels.includes('review:needs-human')) return true;
      const secureRunner: CommandRunner = (cmd, args) => run(manifest, cmd, args);
      const project = await fetchProjectSnapshot(secureRunner);
      const item = project.items.find((candidate) =>
        candidate.contentType === 'Issue' && candidate.number === issueNumber);
      return item?.status === 'Human' || item?.blockedOn === 'Human';
    },

    async createReviewRecord({ manifest, parent, record }) {
      const payloadPath = writeMetadata(encodeReviewClaimPayload(record));
      const indexPath = join(
        manifest.paths.attemptDir,
        `.review-index-${process.pid}-${randomUUID()}`,
      );
      try {
        const extra = { GIT_INDEX_FILE: indexPath };
        await runGit(manifest, ['read-tree', '--empty'], extra);
        const blob = gitOid((await runGit(manifest, [
          'hash-object', '-w', payloadPath,
        ], extra)).trim());
        await runGit(manifest, [
          'update-index', '--add',
          '--cacheinfo', `100644,${blob},jinn-autopilot-review.json`,
        ], extra);
        const tree = gitOid((await runGit(manifest, ['write-tree'], extra)).trim());
        return gitOid((await runGit(manifest, [
          'commit-tree', tree,
          '-p', parent,
          '-m', `Autopilot review metadata: ${record.state}`,
        ], extra)).trim());
      } finally {
        removeMetadata(payloadPath);
        rmSync(indexPath, { force: true });
      }
    },

    async publishReviewClaim({
      manifest,
      recordParent,
      expectedRemoteRecordOid,
      recordOid,
    }) {
      await validateRemote(manifest);
      await validateIdentity(manifest);
      const outcome = await makeGitProtocolPort(
        secureGitRunner(manifest),
        { remote: manifest.repository.remoteName },
      ).publishReviewClaim({
        prNumber: manifest.prNumber!,
        recordParent,
        expectedRemoteRecordOid,
        recordOid,
      });
      if (
        (outcome.status === 'won' || outcome.status === 'already-applied')
        && outcome.observed === recordOid
      ) {
        advanceAttemptReviewPair(
          manifest.paths.manifest,
          manifest.expectedHead,
          manifest.reviewRefOid!,
          manifest.expectedHead,
          recordOid,
          options.now,
        );
      }
      return outcome;
    },

    async submitNativeReview({ manifest, prNumber, commitId, reviewer, state, body }) {
      await validateIdentity(manifest);
      if (reviewer.toLowerCase() !== manifest.selectedLogin.toLowerCase()) {
        throw new Error('Native review reviewer differs from selected identity');
      }
      await requireHead(manifest, prNumber, commitId);
      await run(manifest, 'gh', [
        'api', '--method', 'POST',
        `repos/${REPO}/pulls/${prNumber}/reviews`,
        '-f', `commit_id=${commitId}`,
        '-f', `event=${state}`,
        '-f', `body=${body}`,
      ]);
    },

    async setPullRequestLabel(prNumber, expectedHead, label, present) {
      const manifest = currentManifest();
      const before = await requireHead(manifest, prNumber, expectedHead);
      if (before.labels.includes(label) === present) return;
      await run(manifest, 'gh', [
        'pr', 'edit', String(prNumber), '--repo', REPO,
        present ? '--add-label' : '--remove-label', label,
      ]);
      const after = await requireHead(manifest, prNumber, expectedHead);
      if (after.labels.includes(label) !== present) {
        throw new Error('Review label mutation was ambiguous');
      }
    },

    async setProjectStatus(issueNumber, expectedHead, status) {
      const manifest = currentManifest();
      await requireHead(manifest, manifest.prNumber!, expectedHead);
      const secureRunner: CommandRunner = (cmd, args) => run(manifest, cmd, args);
      const project = await fetchProjectSnapshot(secureRunner);
      const item = project.items.find((candidate) =>
        candidate.contentType === 'Issue' && candidate.number === issueNumber);
      if (item === undefined) throw new Error('Review issue is missing from Project');
      if (item.status === status) return;
      if (
        status === 'In Review'
        && (item.status === 'Human' || item.blockedOn === 'Human')
      ) {
        throw new Error('Review Project mutation stopped because Human is dominant');
      }
      const fields = await fetchFieldIds(secureRunner);
      await run(manifest, 'gh', [
        'project', 'item-edit',
        '--id', item.id,
        '--project-id', fields.projectId,
        '--field-id', fields.status.fieldId,
        '--single-select-option-id', fields.status.options[status],
      ]);
      await requireHead(manifest, manifest.prNumber!, expectedHead);
      const after = await fetchProjectSnapshot(secureRunner);
      const updated = after.items.find((candidate) =>
        candidate.contentType === 'Issue' && candidate.number === issueNumber);
      if (updated?.status !== status) {
        throw new Error('Review Project projection was ambiguous');
      }
    },

    async setPullRequestDraft(prNumber, expectedHead, draft) {
      const manifest = currentManifest();
      const before = await requireHead(manifest, prNumber, expectedHead);
      if (before.draft === draft) return;
      await run(manifest, 'gh', [
        'pr', 'ready', String(prNumber), '--repo', REPO,
        ...(draft ? ['--undo'] : []),
      ]);
      const after = await requireHead(manifest, prNumber, expectedHead);
      if (after.draft !== draft) throw new Error('Review draft mutation was ambiguous');
    },

    async readLocalFix(manifest) {
      const status = await runGit(manifest, ['status', '--porcelain=v1', '-z']);
      const head = gitOid((await runGit(manifest, [
        'rev-parse', '--verify', 'HEAD^{commit}',
      ])).trim());
      let parentMatches = true;
      try {
        await runGit(manifest, [
          'merge-base', '--is-ancestor', manifest.expectedHead, head,
        ]);
      } catch {
        parentMatches = false;
      }
      const [oldTree, newTree] = await Promise.all([
        runGit(manifest, ['rev-parse', '--verify', `${manifest.expectedHead}^{tree}`]),
        runGit(manifest, ['rev-parse', '--verify', `${head}^{tree}`]),
      ]);
      return {
        head,
        clean: status.length === 0,
        parentMatches,
        treeChanged: oldTree.trim() !== newTree.trim(),
      };
    },

    async publishReviewFix({
      manifest,
      expectedRemoteHead,
      newHead,
      expectedRemoteRecordOid,
      recordOid,
    }) {
      await validateRemote(manifest);
      await validateIdentity(manifest);
      return makeGitProtocolPort(
        secureGitRunner(manifest),
        { remote: manifest.repository.remoteName },
      ).publishReviewFix({
        branch: gitRefName(manifest.branch),
        newHeadParent: expectedRemoteHead,
        expectedRemoteHead,
        newHead,
        prNumber: manifest.prNumber!,
        recordParent: expectedRemoteRecordOid,
        expectedRemoteRecordOid,
        recordOid,
      });
    },

    advanceManifestPair: (path, oldHead, oldReview, newHead, newReview) =>
      advanceAttemptReviewPair(
        path,
        oldHead,
        oldReview,
        newHead,
        newReview,
        options.now,
      ),

    async hasHumanComment(prNumber, expectedHead, marker) {
      const manifest = currentManifest();
      await requireHead(manifest, prNumber, expectedHead);
      const bodies = await run(manifest, 'gh', [
        'api', `repos/${REPO}/issues/${prNumber}/comments`,
        '--paginate', '--jq', '.[].body',
      ]);
      return bodies.includes(marker);
    },

    async ensureHumanComment(prNumber, expectedHead, marker, body) {
      const manifest = currentManifest();
      await requireHead(manifest, prNumber, expectedHead);
      await run(manifest, 'gh', [
        'pr', 'comment', String(prNumber), '--repo', REPO, '--body', body,
      ]);
      await requireHead(manifest, prNumber, expectedHead);
      const bodies = await run(manifest, 'gh', [
        'api', `repos/${REPO}/issues/${prNumber}/comments`,
        '--paginate', '--jq', '.[].body',
      ]);
      if (!bodies.includes(marker)) throw new Error('Review Human comment was ambiguous');
    },

    nextMarker: randomUUID,
    now: options.now ?? (() => new Date()),
  };
}
