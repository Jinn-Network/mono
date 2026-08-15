/**
 * Durable commit-echo harvest state.
 *
 * The v2 file separates repository discovery cursors from independently
 * resumable build/task jobs.  A candidate is written as a job in the same
 * atomic file update that advances the cursor, so a process crash can create
 * at worst a duplicate discovery attempt, never a lost commit.
 */

import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { join, resolve as resolvePath } from 'node:path';
import { canonicalJson } from '../util/canonical-json.js';
import type { DifferentialAdmissionReceiptV2 } from './_swe-rebench-v2-differential-admission.js';

const HARVEST_STATE_FILE = 'harvest-state.json';
const SCHEMA_VERSION_V1 = 'swe-rebench-v2-harvest-state.v1' as const;
const SCHEMA_VERSION = 'swe-rebench-v2-harvest-state.v2' as const;
export const MAX_HARVEST_INFRA_RETRIES = 3;
/** Stable awaiting-input reason prefixes used to decide safe requeue policy. */
export const AWAITING_RECIPE_REQUIRED = 'awaiting_input:recipe-required' as const;
export const AWAITING_RECIPE_BINDING_MISMATCH = 'awaiting_input:recipe-binding-mismatch' as const;
export const AWAITING_TEST_PATCH_REQUIRED = 'awaiting_input:test-patch-required' as const;
export const AWAITING_TARGETED_TEST_COMMAND_REQUIRED = 'awaiting_input:unsupported-test-targeting' as const;
/** A local receipt exists, but no public CID may be invented during --no-post harvesting. */
export const AWAITING_RECEIPT_PUBLICATION_REQUIRED = 'awaiting_input:receipt-publication-required' as const;

export function isRecipeAwaitingReason(reason: string | undefined): boolean {
  return Boolean(
    reason?.startsWith(`${AWAITING_RECIPE_REQUIRED}:`) ||
    reason?.startsWith(`${AWAITING_RECIPE_BINDING_MISMATCH}:`) ||
    reason?.startsWith(`${AWAITING_TARGETED_TEST_COMMAND_REQUIRED}:`),
  );
}

function isReceiptPublicationAwaitingReason(reason: string | undefined): boolean {
  return Boolean(reason?.startsWith(`${AWAITING_RECEIPT_PUBLICATION_REQUIRED}:`));
}

export interface HarvestRepoState {
  lastScannedCommit: string;
  /** Retained solely to read old v1 local state. New callers use jobs. */
  rejected: Record<string, { reason: string; at: string }>;
}

export type HarvestJobStage =
  | 'discovered'
  | 'recipe'
  | 'image'
  | 'environment'
  | 'empirical'
  | 'admission'
  | 'ipfs'
  | 'complete';

export type HarvestJobDisposition =
  | 'pending'
  | 'retrying'
  | 'admitted'
  | 'terminal_policy'
  | 'awaiting_input'
  | 'quarantined'
  | 'failed_infrastructure';

/** Local-only candidate data required to resume a discovered task. */
export interface HarvestJobCandidate {
  instance_id: string;
  repo: string;
  base_commit: string;
  fix_commit: string;
  gold_patch: string;
  test_patch: string;
  test_paths: string[];
  language: string;
  problem_statement: string;
}

export interface HarvestJob {
  taskKey: string;
  buildKey: string;
  repo: string;
  baseCommit: string;
  fixCommit: string;
  recipeHash: string;
  platform: 'linux/amd64';
  stage: HarvestJobStage;
  disposition: HarvestJobDisposition;
  attempts: number;
  nextAttemptAt?: string;
  reason?: string;
  candidate: HarvestJobCandidate;
  artifactRefs: Record<string, string>;
  resourceUse: Record<string, number>;
  differentialAdmission?: DifferentialAdmissionEvidenceV2;
  createdAt: string;
  updatedAt: string;
}

export interface BoundEmpiricalEvidenceBindingV1 {
  schemaVersion: 'swe-rebench-v2-empirical-evidence.v1';
  task: {
    instanceId: string;
    repo: string;
    baseCommit: string;
    fixCommit: string;
  };
  image: { reference: string; digest: `sha256:${string}` };
  environmentHash: string;
  parser: { id: string; version: string; digest: `sha256:${string}`; bundleId: string };
  testPatchHash: `sha256:${string}`;
  evalSemanticsVersion: string;
}

export interface EmpiricalReportSnapshotV1 {
  passed: string[];
  failed: string[];
  passed_match: boolean;
}

export interface BoundEmpiricalEvidenceV1 {
  schemaVersion: 'swe-rebench-v2-empirical-evidence.v1';
  binding: BoundEmpiricalEvidenceBindingV1;
  before: EmpiricalReportSnapshotV1;
  after: EmpiricalReportSnapshotV1;
  recordedAt: string;
}

/**
 * A separate v2 receipt checkpoint. It intentionally does not share either a
 * key or shape with V1 empirical evidence, so hardened admission cannot treat
 * the old one-before/one-after observation as repeated causal proof.
 */
export interface DifferentialAdmissionEvidenceV2 {
  schemaVersion: 'swe-rebench-v2-differential-admission-evidence.v2';
  admissionPolicyVersion: 'swe-rebench-v2-differential-admission.v2';
  receiptHash: `sha256:${string}`;
  /** Sanitised public receipt retained locally for restart-safe revalidation. */
  receipt?: DifferentialAdmissionReceiptV2;
  receiptCid?: string;
  recordedAt: string;
}

interface HarvestStateFileV1 {
  schemaVersion: typeof SCHEMA_VERSION_V1;
  updatedAt: string;
  repos: Record<string, HarvestRepoState>;
}

export interface HarvestStateFile {
  schemaVersion: typeof SCHEMA_VERSION;
  updatedAt: string;
  repos: Record<string, HarvestRepoState>;
  jobs: Record<string, HarvestJob>;
  empiricalEvidence: Record<string, BoundEmpiricalEvidenceV1>;
}

export function harvestTaskKey(repo: string, fixCommit: string): string {
  return `task:${repo}@${fixCommit}`;
}

export function harvestBuildKey(
  repo: string,
  baseCommit: string,
  recipeHash: string,
  platform: 'linux/amd64',
): string {
  return `build:${repo}@${baseCommit}:${recipeHash}:${platform}`;
}

export function empiricalEvidenceKey(binding: BoundEmpiricalEvidenceBindingV1): string {
  return `sha256:${createHash('sha256').update(canonicalJson(binding)).digest('hex')}`;
}

/** Classify a failed step without mistaking missing operator input for denial. */
export function classifyHarvestFailure(reason: string): Exclude<HarvestJobDisposition, 'pending' | 'admitted'> {
  const normalized = reason.toLowerCase();
  if (/\b(private|denied|license|rights|policy|forbidden)\b/.test(normalized)) return 'terminal_policy';
  if (/\b(awaiting_input|unsupported|unconfigured|no admitted source|no trusted recipe)\b/.test(normalized)) {
    return 'awaiting_input';
  }
  if (/\b(flaky|non-reproducible|nonreproducible|empirical-dead|gold-patch-not-resolved|weak-suite)\b/.test(normalized)) return 'quarantined';
  return 'retrying';
}

function isV1(raw: unknown): raw is HarvestStateFileV1 {
  return typeof raw === 'object' && raw !== null &&
    (raw as HarvestStateFileV1).schemaVersion === SCHEMA_VERSION_V1 &&
    typeof (raw as HarvestStateFileV1).repos === 'object' && (raw as HarvestStateFileV1).repos !== null;
}

function isV2(raw: unknown): raw is HarvestStateFile {
  return typeof raw === 'object' && raw !== null &&
    (raw as HarvestStateFile).schemaVersion === SCHEMA_VERSION &&
    typeof (raw as HarvestStateFile).repos === 'object' && (raw as HarvestStateFile).repos !== null &&
    typeof (raw as HarvestStateFile).jobs === 'object' && (raw as HarvestStateFile).jobs !== null &&
    typeof (raw as HarvestStateFile).empiricalEvidence === 'object' && (raw as HarvestStateFile).empiricalEvidence !== null;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export class HarvestStateStore {
  private readonly file: string;
  private cache: HarvestStateFile | null = null;

  constructor(opts: { stateDir: string }) {
    this.file = resolvePath(join(opts.stateDir, HARVEST_STATE_FILE));
  }

  private fresh(): HarvestStateFile {
    return {
      schemaVersion: SCHEMA_VERSION,
      updatedAt: new Date().toISOString(),
      repos: {},
      jobs: {},
      empiricalEvidence: {},
    };
  }

  private migrateV1(file: HarvestStateFileV1): HarvestStateFile {
    return {
      schemaVersion: SCHEMA_VERSION,
      updatedAt: file.updatedAt,
      repos: file.repos,
      jobs: {},
      empiricalEvidence: {},
    };
  }

  private async load(): Promise<HarvestStateFile> {
    if (this.cache) return this.cache;
    try {
      const raw: unknown = JSON.parse(await readFile(this.file, 'utf8'));
      if (isV2(raw)) {
        this.cache = raw;
        return raw;
      }
      if (isV1(raw)) {
        const migrated = this.migrateV1(raw);
        await this.persist(migrated);
        return migrated;
      }
    } catch {
      // missing local state starts clean; immutable published artifacts remain external.
    }
    this.cache = this.fresh();
    return this.cache;
  }

  private async persist(file: HarvestStateFile): Promise<void> {
    file.updatedAt = new Date().toISOString();
    await mkdir(resolvePath(join(this.file, '..')), { recursive: true });
    const tmp = `${this.file}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, `${JSON.stringify(file, null, 2)}\n`, 'utf8');
    await rename(tmp, this.file);
    this.cache = file;
  }

  async getRepo(repoKey: string): Promise<HarvestRepoState | null> {
    const file = await this.load();
    return file.repos[repoKey] ? clone(file.repos[repoKey]) : null;
  }

  async setLastScannedCommit(repoKey: string, commit: string): Promise<void> {
    const file = await this.load();
    const prev = file.repos[repoKey] ?? { lastScannedCommit: '', rejected: {} };
    file.repos[repoKey] = { ...prev, lastScannedCommit: commit };
    await this.persist(file);
  }

  /** Compatibility shim for old callers; v2 callers should record a job disposition. */
  async recordRejected(repoKey: string, instanceId: string, reason: string): Promise<void> {
    const file = await this.load();
    const prev = file.repos[repoKey] ?? { lastScannedCommit: '', rejected: {} };
    prev.rejected[instanceId] = { reason, at: new Date().toISOString() };
    file.repos[repoKey] = prev;
    await this.persist(file);
  }

  isRejected(repoState: HarvestRepoState | null, instanceId: string): boolean {
    return Boolean(repoState?.rejected[instanceId]);
  }

  /**
   * Atomically write new task jobs before advancing a repo cursor. Existing
   * task keys are preserved, making discovery idempotent after restart.
   */
  async persistDiscoveredJobs(args: {
    repo: string;
    cursor: string;
    candidates: HarvestJobCandidate[];
    recipeHash?: string;
    platform?: 'linux/amd64';
  }): Promise<HarvestJob[]> {
    const file = await this.load();
    const now = new Date().toISOString();
    const recipeHash = args.recipeHash ?? 'unconfigured';
    const platform = args.platform ?? 'linux/amd64';
    const created: HarvestJob[] = [];
    for (const candidate of args.candidates) {
      const taskKey = harvestTaskKey(candidate.repo, candidate.fix_commit);
      const existing = file.jobs[taskKey];
      if (existing) {
        created.push(clone(existing));
        continue;
      }
      const job: HarvestJob = {
        taskKey,
        buildKey: harvestBuildKey(candidate.repo, candidate.base_commit, recipeHash, platform),
        repo: candidate.repo,
        baseCommit: candidate.base_commit,
        fixCommit: candidate.fix_commit,
        recipeHash,
        platform,
        stage: 'discovered',
        disposition: 'pending',
        attempts: 0,
        candidate: clone(candidate),
        artifactRefs: {},
        resourceUse: {},
        createdAt: now,
        updatedAt: now,
      };
      file.jobs[taskKey] = job;
      created.push(clone(job));
    }
    const prev = file.repos[args.repo] ?? { lastScannedCommit: '', rejected: {} };
    file.repos[args.repo] = { ...prev, lastScannedCommit: args.cursor };
    await this.persist(file);
    return created;
  }

  async getJob(taskKey: string): Promise<HarvestJob | null> {
    const file = await this.load();
    return file.jobs[taskKey] ? clone(file.jobs[taskKey]) : null;
  }

  async getDueJobs(now = new Date()): Promise<HarvestJob[]> {
    const file = await this.load();
    const current = now.getTime();
    return Object.values(file.jobs)
      .filter((job) => job.disposition === 'pending' || job.disposition === 'retrying')
      .filter((job) => !job.nextAttemptAt || new Date(job.nextAttemptAt).getTime() <= current)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.taskKey.localeCompare(b.taskKey))
      .map(clone);
  }

  /**
   * Re-open only awaiting-input jobs whose newly supplied trusted recipe
   * explicitly claims them. This never revives policy/quarantine failures and
   * leaves an incompatible configuration inert, preventing per-tick churn.
   */
  async resumeAwaitingInputJobs(args: {
    repo: string;
    recipeHash: string;
    platform?: 'linux/amd64';
    predicate: (job: Readonly<HarvestJob>) => boolean;
  }): Promise<HarvestJob[]> {
    const file = await this.load();
    const platform = args.platform ?? 'linux/amd64';
    const resumed: HarvestJob[] = [];
    for (const job of Object.values(file.jobs)) {
      if (
        job.repo !== args.repo ||
        job.disposition !== 'awaiting_input' ||
        !isRecipeAwaitingReason(job.reason) ||
        !args.predicate(clone(job))
      ) continue;
      job.recipeHash = args.recipeHash;
      job.platform = platform;
      job.buildKey = harvestBuildKey(job.repo, job.baseCommit, args.recipeHash, platform);
      job.stage = 'discovered';
      job.disposition = 'pending';
      job.reason = undefined;
      job.nextAttemptAt = undefined;
      job.updatedAt = new Date().toISOString();
      resumed.push(clone(job));
    }
    if (resumed.length > 0) await this.persist(file);
    return resumed;
  }

  /**
   * Re-open local receipt evidence only when this tick is allowed to publish.
   * Its environment/receipt binding remains intact; only the terminal waiting
   * disposition changes, so no empirical evidence is rerun just to acquire a
   * CID.
   */
  async resumeAwaitingPublicationJobs(args: {
    repo: string;
    recipeHash: string;
    predicate: (job: Readonly<HarvestJob>) => boolean;
  }): Promise<HarvestJob[]> {
    const file = await this.load();
    const resumed: HarvestJob[] = [];
    for (const job of Object.values(file.jobs)) {
      if (
        job.repo !== args.repo ||
        job.recipeHash !== args.recipeHash ||
        job.disposition !== 'awaiting_input' ||
        !isReceiptPublicationAwaitingReason(job.reason) ||
        !args.predicate(clone(job))
      ) continue;
      job.disposition = 'pending';
      job.reason = undefined;
      job.nextAttemptAt = undefined;
      job.updatedAt = new Date().toISOString();
      resumed.push(clone(job));
    }
    if (resumed.length > 0) await this.persist(file);
    return resumed;
  }

  /**
   * A retried job may receive a different explicit recipe for the same base
   * commit. Its old checkpoint bindings must not cross that boundary: retain
   * the task key, but start a fresh environment chain under the new build key.
   */
  async rebindJobRecipe(args: {
    taskKey: string;
    recipeHash: string;
    platform?: 'linux/amd64';
  }): Promise<HarvestJob> {
    const file = await this.load();
    const job = file.jobs[args.taskKey];
    if (!job) throw new Error(`unknown harvest job ${args.taskKey}`);
    const platform = args.platform ?? 'linux/amd64';
    job.recipeHash = args.recipeHash;
    job.platform = platform;
    job.buildKey = harvestBuildKey(job.repo, job.baseCommit, args.recipeHash, platform);
    job.stage = 'discovered';
    job.artifactRefs = {};
    job.resourceUse = {};
    job.reason = undefined;
    job.nextAttemptAt = undefined;
    job.updatedAt = new Date().toISOString();
    await this.persist(file);
    return clone(job);
  }

  async updateJob(taskKey: string, update: Partial<Pick<HarvestJob,
    'stage' | 'artifactRefs' | 'resourceUse' | 'reason' | 'nextAttemptAt' | 'differentialAdmission'>>): Promise<HarvestJob> {
    const file = await this.load();
    const job = file.jobs[taskKey];
    if (!job) throw new Error(`unknown harvest job ${taskKey}`);
    if (update.stage) job.stage = update.stage;
    if (update.artifactRefs) job.artifactRefs = { ...job.artifactRefs, ...update.artifactRefs };
    if (update.resourceUse) job.resourceUse = { ...job.resourceUse, ...update.resourceUse };
    if (update.differentialAdmission) job.differentialAdmission = clone(update.differentialAdmission);
    if (update.reason !== undefined) job.reason = update.reason;
    if (update.nextAttemptAt !== undefined) job.nextAttemptAt = update.nextAttemptAt;
    job.updatedAt = new Date().toISOString();
    await this.persist(file);
    return clone(job);
  }

  async markJobAdmitted(taskKey: string): Promise<HarvestJob> {
    const file = await this.load();
    const job = file.jobs[taskKey];
    if (!job) throw new Error(`unknown harvest job ${taskKey}`);
    job.stage = 'complete';
    job.disposition = 'admitted';
    job.nextAttemptAt = undefined;
    job.updatedAt = new Date().toISOString();
    await this.persist(file);
    return clone(job);
  }

  async markJobFailure(taskKey: string, reason: string, opts: { now?: Date; retryDelayMs?: number } = {}): Promise<HarvestJob> {
    const file = await this.load();
    const job = file.jobs[taskKey];
    if (!job) throw new Error(`unknown harvest job ${taskKey}`);
    const classified = classifyHarvestFailure(reason);
    job.reason = reason;
    job.updatedAt = (opts.now ?? new Date()).toISOString();
    if (classified === 'retrying') {
      job.attempts += 1;
      if (job.attempts >= MAX_HARVEST_INFRA_RETRIES) {
        job.disposition = 'failed_infrastructure';
        job.nextAttemptAt = undefined;
      } else {
        job.disposition = 'retrying';
        const delay = opts.retryDelayMs ?? 60_000;
        job.nextAttemptAt = new Date((opts.now ?? new Date()).getTime() + delay).toISOString();
      }
    } else {
      job.disposition = classified;
      job.nextAttemptAt = undefined;
    }
    await this.persist(file);
    return clone(job);
  }

  async getEmpiricalEvidence(binding: BoundEmpiricalEvidenceBindingV1): Promise<BoundEmpiricalEvidenceV1 | null> {
    const file = await this.load();
    const evidence = file.empiricalEvidence[empiricalEvidenceKey(binding)];
    if (!evidence || canonicalJson(evidence.binding) !== canonicalJson(binding)) return null;
    return clone(evidence);
  }

  async recordEmpiricalEvidence(evidence: BoundEmpiricalEvidenceV1): Promise<void> {
    const file = await this.load();
    const key = empiricalEvidenceKey(evidence.binding);
    file.empiricalEvidence[key] = clone(evidence);
    await this.persist(file);
  }
}
