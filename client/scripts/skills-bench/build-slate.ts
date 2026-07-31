// Usage: yarn tsx scripts/skills-bench/build-slate.ts --seed jinn.skills-bench.v1 \
//          [--pool-size 60] [--out ../bench/slate/slate.json] \
//          [--exclude-instances id1,id2] [--exclude-file ../bench/slate/exclude.json]
// Sources candidates the same way build-pilot-slate.ts does (HF monthly
// partitions → historical pool), then:
//   1. excludes every active cap-v0 held-out slate id (loadActiveHeldOutSlateIds),
//   1b. excludes any --exclude-instances / --exclude-file id (e.g. an instance
//       sweep-gradeability.ts found ungradeable), recorded on the written
//       slate as `excluded: [{instance_id, reason}]`,
//   2. dedupes to at most 2 instances per repo (independence: the cluster is the repo),
//   3. takes the seed-ranked first `pool-size` as candidates,
//   4. splitSlate({feedbackSize: 15, holdoutSize: 15}) and writes slate.json.
// Screening note (spec §2): instances here are already gradeable-screened by the
// validated-pool machinery this reuses; the smoke run (Task 9) is the final
// gradeability check before the slate is frozen by commit. sweep-gradeability.ts
// is the mandatory zero-inference pre-sweep before a slate freeze (see runbook).

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';

import { splitSlate, hashSlate, type SlateCandidate, type ExcludedCandidate } from '../../src/skills-bench/slate.js';
import {
  ACTIVE_HELD_OUT_SLATE_VERSIONS,
  loadActiveHeldOutSlateIds,
} from '../../src/solver-types/_swe-rebench-v2-held-out-slate.js';
import {
  buildHistoricalPool,
  fetchHfSplit,
  listMonthlyPartitions,
  type PoolTask,
} from '../../src/solver-types/_swe-rebench-v2-pool.js';
import { fetchHfWithRetry } from '../../src/harnesses/impls/swe-rebench-v2-evaluator/hf-fetcher.js';

const DATASET = 'nebius/SWE-rebench-leaderboard';
const SOLVER_TYPE = 'swe-rebench-v2.v1';
const FEEDBACK_SIZE = 15;
const HOLDOUT_SIZE = 15;
const DEFAULT_EXCLUDE_REASON = 'excluded by operator (build-slate.ts --exclude-instances/--exclude-file)';

interface Args {
  seed: string;
  poolSize: number;
  out: string;
  excludeInstances: string | undefined;
  excludeFile: string | undefined;
}

function parseArgs(argv: string[]): Args {
  let seed = '';
  let poolSize = 60;
  let out = resolvePath(process.cwd(), '..', 'bench', 'slate', 'slate.json');
  let excludeInstances: string | undefined;
  let excludeFile: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--seed') seed = String(argv[++index]);
    else if (arg === '--pool-size') poolSize = Number(argv[++index]);
    else if (arg === '--out') out = resolvePath(String(argv[++index]));
    else if (arg === '--exclude-instances') excludeInstances = String(argv[++index]);
    else if (arg === '--exclude-file') excludeFile = String(argv[++index]);
    else throw new Error(`unknown argument ${arg}`);
  }
  if (!seed) throw new Error('--seed is required');
  if (!Number.isInteger(poolSize) || poolSize < FEEDBACK_SIZE + HOLDOUT_SIZE) {
    throw new Error(`--pool-size must be an integer >= ${FEEDBACK_SIZE + HOLDOUT_SIZE}`);
  }
  return { seed, poolSize, out, excludeInstances, excludeFile };
}

/** A `--exclude-file` entry is either a plain instance-id string or an
 *  `{instance_id, reason}` object; either shape may appear in the same array. */
type ExcludeFileEntry = string | { instance_id: string; reason?: string };

export function parseExcludeFile(raw: string): ExcludedCandidate[] {
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) throw new Error('--exclude-file must contain a JSON array');
  return (parsed as ExcludeFileEntry[]).map((entry) => {
    if (typeof entry === 'string') return { instance_id: entry, reason: DEFAULT_EXCLUDE_REASON };
    if (entry && typeof entry === 'object' && typeof entry.instance_id === 'string') {
      const reason = typeof entry.reason === 'string' && entry.reason.trim() ? entry.reason : DEFAULT_EXCLUDE_REASON;
      return { instance_id: entry.instance_id, reason };
    }
    throw new Error(`--exclude-file entry must be a string id or {instance_id, reason}: ${JSON.stringify(entry)}`);
  });
}

/** Merges `--exclude-instances` and `--exclude-file` into one de-duplicated
 *  exclusion list (later source wins on a duplicate id: file, then flag). */
export function resolveExclusions(args: { excludeInstances?: string; excludeFile?: string }): ExcludedCandidate[] {
  const collected: ExcludedCandidate[] = [];
  if (args.excludeFile) collected.push(...parseExcludeFile(readFileSync(args.excludeFile, 'utf8')));
  if (args.excludeInstances) {
    for (const id of args.excludeInstances.split(',').map((s) => s.trim()).filter(Boolean)) {
      collected.push({ instance_id: id, reason: DEFAULT_EXCLUDE_REASON });
    }
  }
  return [...new Map(collected.map((e) => [e.instance_id, e])).values()];
}

async function loadPool(): Promise<PoolTask[]> {
  const splitsUrl = `https://datasets-server.huggingface.co/splits?dataset=${encodeURIComponent(DATASET)}`;
  const response = await fetchHfWithRetry(splitsUrl, {});
  if (!response.ok) throw new Error(`HF splits fetch failed: ${response.status}`);
  const body = (await response.json()) as { splits?: Array<{ split: string }> };
  const months = listMonthlyPartitions((body.splits ?? []).map((entry) => entry.split));
  if (months.length === 0) throw new Error('HF returned no monthly SWE-rebench partitions');
  return buildHistoricalPool({
    months,
    fetchSplit: (split) => fetchHfSplit({ dataset: DATASET, split, limit: 100 }),
  });
}

function rankKey(seed: string, id: string): string {
  return createHash('sha256').update(`${seed}:${id}`).digest('hex');
}

/**
 * Exclude held-out ids and any operator-supplied `additionalExcludeIds`
 * (applied together, both before ranking/dedupe/take so an excluded id can
 * never surface even when it would otherwise seed-rank first), drop
 * repo-less rows (can't cluster-dedupe them), rank by seed, then walk in
 * rank order keeping at most 2 instances per repo — this both dedupes and
 * produces the seed-ranked ordering the CLI takes its first `poolSize`
 * candidates from in one pass.
 */
export function selectCandidates(
  pool: PoolTask[],
  seed: string,
  poolSize: number,
  additionalExcludeIds: Set<string> = new Set(),
): SlateCandidate[] {
  const excluded = loadActiveHeldOutSlateIds(SOLVER_TYPE, ACTIVE_HELD_OUT_SLATE_VERSIONS);
  const eligible = pool.filter((task) =>
    !excluded.has(task.instance_id) && !additionalExcludeIds.has(task.instance_id) && task.repo);
  const ranked = [...eligible].sort((a, b) =>
    rankKey(seed, a.instance_id).localeCompare(rankKey(seed, b.instance_id)));
  const perRepoCount = new Map<string, number>();
  const deduped: SlateCandidate[] = [];
  for (const task of ranked) {
    const repo = task.repo!;
    const count = perRepoCount.get(repo) ?? 0;
    if (count >= 2) continue;
    perRepoCount.set(repo, count + 1);
    deduped.push({
      instance_id: task.instance_id,
      repo,
      hf_dataset: task.hf_dataset,
      hf_split: task.hf_split,
    });
    if (deduped.length === poolSize) break;
  }
  return deduped;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const exclusions = resolveExclusions(args);
  const excludeIds = new Set(exclusions.map((e) => e.instance_id));
  const pool = await loadPool();
  const candidates = selectCandidates(pool, args.seed, args.poolSize, excludeIds);
  const split = splitSlate(candidates, {
    seed: args.seed,
    feedbackSize: FEEDBACK_SIZE,
    holdoutSize: HOLDOUT_SIZE,
  });
  // Re-derive the hash with `excluded` folded in (a no-op when empty — see
  // hashSlate's back-compat note) rather than trusting splitSlate's sha256,
  // which never saw the exclusion list.
  const body = {
    version: split.version,
    seed: split.seed,
    feedback: split.feedback,
    holdout: split.holdout,
    ...(exclusions.length > 0 ? { excluded: exclusions } : {}),
  };
  const slate = { ...body, sha256: hashSlate(body) };
  mkdirSync(dirname(args.out), { recursive: true });
  writeFileSync(args.out, JSON.stringify(slate, null, 2));
  console.log(
    `sha256=${slate.sha256} feedback=${slate.feedback.length} holdout=${slate.holdout.length} ` +
    `excluded=${exclusions.length}`,
  );
  console.log(`wrote ${args.out}`);
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
