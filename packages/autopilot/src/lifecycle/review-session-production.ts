import { randomUUID } from 'node:crypto';
import {
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { CommandRunner } from '../dispatcher/issue-source.js';
import { defaultRunner } from '../dispatcher/issue-source.js';
import { REPO } from '../dispatcher/constants.js';
import {
  parseOwnedPrefixes,
  touchesCodeOwnedPath,
} from '../dispatcher/code-owned.js';
import { ensureFieldIds } from '../dispatcher/field-cache.js';
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
  readAttemptTokenFile,
  sanitizedGitHubCommandOverlay,
} from './credentials.js';
import { makeGitProtocolPort } from './git-protocol.js';
import { validateCanonicalGitHubHttpsRemote } from './implementation-executor.js';
import type { ReviewSessionPort } from './review-session.js';
import type { ReviewNativeReview } from './review-executor.js';
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
  const readManifest = options.readManifest ?? readAttemptManifest;
  const manifestPath = ambient.JINN_AUTOPILOT_SESSION_MANIFEST;
  const currentManifest = (): AttemptManifest => {
    if (manifestPath === undefined || manifestPath.length === 0) {
      throw new Error('Review session manifest path is unavailable');
    }
    return readManifest(manifestPath);
  };
  // Resolution order (#1883): ambient `GH_TOKEN` first, else the
  // attempt-scoped token file located through the (non-secret-shaped)
  // manifest path — see implementation-session-production.ts for the full
  // rationale. Only once neither resolves does this fail closed.
  const token = ((): string => {
    if (ambient.GH_TOKEN !== undefined && ambient.GH_TOKEN.length > 0) {
      return ambient.GH_TOKEN;
    }
    if (manifestPath !== undefined && manifestPath.length > 0) {
      try {
        const fromFile = readAttemptTokenFile(readManifest(manifestPath).paths.tokenFile);
        if (fromFile !== undefined) return fromFile;
      } catch {
        // Fall through to the closed failure below.
      }
    }
    throw new Error('Review session requires its selected GH_TOKEN');
  })();
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
  const parsePullRequest = (raw: string) => {
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
      || typeof record.state !== 'string'
      || typeof record.headRefOid !== 'string'
      || typeof record.headRefName !== 'string'
      || typeof record.baseRefName !== 'string'
      || typeof record.baseRefOid !== 'string'
      || typeof record.isDraft !== 'boolean'
      || typeof record.body !== 'string'
      || typeof record.author !== 'object'
      || record.author === null
      || !Array.isArray(record.labels)
      || !Array.isArray(record.closingIssues)
      || !Array.isArray(record.files)
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
    const closingIssueNumbers = record.closingIssues.map((issue) => {
      const number = typeof issue === 'object' && issue !== null
        ? (issue as { number?: unknown }).number
        : undefined;
      if (typeof number !== 'number' || !Number.isSafeInteger(number) || number <= 0) {
        throw new Error('Malformed review PR closing issues');
      }
      return number;
    });
    const files = record.files.map((file) => {
      const path = typeof file === 'object' && file !== null
        ? (file as { path?: unknown }).path
        : undefined;
      if (typeof path !== 'string' || path.length === 0) {
        throw new Error('Malformed review PR files');
      }
      return path;
    });
    if (!['OPEN', 'CLOSED', 'MERGED'].includes(record.state)) {
      throw new Error('Malformed review PR state');
    }
    return {
      number: record.number,
      head: gitOid(record.headRefOid),
      base: gitOid(record.baseRefOid),
      headRefName: record.headRefName,
      baseRefName: record.baseRefName,
      open: record.state === 'OPEN',
      draft: record.isDraft,
      author,
      labels,
      body: record.body,
      closingIssueNumbers,
      files,
    };
  };
  const parseOpenPullRequests = (raw: string): Array<{
    readonly number: number;
    readonly head: GitOid;
    readonly branch: string;
    readonly closingIssueNumbers: readonly number[];
  }> => {
    let value: unknown;
    try {
      value = JSON.parse(raw) as unknown;
    } catch {
      throw new Error('Malformed open review PR mapping readback');
    }
    if (!Array.isArray(value)) throw new Error('Malformed open review PR mapping readback');
    return value.map((entry) => {
      if (typeof entry !== 'object' || entry === null) {
        throw new Error('Malformed open review PR mapping readback');
      }
      const record = entry as Record<string, unknown>;
      if (
        typeof record.number !== 'number'
        || typeof record.headRefOid !== 'string'
        || typeof record.headRefName !== 'string'
        || !Array.isArray(record.closingIssues)
      ) {
        throw new Error('Malformed open review PR mapping readback');
      }
      const closingIssueNumbers = record.closingIssues.map((issue) => {
        const number = typeof issue === 'object' && issue !== null
          ? (issue as { number?: unknown }).number
          : undefined;
        if (typeof number !== 'number' || !Number.isSafeInteger(number) || number <= 0) {
          throw new Error('Malformed open review PR mapping readback');
        }
        return number;
      });
      return {
        number: record.number,
        head: gitOid(record.headRefOid),
        branch: record.headRefName,
        closingIssueNumbers,
      };
    });
  };
  const readPullRequest = async (
    manifest: AttemptManifest,
    prNumber: number,
  ) => {
    const pullRequest = parsePullRequest(await run(manifest, 'gh', [
      'pr', 'view', String(prNumber),
      '--repo', REPO,
      '--json',
      'number,state,headRefName,baseRefName,headRefOid,baseRefOid,isDraft,labels,body,author,closingIssues,files',
    ]));
    const markerMatches = [...pullRequest.body.matchAll(
      /<!-- jinn-autopilot:v2 issue=([1-9][0-9]*) branch=([^ >]+) -->/g,
    )];
    const markerIssue = markerMatches.length === 1
      ? Number(markerMatches[0]![1])
      : undefined;
    const markerBranch = markerMatches.length === 1
      ? markerMatches[0]![2]
      : undefined;
    const issueNumber = markerIssue
      ?? (pullRequest.closingIssueNumbers.length === 1
        ? pullRequest.closingIssueNumbers[0]!
        : manifest.issueNumber);
    const openPullRequests = parseOpenPullRequests(await run(manifest, 'gh', [
      'pr', 'list', '--repo', REPO, '--state', 'open', '--limit', '1000',
      '--json', 'number,headRefName,headRefOid,closingIssues',
    ]));
    const linked = openPullRequests.filter((candidate) => (
      candidate.branch === pullRequest.headRefName
      || candidate.closingIssueNumbers.includes(issueNumber)
    ));
    const mappingProblem = (
      markerMatches.length !== 1
      || markerIssue !== issueNumber
      || markerBranch !== pullRequest.headRefName
      || pullRequest.closingIssueNumbers.length !== 1
      || pullRequest.closingIssueNumbers[0] !== issueNumber
      || linked.length !== 1
      || linked[0]?.number !== pullRequest.number
      || linked[0]?.head !== pullRequest.head
    )
      ? 'The current PR does not have a unique open PR, issue, and branch mapping.'
      : undefined;
    const treePaths = (await runGit(manifest, [
      'ls-tree', '-r', '--name-only', pullRequest.base,
    ])).trim().split('\n').filter(Boolean);
    const codeownersPath = [
      '.github/CODEOWNERS',
      'CODEOWNERS',
      'docs/CODEOWNERS',
    ].find((path) => treePaths.includes(path));
    const codeownersText = codeownersPath === undefined
      ? ''
      : await runGit(manifest, ['show', `${pullRequest.base}:${codeownersPath}`]);
    const approvalPolicy = touchesCodeOwnedPath(
      [...pullRequest.files],
      parseOwnedPrefixes(codeownersText),
    )
      ? 'human-codeowner' as const
      : 'approve-eligible' as const;
    return {
      number: pullRequest.number,
      issueNumber,
      open: pullRequest.open,
      head: pullRequest.head,
      headRefName: pullRequest.headRefName,
      baseRefName: pullRequest.baseRefName,
      draft: pullRequest.draft,
      author: pullRequest.author,
      labels: pullRequest.labels,
      body: pullRequest.body,
      approvalPolicy,
      ...(mappingProblem === undefined ? {} : { mappingProblem }),
    };
  };
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
  const readCommentBodies = async (
    manifest: AttemptManifest,
    prNumber: number,
  ): Promise<readonly string[]> => {
    const raw = await run(manifest, 'gh', [
      'api', `repos/${REPO}/issues/${prNumber}/comments`,
      '--paginate', '--slurp',
    ]);
    let value: unknown;
    try {
      value = JSON.parse(raw) as unknown;
    } catch {
      throw new Error('Malformed review Human comment readback');
    }
    if (!Array.isArray(value)) throw new Error('Malformed review Human comment readback');
    const comments = value.every((entry) => Array.isArray(entry))
      ? value.flat()
      : value;
    return comments.map((comment) => {
      const body = typeof comment === 'object' && comment !== null
        ? (comment as { body?: unknown }).body
        : undefined;
      if (typeof body !== 'string') {
        throw new Error('Malformed review Human comment readback');
      }
      return body;
    });
  };
  const readAuthority = async (manifest: AttemptManifest) => {
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
  };
  const readNativeReviews = async (
    manifest: AttemptManifest,
    prNumber: number,
    expectedHead: GitOid,
  ): Promise<readonly ReviewNativeReview[]> => {
    await requireHead(manifest, prNumber, expectedHead);
    const raw = await run(manifest, 'gh', [
      'api', `repos/${REPO}/pulls/${prNumber}/reviews`,
      '--paginate', '--slurp',
    ]);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      throw new Error('Malformed native review readback');
    }
    if (
      !Array.isArray(parsed)
      || !parsed.every((page) => Array.isArray(page))
    ) {
      throw new Error('Malformed native review readback');
    }
    return parsed.flat().map((value) => {
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
  };
  const effectiveNativeBlocker = (
    reviews: readonly ReviewNativeReview[],
  ): ReviewNativeReview | undefined => {
    const latest = new Map<string, ReviewNativeReview>();
    for (const review of [...reviews].sort((left, right) =>
      left.submittedAt.localeCompare(right.submittedAt))) {
      if (
        !['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(review.state)
      ) {
        continue;
      }
      latest.set(review.reviewer.toLowerCase(), review);
    }
    return [...latest.values()].find(
      (review) => review.state === 'CHANGES_REQUESTED',
    );
  };
  const requireReadyBoundary = async (
    manifest: AttemptManifest,
    prNumber: number,
    expectedHead: GitOid,
  ): Promise<void> => {
    const authority = await readAuthority(manifest);
    const record = authority.record;
    if (
      authority.reviewRefOid !== manifest.reviewRefOid
      || record.state !== 'terminal-approved'
      || record.prNumber !== prNumber
      || record.generation !== manifest.reviewGeneration
      || record.attempt !== manifest.attemptId
      || record.reviewer.toLowerCase() !== manifest.selectedLogin.toLowerCase()
      || record.head !== expectedHead
    ) {
      throw new Error('Review ready boundary lost exact terminal authority');
    }
    const pullRequest = await requireHead(manifest, prNumber, expectedHead);
    if (pullRequest.labels.includes('review:needs-human')) {
      throw new Error('Review ready boundary stopped because Human is dominant');
    }
    const secureRunner: CommandRunner = (cmd, args) => run(manifest, cmd, args);
    const project = await fetchProjectSnapshot(secureRunner);
    const item = project.items.find((candidate) =>
      candidate.contentType === 'Issue'
      && candidate.number === manifest.issueNumber);
    if (item?.status === 'Human' || item?.blockedOn === 'Human') {
      throw new Error('Review ready boundary stopped because Human is dominant');
    }
    const blocker = effectiveNativeBlocker(
      await readNativeReviews(manifest, prNumber, expectedHead),
    );
    if (blocker !== undefined) {
      throw new Error(
        `Native requested changes by ${blocker.reviewer} block automated approval`,
      );
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

  return {
    readManifest: options.readManifest ?? readAttemptManifest,

    readAuthority,

    async readPullRequest(prNumber, expectedHead) {
      return requireHead(currentManifest(), prNumber, expectedHead);
    },

    async readNativeReviews(prNumber, expectedHead) {
      return readNativeReviews(currentManifest(), prNumber, expectedHead);
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
      await mutateWithExactReadback(
        () => run(manifest, 'gh', [
          'pr', 'edit', String(prNumber), '--repo', REPO,
          present ? '--add-label' : '--remove-label', label,
        ]),
        async () => (
          await requireHead(manifest, prNumber, expectedHead)
        ).labels.includes(label) === present,
        'Review label mutation was ambiguous',
      );
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
      const fields = await ensureFieldIds(secureRunner);
      await mutateWithExactReadback(
        () => run(manifest, 'gh', [
          'project', 'item-edit',
          '--id', item.id,
          '--project-id', fields.projectId,
          '--field-id', fields.status.fieldId,
          '--single-select-option-id', fields.status.options[status],
        ]),
        async () => {
          await requireHead(manifest, manifest.prNumber!, expectedHead);
          const after = await fetchProjectSnapshot(secureRunner);
          return after.items.find((candidate) =>
            candidate.contentType === 'Issue' && candidate.number === issueNumber
          )?.status === status;
        },
        'Review Project projection was ambiguous',
      );
    },

    async setPullRequestDraft(prNumber, expectedHead, draft) {
      const manifest = currentManifest();
      const before = await requireHead(manifest, prNumber, expectedHead);
      if (before.draft === draft) return;
      if (!draft) {
        await requireReadyBoundary(manifest, prNumber, expectedHead);
      }
      await mutateWithExactReadback(
        () => run(manifest, 'gh', [
          'pr', 'ready', String(prNumber), '--repo', REPO,
          ...(draft ? ['--undo'] : []),
        ]),
        async () => (
          await requireHead(manifest, prNumber, expectedHead)
        ).draft === draft,
        'Review draft mutation was ambiguous',
      );
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

    async hasHumanComment(prNumber, expectedHead, body) {
      const manifest = currentManifest();
      await requireHead(manifest, prNumber, expectedHead);
      return (await readCommentBodies(manifest, prNumber)).includes(body);
    },

    async ensureHumanComment(prNumber, expectedHead, marker, body) {
      const manifest = currentManifest();
      if (!body.includes(marker)) {
        throw new Error('Review Human comment body is missing its exact marker');
      }
      await requireHead(manifest, prNumber, expectedHead);
      await mutateWithExactReadback(
        () => run(manifest, 'gh', [
          'pr', 'comment', String(prNumber), '--repo', REPO, '--body', body,
        ]),
        async () => {
          await requireHead(manifest, prNumber, expectedHead);
          return (await readCommentBodies(manifest, prNumber)).includes(body);
        },
        'Review Human comment was ambiguous',
      );
    },

    nextMarker: randomUUID,
    now: options.now ?? (() => new Date()),
  };
}
