import { randomUUID } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  unlink,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import type { PolledIssue } from '../dispatcher/types.js';
import type { ProjectSnapshot } from '../dispatcher/project-snapshot.js';
import type { PullRequestIndexEntry } from './github-rest-discovery.js';
import {
  isConfinedRestEndpoint,
  type PersistedConditionalRestCacheEntry,
} from './github-rest.js';
import type {
  BranchClaimSnapshot,
  PullRequestSnapshot,
  SnapshotReadMode,
} from './snapshot.js';
import type { GitHubUsage } from './github-usage.js';

export const DEFAULT_AUTOPILOT_STATE_DIRECTORY = join(
  homedir(),
  '.jinn-client',
  'autopilot',
  'state',
  'v2',
);
export const LIFECYCLE_CACHE_FILE = 'lifecycle-cache.json';

export interface LifecycleSnapshotEvidence {
  readonly project: ProjectSnapshot;
  readonly issues: readonly PolledIssue[];
  readonly pullRequests: readonly PullRequestSnapshot[];
  readonly branches: readonly BranchClaimSnapshot[];
  readonly capturedAt: string;
  readonly snapshotMode: SnapshotReadMode;
  readonly lastFullReconciliationAt: string;
  readonly githubUsage: GitHubUsage;
}

export interface LifecycleDiscoveryState {
  readonly version: 1;
  readonly evidence: LifecycleSnapshotEvidence;
  /** Exact evidence retained for lifecycle-relevant or previously hydrated open PRs. */
  readonly openPullRequestEvidence: readonly PullRequestSnapshot[];
  /** Complete open REST index; null is accepted only for a legacy full-oracle seed. */
  readonly openPullRequests: readonly PullRequestIndexEntry[] | null;
  /** Last complete recently-closed index, used to avoid repeated classifications. */
  readonly recentlyClosedPullRequests: readonly PullRequestIndexEntry[];
  /** Fixed overlap boundary selected by the last full oracle and reused until the next one. */
  readonly recentlyClosedCutoff: string;
  readonly restCache: readonly PersistedConditionalRestCacheEntry[];
}

export interface LifecycleDiscoveryCacheStoreOptions {
  readonly stateDirectory?: string;
}

export interface LifecycleDiscoveryStateStore {
  load(): Promise<LifecycleDiscoveryState | null>;
  save(state: LifecycleDiscoveryState): Promise<void>;
  quarantineCorrupt?(): Promise<void>;
}

export class LifecycleDiscoveryCacheCorruptError extends Error {
  constructor(detail: string) {
    super(`Autopilot lifecycle discovery cache is corrupt: ${detail}`);
    this.name = 'LifecycleDiscoveryCacheCorruptError';
  }
}

export class LifecycleDiscoveryCacheUnsafePathError
  extends LifecycleDiscoveryCacheCorruptError {
  constructor(detail: string) {
    super(`unsafe cache path: ${detail}`);
    this.name = 'LifecycleDiscoveryCacheUnsafePathError';
  }
}

const exactTimestamp = z.string().superRefine((value, context) => {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{3}))?Z$/
    .exec(value);
  if (match === null) {
    context.addIssue({ code: 'custom', message: 'must be an exact UTC timestamp' });
    return;
  }
  const parts = match.slice(1).map((part) => Number(part ?? '0'));
  const parsed = new Date(Date.parse(value));
  if (
    !Number.isFinite(parsed.getTime())
    || parsed.getUTCFullYear() !== parts[0]
    || parsed.getUTCMonth() + 1 !== parts[1]
    || parsed.getUTCDate() !== parts[2]
    || parsed.getUTCHours() !== parts[3]
    || parsed.getUTCMinutes() !== parts[4]
    || parsed.getUTCSeconds() !== parts[5]
    || parsed.getUTCMilliseconds() !== parts[6]
  ) {
    context.addIssue({ code: 'custom', message: 'contains an impossible calendar value' });
  }
});
const oid = z.string().regex(/^[0-9a-f]{40}$/);
const positiveInteger = z.number().int().positive().safe();
const nonNegativeInteger = z.number().int().nonnegative().safe();
const nullableString = z.string().nullable();
const status = z.enum(['Todo', 'In Progress', 'Human', 'In Review', 'Done']).nullable();
const priority = z.enum(['P0', 'P1', 'P2', 'P3', 'P4']).nullable();
const effort = z.enum(['Low', 'Medium', 'High', 'XHigh', 'Max']).nullable();
const blockedOn = z.enum(['Nothing', 'Human', 'Another issue']).nullable();
const issueShape = z.enum([
  'feat', 'fix', 'refactor', 'spike', 'chore', 'docs', 'test', 'incident', 'design',
]).nullable();

const projectItemSchema = z.object({
  id: z.string().min(1),
  number: z.number().int().safe(),
  contentType: z.enum(['Issue', 'PullRequest', 'DraftIssue']),
  status,
  priority,
  effort,
  blockedOn,
  issueType: issueShape,
  blockedByIssues: z.array(positiveInteger),
  sprintIterationId: nullableString,
}).strict();
const rateLimitSchema = z.object({
  remaining: nonNegativeInteger,
  used: nonNegativeInteger,
  resetAt: exactTimestamp,
}).strict();
const projectSchema = z.object({
  items: z.array(projectItemSchema),
  rateLimit: rateLimitSchema,
  currentSprintIterationId: nullableString,
}).strict();

const issueSchema = z.object({
  number: positiveInteger,
  title: z.string(),
  labels: z.array(z.string()).optional(),
  /** Issue body; used for child-marker admission (Stage 2, single-surface). */
  body: z.string().optional(),
  shape: issueShape,
  blockedOn,
  blockedByIssues: z.array(positiveInteger),
  effort,
  priority,
  status,
  onBoard: z.boolean(),
  author: z.string(),
  projectItemId: nullableString,
  inCurrentSprint: z.boolean(),
}).strict();

const humanReasonSchema = z.union([
  z.object({
    phase: z.enum(['eligible', 'implementing']),
    code: z.enum([
      'first-push',
      'implementation-escalation',
      'branch-mapping-ambiguous',
      'invalid-branch-progress-time',
    ]),
    detail: z.string(),
  }).strict(),
  z.object({
    phase: z.enum(['awaiting-review', 'reviewing', 'review-fixing']),
    code: z.enum([
      'review-escalation',
      'reviewer-identity-unavailable',
      'invalid-review-progress-time',
    ]),
    detail: z.string(),
  }).strict(),
  z.object({
    phase: z.enum(['merge-prep', 'merge-ready']),
    code: z.enum([
      'semantic-conflict',
      'codeowner-sensitive-conflict',
      'invalid-merge-progress-time',
    ]),
    detail: z.string(),
  }).strict(),
]);

const branchClaimBase = {
  kind: z.literal('branch-claim'),
  protocolVersion: z.literal(2),
  issueNumber: positiveInteger,
  attempt: z.string().min(1),
  runner: z.string().min(1),
  login: z.string().min(1),
  expectedHead: oid,
  targetBase: z.string().min(1),
  claimedAt: exactTimestamp,
  phaseComplete: z.literal(true).optional(),
} as const;
const branchClaimSchema = z.union([
  z.object({
    ...branchClaimBase,
    phase: z.literal('implement'),
    prNumber: positiveInteger.optional(),
  }).strict(),
  z.object({
    ...branchClaimBase,
    phase: z.literal('merge-prep'),
    prNumber: positiveInteger,
    targetBaseOid: oid.optional(),
  }).strict(),
]);

const verdictSchema = z.object({
  marker: z.string().min(1),
  state: z.enum(['APPROVE', 'REQUEST_CHANGES']),
}).strict();
const approvedVerdictSchema = z.object({
  marker: z.string().min(1),
  state: z.literal('APPROVE'),
}).strict();
const reviewClaimBase = {
  kind: z.literal('review-claim'),
  protocolVersion: z.literal(2),
  prNumber: positiveInteger,
  generation: z.string().min(1),
  attempt: z.string().min(1),
  reviewer: z.string(),
  head: oid,
  recordedAt: exactTimestamp,
} as const;
const reviewClaimSchema = z.union([
  z.object({
    ...reviewClaimBase,
    state: z.enum(['active', 'fixing', 'human', 'stale']),
  }).strict(),
  z.object({
    ...reviewClaimBase,
    state: z.literal('verdict-intent'),
    verdict: verdictSchema,
  }).strict(),
  z.object({
    ...reviewClaimBase,
    state: z.literal('terminal-approved'),
    verdict: approvedVerdictSchema,
  }).strict(),
]);

const pullRequestSchema = z.object({
  number: positiveInteger,
  title: z.string(),
  body: z.string(),
  author: z.string(),
  baseRefName: z.string().min(1),
  headRefName: z.string().min(1),
  headOid: oid,
  headCommittedAt: exactTimestamp,
  isDraft: z.boolean(),
  state: z.enum(['OPEN', 'MERGED']),
  labels: z.array(z.string()),
  closingIssueNumbers: z.array(positiveInteger),
  mergeability: z.enum(['MERGEABLE', 'CONFLICTING', 'UNKNOWN']),
  mergeStateStatus: z.string(),
  checks: z.array(z.object({
    name: z.string(),
    status: z.string(),
    conclusion: z.string().nullable(),
  }).strict()),
  reviews: z.array(z.object({
    reviewer: z.string(),
    state: z.enum(['APPROVED', 'CHANGES_REQUESTED', 'COMMENTED', 'DISMISSED', 'PENDING']),
    commitId: oid,
    body: z.string(),
    submittedAt: exactTimestamp,
  }).strict()),
  branchClaim: branchClaimSchema.optional(),
  implementationCompletionSummary: z.string().optional(),
  reviewClaim: z.object({ oid, record: reviewClaimSchema }).strict().optional(),
  humanIssueNumber: positiveInteger.optional(),
  humanReason: humanReasonSchema.optional(),
  mergedAt: exactTimestamp.optional(),
  mergeCommitOid: oid.optional(),
}).strict();

const branchSchema = z.object({
  issueNumber: positiveInteger,
  headRefName: z.string().min(1),
  headOid: oid,
  headCommittedAt: exactTimestamp,
  claim: branchClaimSchema,
  implementationCompletionSummary: z.string().optional(),
}).strict();

const usageSchema = z.object({
  graphqlRequests: nonNegativeInteger,
  graphqlCost: nonNegativeInteger,
  graphqlRemaining: nonNegativeInteger.nullable(),
  graphqlResetAt: exactTimestamp.nullable(),
  restRequests: nonNegativeInteger,
  restNotModified: nonNegativeInteger,
  cacheHits: nonNegativeInteger,
  // Accounting completeness is observability, not a correctness gate: GitHub's
  // used/remaining counters are eventually consistent under concurrency. Legacy
  // caches predate the flag and are read as complete.
  accountingComplete: z.boolean().default(true),
  incompleteReason: z.string().optional(),
}).strict();

const evidenceSchema = z.object({
  project: projectSchema,
  issues: z.array(issueSchema),
  pullRequests: z.array(pullRequestSchema),
  branches: z.array(branchSchema),
  capturedAt: exactTimestamp,
  snapshotMode: z.enum(['incremental', 'full']),
  lastFullReconciliationAt: exactTimestamp,
  githubUsage: usageSchema,
}).strict();

const pullRequestIndexSchema = z.object({
  number: positiveInteger,
  title: z.string(),
  state: z.enum(['OPEN', 'CLOSED']),
  updatedAt: exactTimestamp,
  headOid: oid,
  headRefName: z.string().min(1),
  baseRefName: z.string().min(1),
  isDraft: z.boolean(),
  closedAt: exactTimestamp.nullable(),
  mergedAt: exactTimestamp.nullable(),
}).strict();

const confinedRestEndpoint = z.string().superRefine((endpoint, context) => {
  if (!isConfinedRestEndpoint(endpoint)) {
    context.addIssue({
      code: 'custom',
      message: 'must be a safe relative GitHub API endpoint',
    });
  }
});

const restCacheSchema = z.object({
  endpoint: confinedRestEndpoint,
  etag: z.string().regex(/^(?:W\/)?"[^\r\n]*"$/),
  body: z.string().superRefine((value, context) => {
    try {
      JSON.parse(value);
    } catch {
      context.addIssue({ code: 'custom', message: 'must contain JSON' });
    }
  }),
  nextEndpoint: confinedRestEndpoint.nullable(),
}).strict();

const stateSchema = z.object({
  version: z.literal(1),
  evidence: evidenceSchema,
  openPullRequestEvidence: z.array(pullRequestSchema),
  openPullRequests: z.array(pullRequestIndexSchema).nullable(),
  recentlyClosedPullRequests: z.array(pullRequestIndexSchema),
  recentlyClosedCutoff: exactTimestamp,
  restCache: z.array(restCacheSchema),
}).strict().superRefine((state, context) => {
  const issue = (path: PropertyKey[], message: string): void => {
    context.addIssue({ code: 'custom', path, message });
  };
  const unique = <Value>(
    values: readonly Value[],
    identity: (value: Value) => string,
    path: PropertyKey[],
    subject: string,
  ): void => {
    const seen = new Set<string>();
    for (const value of values) {
      const key = identity(value);
      if (seen.has(key)) issue(path, `${subject} identity '${key}' is duplicated`);
      seen.add(key);
    }
  };
  const capturedMs = Date.parse(state.evidence.capturedAt);
  const lastFullMs = Date.parse(state.evidence.lastFullReconciliationAt);
  if (Date.parse(state.recentlyClosedCutoff) > Date.parse(state.evidence.capturedAt)) {
    issue(['recentlyClosedCutoff'], 'cannot be after the evidence capture time');
  }
  if (lastFullMs > capturedMs) {
    issue(
      ['evidence', 'lastFullReconciliationAt'],
      'cannot be after the evidence capture time',
    );
  }
  if (Date.parse(state.recentlyClosedCutoff) > lastFullMs) {
    issue(['recentlyClosedCutoff'], 'cannot be after the last full reconciliation');
  }
  if (
    state.evidence.snapshotMode === 'full'
    && state.evidence.capturedAt !== state.evidence.lastFullReconciliationAt
  ) {
    issue(['evidence'], 'full evidence capture must equal its full reconciliation time');
  }
  if (
    state.evidence.githubUsage.graphqlRemaining === null
    || state.evidence.githubUsage.graphqlResetAt === null
    || (
      state.evidence.snapshotMode === 'full'
      && state.evidence.githubUsage.graphqlRequests < 1
    )
    || (
      state.evidence.githubUsage.graphqlRequests === 0
      && (
        state.evidence.githubUsage.graphqlCost !== 0
        || state.evidence.githubUsage.restRequests < 1
      )
    )
  ) {
    issue(
      ['evidence', 'githubUsage'],
      'complete evidence requires live GraphQL quota authority',
    );
  }
  unique(
    state.evidence.project.items,
    (item) => item.id,
    ['evidence', 'project', 'items'],
    'Project item',
  );
  unique(
    state.evidence.project.items.filter((item) => item.contentType !== 'DraftIssue'),
    (item) => `${item.contentType}:${item.number}`,
    ['evidence', 'project', 'items'],
    'Project content',
  );
  unique(
    state.evidence.issues,
    (entry) => String(entry.number),
    ['evidence', 'issues'],
    'issue',
  );
  unique(
    state.evidence.pullRequests,
    (pr) => String(pr.number),
    ['evidence', 'pullRequests'],
    'PR',
  );
  unique(
    state.openPullRequestEvidence,
    (pr) => String(pr.number),
    ['openPullRequestEvidence'],
    'open PR evidence',
  );
  unique(
    state.evidence.branches,
    (branch) => String(branch.issueNumber),
    ['evidence', 'branches'],
    'branch issue',
  );
  unique(
    state.evidence.branches,
    (branch) => branch.headRefName,
    ['evidence', 'branches'],
    'branch ref',
  );
  unique(
    state.openPullRequests ?? [],
    (pr) => String(pr.number),
    ['openPullRequests'],
    'open PR index',
  );
  unique(
    state.recentlyClosedPullRequests,
    (pr) => String(pr.number),
    ['recentlyClosedPullRequests'],
    'closed PR index',
  );
  unique(
    state.restCache,
    (entry) => entry.endpoint,
    ['restCache'],
    'REST cache endpoint',
  );
  const openEvidence = new Map(
    state.openPullRequestEvidence.map((pr) => [pr.number, pr]),
  );
  const openIndex = new Map((state.openPullRequests ?? []).map((pr) => [pr.number, pr]));
  if (state.evidence.snapshotMode === 'incremental' && state.openPullRequests === null) {
    issue(['openPullRequests'], 'incremental evidence requires a complete open PR index');
  }
  for (const pr of state.openPullRequests ?? []) {
    if (pr.state !== 'OPEN' || pr.closedAt !== null || pr.mergedAt !== null) {
      issue(['openPullRequests'], `PR #${pr.number} is not a coherent OPEN index row`);
    }
  }
  for (const pr of state.recentlyClosedPullRequests) {
    const closedMs = pr.closedAt === null ? Number.NaN : Date.parse(pr.closedAt);
    if (pr.state !== 'CLOSED' || pr.closedAt === null) {
      issue(
        ['recentlyClosedPullRequests'],
        `PR #${pr.number} is not a coherent CLOSED index row`,
      );
    }
    if (pr.mergedAt !== null && Date.parse(pr.mergedAt) > closedMs) {
      issue(['recentlyClosedPullRequests'], `PR #${pr.number} merged after it closed`);
    }
    if (Number.isFinite(closedMs) && Date.parse(pr.updatedAt) < closedMs) {
      issue(['recentlyClosedPullRequests'], `PR #${pr.number} updated before it closed`);
    }
    if (openIndex.has(pr.number)) {
      issue(['recentlyClosedPullRequests'], `PR #${pr.number} is also in the open index`);
    }
  }
  for (const pr of state.openPullRequestEvidence) {
    if (pr.state !== 'OPEN' || pr.mergedAt !== undefined || pr.mergeCommitOid !== undefined) {
      issue(['openPullRequestEvidence'], `PR #${pr.number} is not coherent OPEN evidence`);
    }
    if (state.openPullRequests !== null && !openIndex.has(pr.number)) {
      issue(['openPullRequestEvidence'], `PR #${pr.number} is absent from the open index`);
    }
  }
  for (const pr of state.evidence.pullRequests) {
    if (pr.state === 'OPEN') {
      if (pr.mergedAt !== undefined || pr.mergeCommitOid !== undefined) {
        issue(['evidence', 'pullRequests'], `OPEN PR #${pr.number} has merge evidence`);
      }
      const exact = openEvidence.get(pr.number);
      if (exact === undefined || JSON.stringify(exact) !== JSON.stringify(pr)) {
        issue(
          ['evidence', 'pullRequests'],
          `OPEN PR #${pr.number} is not backed by exact open evidence`,
        );
      }
    } else if (pr.mergedAt === undefined) {
      issue(['evidence', 'pullRequests'], `MERGED PR #${pr.number} has no mergedAt`);
    }
  }
  for (const branch of state.evidence.branches) {
    if (branch.claim.issueNumber !== branch.issueNumber) {
      issue(['evidence', 'branches'], `branch ${branch.headRefName} issue is contradictory`);
    }
  }
});

export class LifecycleDiscoveryCacheStore implements LifecycleDiscoveryStateStore {
  readonly stateDirectory: string;
  readonly cachePath: string;

  constructor(options: LifecycleDiscoveryCacheStoreOptions = {}) {
    this.stateDirectory = options.stateDirectory ?? DEFAULT_AUTOPILOT_STATE_DIRECTORY;
    if (this.stateDirectory.length === 0) throw new Error('Autopilot state directory is empty');
    this.cachePath = join(this.stateDirectory, LIFECYCLE_CACHE_FILE);
  }

  private async assertSafeDirectory(
    expected?: { readonly device: number; readonly inode: number },
  ): Promise<{ readonly device: number; readonly inode: number }> {
    const directory = await lstat(this.stateDirectory);
    if (!directory.isDirectory() || directory.isSymbolicLink()) {
      throw new LifecycleDiscoveryCacheUnsafePathError(
        'state directory is not a real non-symlink directory',
      );
    }
    const currentUid = typeof process.getuid === 'function' ? process.getuid() : undefined;
    if (currentUid !== undefined && directory.uid !== currentUid) {
      throw new LifecycleDiscoveryCacheUnsafePathError(
        'cache directory is not owned by the current runner user',
      );
    }
    if ((directory.mode & 0o777) !== 0o700) {
      throw new LifecycleDiscoveryCacheUnsafePathError(
        'cache directory permissions are not owner-only (expected 0700)',
      );
    }
    const identity = { device: directory.dev, inode: directory.ino };
    if (
      expected !== undefined
      && (identity.device !== expected.device || identity.inode !== expected.inode)
    ) {
      throw new LifecycleDiscoveryCacheUnsafePathError(
        'cache directory identity changed during the operation',
      );
    }
    return identity;
  }

  private async ensureSafeDirectory(): Promise<{
    readonly device: number;
    readonly inode: number;
  }> {
    try {
      return await this.assertSafeDirectory();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }

    // Create only the parent tree recursively. The final directory is an
    // atomic, owner-only mkdir so an existing path is never chmodded as a
    // side effect of selecting it as an Autopilot cache location.
    await mkdir(dirname(this.stateDirectory), { recursive: true, mode: 0o700 });
    try {
      await mkdir(this.stateDirectory, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    return this.assertSafeDirectory();
  }

  private async syncDirectory(
    expected: { readonly device: number; readonly inode: number },
  ): Promise<void> {
    const directory = await open(this.stateDirectory, 'r');
    try {
      const actual = await directory.stat();
      if (actual.dev !== expected.device || actual.ino !== expected.inode) {
        throw new LifecycleDiscoveryCacheUnsafePathError(
          'cache directory identity changed before synchronization',
        );
      }
      await directory.sync();
    } finally {
      await directory.close();
    }
  }

  async load(): Promise<LifecycleDiscoveryState | null> {
    try {
      await this.assertSafeDirectory();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    let file;
    try {
      file = await lstat(this.cachePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    if (!file.isFile() || file.isSymbolicLink()) {
      throw new LifecycleDiscoveryCacheUnsafePathError('cache path is not a regular file');
    }
    if ((file.mode & 0o077) !== 0) {
      throw new LifecycleDiscoveryCacheUnsafePathError(
        'cache file permissions are not owner-only',
      );
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(await readFile(this.cachePath, 'utf8')) as unknown;
    } catch (error) {
      throw new LifecycleDiscoveryCacheCorruptError(
        error instanceof Error ? error.message : String(error),
      );
    }
    const parsed = stateSchema.safeParse(decoded);
    if (!parsed.success) {
      throw new LifecycleDiscoveryCacheCorruptError(z.prettifyError(parsed.error));
    }
    return parsed.data as unknown as LifecycleDiscoveryState;
  }

  async save(state: LifecycleDiscoveryState): Promise<void> {
    const parsed = stateSchema.safeParse(state);
    if (!parsed.success) {
      throw new LifecycleDiscoveryCacheCorruptError(z.prettifyError(parsed.error));
    }
    const directoryIdentity = await this.ensureSafeDirectory();
    try {
      const existing = await lstat(this.cachePath);
      if (!existing.isFile() || existing.isSymbolicLink()) {
        throw new LifecycleDiscoveryCacheUnsafePathError(
          'cache path is not a regular non-symlink file',
        );
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    // Revalidate immediately before creating the temporary file so chmod or
    // symlink replacement races cannot silently redirect the write.
    await this.assertSafeDirectory(directoryIdentity);
    const temporaryPath = join(
      this.stateDirectory,
      `.${LIFECYCLE_CACHE_FILE}.${process.pid}.${randomUUID()}.tmp`,
    );
    let handle;
    try {
      handle = await open(temporaryPath, 'wx', 0o600);
      await handle.writeFile(`${JSON.stringify(parsed.data)}\n`, 'utf8');
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporaryPath, this.cachePath);
      await chmod(this.cachePath, 0o600);
      await this.syncDirectory(directoryIdentity);
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
  }

  async quarantineCorrupt(): Promise<void> {
    const directoryIdentity = await this.assertSafeDirectory();
    const file = await lstat(this.cachePath);
    if (!file.isFile() || file.isSymbolicLink() || (file.mode & 0o077) !== 0) {
      throw new LifecycleDiscoveryCacheUnsafePathError(
        'corrupt cache is not a safe owner-only regular file',
      );
    }
    const quarantinePath = join(
      this.stateDirectory,
      `lifecycle-cache.corrupt.${Date.now()}.${randomUUID()}.json`,
    );
    await rename(this.cachePath, quarantinePath);
    await chmod(quarantinePath, 0o600);
    await this.syncDirectory(directoryIdentity);
  }
}
