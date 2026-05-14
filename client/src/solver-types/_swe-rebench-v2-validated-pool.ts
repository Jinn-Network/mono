/**
 * Pool-validation gate for the swe-rebench-v2 task generator.
 *
 * SWE-rebench's leaderboard split contains instances that can't be scored in
 * our eval environment — the dataset `test_cmd` runs a superset of the named
 * tests, a `PASS_TO_PASS` test ERRORs without a service the container doesn't
 * provide, the gold patch doesn't reproduce the expected transition, etc.
 * Posting tasks for those just produces verdicts that say nothing about the
 * solver. Standard practice (SWE-bench Verified by hand, SWE-rebench's pipeline
 * automatically) is to validate each instance and only keep the scorable ones.
 *
 * `validatePoolInstances` does that validation: run the *gold* patch through
 * our `PythonEvalRunner` and mark the instance scorable iff it resolves
 * (`passed_match: true` under our SWE-bench "resolved" semantics). Results are
 * cached per `(instance_id, evalSemanticsVersion)` in `<stateDir>/validated-pool.json`.
 * The generator (`filterToScorablePool`) restricts its posting pool to the
 * scorable set; absent validation data it falls back to Python-only instances
 * (the languages our pytest `test_cmd` override supports) as a conservative floor.
 *
 * Refs: jinn-mono-uy6v.9.
 */

import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import type { PoolTask } from './_swe-rebench-v2-pool.js';
import type { EvalRunner, HfFetcher } from '../harnesses/impls/swe-rebench-v2-evaluator/index.js';
import { computeRowHash, resolveImageDigest, resolveUpstreamEvalCommit, type CommandRunner } from './_swe-rebench-v2-substrate.js';

/**
 * Bump when the eval grading semantics change (verdict re-derivation,
 * ungradeable classification, test-command construction) so cached validation
 * results from an older harness are treated as stale and re-checked.
 *
 *   '1' — original exact-set `passed_match`.
 *   '2' — SWE-bench "resolved" semantics + run-the-named-tests `test_cmd`
 *         override (jinn-mono-uy6v.8).
 *   '3' — adds verdict-time substrate recheck (`rowHash`, `imageDigest`,
 *         `upstreamEvalCommit`) and extended ungradeable classifier
 *         (venv collision, missing pytest, dependency warnings, conftest
 *         import/setup failures) — jinn-mono-fufn.
 */
export const EVAL_SEMANTICS_VERSION = '3';

const SCHEMA_VERSION = 'swe-rebench-v2-validated-pool.v1' as const;

export interface ValidatedPoolEntry {
  scorable: boolean;
  /** Why scorable/unscorable — `'gold-patch-resolves'`, `'ungradeable:<reason>'`, etc. */
  reason: string;
  checkedAt: string; // ISO timestamp
  /** Canonical-JSON SHA-256 over the HF row fields used for grading. v3+. */
  rowHash?: string;
  /** Full image reference (`<repo>:<tag>`) the validation pulled. v3+. */
  imageName?: string;
  /** Image digest resolved from `docker image inspect` after validation. v3+. */
  imageDigest?: string;
  /** `git rev-parse HEAD` of the enabled upstream SWE-rebench repo at validation time. v3+. */
  upstreamEvalCommit?: string;
}

interface ValidatedPoolFile {
  schemaVersion: typeof SCHEMA_VERSION;
  evalSemanticsVersion: string;
  updatedAt: string;
  entries: Record<string, ValidatedPoolEntry>;
}

function freshFile(evalSemanticsVersion: string): ValidatedPoolFile {
  return { schemaVersion: SCHEMA_VERSION, evalSemanticsVersion, updatedAt: new Date().toISOString(), entries: {} };
}

function isValidFile(raw: unknown, evalSemanticsVersion: string): raw is ValidatedPoolFile {
  return (
    typeof raw === 'object' && raw !== null &&
    (raw as ValidatedPoolFile).schemaVersion === SCHEMA_VERSION &&
    (raw as ValidatedPoolFile).evalSemanticsVersion === evalSemanticsVersion &&
    typeof (raw as ValidatedPoolFile).entries === 'object' && (raw as ValidatedPoolFile).entries !== null
  );
}

export class ValidatedPoolStore {
  private readonly file: string;
  private cache: ValidatedPoolFile | null = null;
  /** mtime-keyed cache for `getScorableIds`. The generator's tick reads this
   *  every poll (every few seconds); the file only changes during infrequent
   *  `validate-pool` CLI runs. Invalidate on mtime change. */
  private scorableIdsCache: { mtimeMs: number; semanticsVersion: string; ids: Set<string> | null } | null = null;

  constructor(opts: { stateDir: string }) {
    this.file = join(opts.stateDir, 'validated-pool.json');
  }

  private async readRaw(): Promise<unknown> {
    try {
      return JSON.parse(await readFile(this.file, 'utf8'));
    } catch {
      return null;
    }
  }

  private async loadForWrite(evalSemanticsVersion: string): Promise<ValidatedPoolFile> {
    if (this.cache && this.cache.evalSemanticsVersion === evalSemanticsVersion) return this.cache;
    const raw = await this.readRaw();
    this.cache = isValidFile(raw, evalSemanticsVersion) ? raw : freshFile(evalSemanticsVersion);
    return this.cache;
  }

  private async save(): Promise<void> {
    if (!this.cache) return;
    this.cache.updatedAt = new Date().toISOString();
    await mkdir(dirname(this.file), { recursive: true });
    await writeFile(this.file, JSON.stringify(this.cache, null, 2));
  }

  /** The set of instance ids known scorable for `evalSemanticsVersion`, or
   *  `null` if there is no validation data for this semantics version (the
   *  on-disk file is absent or built for a different version). Memoised by
   *  mtime so the generator's tick doesn't re-parse the JSON every poll. */
  async getScorableIds(evalSemanticsVersion: string): Promise<Set<string> | null> {
    const mtimeMs = await stat(this.file).then((s) => s.mtimeMs).catch(() => -1);
    const cached = this.scorableIdsCache;
    if (cached && cached.mtimeMs === mtimeMs && cached.semanticsVersion === evalSemanticsVersion) {
      return cached.ids;
    }
    const raw = await this.readRaw();
    const ids = isValidFile(raw, evalSemanticsVersion)
      ? new Set(Object.entries(raw.entries).filter(([, e]) => e.scorable).map(([id]) => id))
      : null;
    this.scorableIdsCache = { mtimeMs, semanticsVersion: evalSemanticsVersion, ids };
    return ids;
  }

  /** The entry for `instanceId`, or `null` if not validated for this semantics version. */
  async getEntry(instanceId: string, evalSemanticsVersion: string): Promise<ValidatedPoolEntry | null> {
    const f = await this.loadForWrite(evalSemanticsVersion);
    return f.entries[instanceId] ?? null;
  }

  async record(instanceId: string, entry: ValidatedPoolEntry, evalSemanticsVersion: string): Promise<void> {
    const f = await this.loadForWrite(evalSemanticsVersion);
    f.entries[instanceId] = entry;
    await this.save();
  }
}

/**
 * Restrict the generator's posting pool to instances we can actually score.
 * With validation data (`scorableIds` non-null): keep only the scorable set.
 * Without it: fall back to Python-only instances — the conservative floor our
 * pytest `test_cmd` override supports — and the caller should warn that the
 * full gate (`jinn solver-nets validate-pool swe-rebench-v2`) hasn't been run.
 *
 * The `nebius/SWE-rebench-leaderboard` rows don't carry an explicit `language`
 * field (it's `undefined`/`null` on every row), so we also infer from the
 * patch file extensions — mirroring `inferLanguageFromPatch` in the solver-type.
 */
export function filterToScorablePool(
  pool: PoolTask[],
  scorableIds: Set<string> | null,
): { pool: PoolTask[]; mode: 'validated' | 'python-floor' } {
  if (scorableIds) {
    return { pool: pool.filter((t) => scorableIds.has(t.instance_id)), mode: 'validated' };
  }
  return { pool: pool.filter(isPythonInstance), mode: 'python-floor' };
}

function isPythonInstance(task: PoolTask): boolean {
  if (task.language === 'python') return true;
  if (task.language && task.language !== 'python') return false;
  // language unset → infer from `.py` in any patch path.
  return looksPython(task.patch) || looksPython(task.test_patch);
}

function looksPython(patch: string | undefined): boolean {
  if (!patch) return false;
  // Match `--- a/<p>` / `+++ b/<p>` / `diff --git a/<p>` ending in .py
  return /(?:^|\n)(?:---|\+\+\+|diff --git) [ab]\/\S+\.py(?:\s|$)/.test(patch);
}

const defaultCommandRunner: CommandRunner = (bin, args, opts) => new Promise((resolve, reject) => {
  const child = spawn(bin, args, { ...(opts ?? {}), stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = ''; let stderr = '';
  child.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
  child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
  child.on('error', reject);
  child.on('close', (code: number | null) => resolve({ exitCode: code ?? 1, stdout, stderr }));
});

export interface ValidatePoolDeps {
  fetcher: HfFetcher;
  runner: EvalRunner;
  store: ValidatedPoolStore;
  semanticsVersion: string;
  /** v3+: directory of the enabled upstream SWE-rebench repo — used to resolve `upstreamEvalCommit`. Required: every caller must opt in to v3 semantics explicitly. */
  upstreamRepoDir: string;
  /** Defaults to spawn-based runner; tests inject a stub. */
  commandRunner?: CommandRunner;
  log?: (msg: string) => void;
}

export interface ValidatePoolSummary {
  checked: number;     // instances we ran the gold-eval for this run
  scorable: number;    // of those, marked scorable
  unscorable: number;  // of those, marked unscorable
  skipped: number;     // non-Python instances we didn't even try
}

function nameOf(err: unknown): string {
  return typeof err === 'object' && err !== null && typeof (err as { name?: unknown }).name === 'string'
    ? (err as { name: string }).name : '';
}
function reasonOf(err: unknown): string {
  return typeof err === 'object' && err !== null && typeof (err as { reason?: unknown }).reason === 'string'
    ? (err as { reason: string }).reason : 'unknown';
}

/**
 * Validate pool instances by running their gold patch through the eval harness.
 * Idempotent: instances already recorded for `semanticsVersion` are skipped
 * unless `opts.force`. `opts.limit` caps how many gold-evals one run does.
 */
export async function validatePoolInstances(
  pool: PoolTask[],
  deps: ValidatePoolDeps,
  opts: { limit?: number; force?: boolean } = {},
): Promise<ValidatePoolSummary> {
  const log = deps.log ?? (() => {});
  const runner = deps.commandRunner ?? defaultCommandRunner;
  const summary: ValidatePoolSummary = { checked: 0, scorable: 0, unscorable: 0, skipped: 0 };

  // Resolve the upstream eval commit once per run — it doesn't change mid-run.
  const upstreamEvalCommit = await resolveUpstreamEvalCommit(deps.upstreamRepoDir, runner);

  for (const task of pool) {
    if (opts.limit != null && summary.checked >= opts.limit) break;

    // Only pytest (Python) instances are supported by the eval-runner `test_cmd`
    // override; everything else can't be scored cleanly today. The leaderboard
    // rows don't carry an explicit language field — infer from the patch when
    // unset.
    if (!isPythonInstance(task)) {
      await deps.store.record(task.instance_id, { scorable: false, reason: 'non-pytest-unsupported', checkedAt: new Date().toISOString() }, deps.semanticsVersion);
      summary.skipped += 1;
      continue;
    }
    if (!opts.force && (await deps.store.getEntry(task.instance_id, deps.semanticsVersion))) {
      continue; // already validated for this semantics version
    }
    if (!task.patch || !task.test_patch) {
      await deps.store.record(task.instance_id, { scorable: false, reason: 'missing-gold-patch', checkedAt: new Date().toISOString() }, deps.semanticsVersion);
      summary.checked += 1; summary.unscorable += 1;
      continue;
    }

    log(`[validate-pool] ${task.instance_id} …`);
    let entry: ValidatedPoolEntry;
    try {
      const row = await deps.fetcher.fetchTaskRow({ hf_dataset: task.hf_dataset, hf_split: task.hf_split, instance_id: task.instance_id });
      const rowHash = computeRowHash({
        hf_dataset: task.hf_dataset,
        hf_split: task.hf_split,
        instance_id: task.instance_id,
        repo: task.repo ?? row.repo,
        base_commit: task.base_commit ?? '',
        image_name: row.image_name,
        patch: task.patch,
        test_patch: row.test_patch ?? task.test_patch,
        install_config: { ...row.install_config, install: row.install_config.install ?? [] },
        FAIL_TO_PASS: row.FAIL_TO_PASS,
        PASS_TO_PASS: row.PASS_TO_PASS,
      });
      const res = await deps.runner.runEval({
        instance_id: task.instance_id,
        repo: task.repo ?? row.repo,
        image: row.image_name,
        patch: task.patch,
        test_patch: row.test_patch ?? task.test_patch,
        install: row.install_config.install,
        test_cmd: row.install_config.test_cmd,
        log_parser: row.install_config.log_parser,
        fail_to_pass: row.FAIL_TO_PASS,
        pass_to_pass: row.PASS_TO_PASS,
      });
      const checkedAt = new Date().toISOString();
      // Resolve digest AFTER the eval ran — that's when the image is guaranteed
      // to be present locally with its RepoDigests populated.
      const imageDigest = await resolveImageDigest(row.image_name, runner);
      if (!imageDigest) {
        // Every admission must carry a digest. No digest → not admissible.
        entry = { scorable: false, reason: 'unresolvable-image-digest', checkedAt, rowHash, imageName: row.image_name, ...(upstreamEvalCommit ? { upstreamEvalCommit } : {}) };
      } else {
        entry = res.passed_match
          ? { scorable: true, reason: 'gold-patch-resolves', checkedAt, rowHash, imageName: row.image_name, imageDigest, ...(upstreamEvalCommit ? { upstreamEvalCommit } : {}) }
          : { scorable: false, reason: `gold-patch-not-resolved (f2p ${res.passed.length}, p2p_broke ${res.failed.length})`, checkedAt, rowHash, imageName: row.image_name, imageDigest, ...(upstreamEvalCommit ? { upstreamEvalCommit } : {}) };
      }
    } catch (err) {
      const reason = nameOf(err) === 'EvalCouldNotGradeError'
        ? `ungradeable:${reasonOf(err)}`
        : `error:${(err instanceof Error ? err.message : String(err)).slice(0, 200)}`;
      entry = { scorable: false, reason, checkedAt: new Date().toISOString() };
    }
    await deps.store.record(task.instance_id, entry, deps.semanticsVersion);
    summary.checked += 1;
    if (entry.scorable) summary.scorable += 1; else summary.unscorable += 1;
    log(`[validate-pool] ${task.instance_id} → ${entry.scorable ? 'SCORABLE' : 'unscorable'} (${entry.reason})`);
  }
  return summary;
}
