// Usage: yarn tsx scripts/skills-bench/build-slate.ts --seed jinn.skills-bench.v1 \
//          [--pool-size 60] [--out ../bench/slate/slate.json]
// Sources candidates the same way build-pilot-slate.ts does (HF monthly
// partitions → historical pool), then:
//   1. excludes every active cap-v0 held-out slate id (loadActiveHeldOutSlateIds),
//   2. dedupes to at most 2 instances per repo (independence: the cluster is the repo),
//   3. takes the seed-ranked first `pool-size` as candidates,
//   4. splitSlate({feedbackSize: 15, holdoutSize: 15}) and writes slate.json.
// Screening note (spec §2): instances here are already gradeable-screened by the
// validated-pool machinery this reuses; the smoke run (Task 9) is the final
// gradeability check before the slate is frozen by commit.

import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';

import { splitSlate, type SlateCandidate } from '../../src/skills-bench/slate.js';
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

interface Args {
  seed: string;
  poolSize: number;
  out: string;
}

function parseArgs(argv: string[]): Args {
  let seed = '';
  let poolSize = 60;
  let out = resolvePath(process.cwd(), '..', 'bench', 'slate', 'slate.json');
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--seed') seed = String(argv[++index]);
    else if (arg === '--pool-size') poolSize = Number(argv[++index]);
    else if (arg === '--out') out = resolvePath(String(argv[++index]));
    else throw new Error(`unknown argument ${arg}`);
  }
  if (!seed) throw new Error('--seed is required');
  if (!Number.isInteger(poolSize) || poolSize < FEEDBACK_SIZE + HOLDOUT_SIZE) {
    throw new Error(`--pool-size must be an integer >= ${FEEDBACK_SIZE + HOLDOUT_SIZE}`);
  }
  return { seed, poolSize, out };
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
 * Exclude held-out ids, drop repo-less rows (can't cluster-dedupe them), rank
 * by seed, then walk in rank order keeping at most 2 instances per repo —
 * this both dedupes and produces the seed-ranked ordering the CLI takes its
 * first `poolSize` candidates from in one pass.
 */
function selectCandidates(pool: PoolTask[], seed: string, poolSize: number): SlateCandidate[] {
  const excluded = loadActiveHeldOutSlateIds(SOLVER_TYPE, ACTIVE_HELD_OUT_SLATE_VERSIONS);
  const eligible = pool.filter((task) => !excluded.has(task.instance_id) && task.repo);
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
  const pool = await loadPool();
  const candidates = selectCandidates(pool, args.seed, args.poolSize);
  const slate = splitSlate(candidates, {
    seed: args.seed,
    feedbackSize: FEEDBACK_SIZE,
    holdoutSize: HOLDOUT_SIZE,
  });
  mkdirSync(dirname(args.out), { recursive: true });
  writeFileSync(args.out, JSON.stringify(slate, null, 2));
  console.log(`sha256=${slate.sha256} feedback=${slate.feedback.length} holdout=${slate.holdout.length}`);
  console.log(`wrote ${args.out}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
