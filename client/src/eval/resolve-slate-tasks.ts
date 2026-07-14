/**
 * Resolve a held-out slate's `instance_id`s into `SweRebenchV2Task` objects
 * for the `jinn eval` orchestrator (issue #818, AC#1).
 *
 * A slate stores only `instance_id`s (`_swe-rebench-v2-held-out-slate.ts`). The
 * evaluator grades against the full HuggingFace row, fetched by
 * `(hf_dataset, hf_split, instance_id)`. The `HfRow` does NOT echo
 * `hf_dataset`/`hf_split` (see `swe-rebench-v2-evaluator/index.ts`), so the
 * caller supplies the slate-level dataset+split as args; the resolver verifies
 * each id exists by fetching its row and returns the `{ task, row }` pair so the
 * orchestrator reuses the row at grade time (avoids a second fetch).
 *
 * No retry logic here — `HttpHfFetcher` owns retries. A fetcher throw for any id
 * propagates loudly (a missing slate instance is a hard error, never a silent
 * drop).
 */

import { SweRebenchV2LanguageSchema, SweRebenchV2TaskSchema, type SweRebenchV2Task } from '@jinn-network/sdk/solvernets/swe-rebench-v2';
import type { HfFetcher, HfRow } from '../harnesses/impls/swe-rebench-v2-evaluator/index.js';
import type { PoolTask } from '../solver-types/_swe-rebench-v2-pool.js';

export interface ResolvedSlateTask {
  task: SweRebenchV2Task;
  row: HfRow;
}

export async function resolveSlateTasks(args: {
  /**
   * The pool tasks for this slate group, each carrying the real
   * `problem_statement` / `base_commit` / `language` the agent run needs to
   * solve the instance (the slate stores only ids; the pool is the source of
   * these fields).
   */
  poolTasks: PoolTask[];
  hf_dataset: string;
  hf_split: string;
  fetcher: HfFetcher;
}): Promise<ResolvedSlateTask[]> {
  const tasks = [...args.poolTasks].sort((a, b) => a.instance_id.localeCompare(b.instance_id));
  const out: ResolvedSlateTask[] = [];
  for (const poolTask of tasks) {
    const row = await args.fetcher.fetchTaskRow({
      hf_dataset: args.hf_dataset,
      hf_split: args.hf_split,
      instance_id: poolTask.instance_id,
    });
    out.push({ task: buildTask(poolTask, args.hf_dataset, args.hf_split, row), row });
  }
  return out;
}

/**
 * Construct the `SweRebenchV2Task` the orchestrator hands to the harness +
 * evaluator. The agent run needs the real `problem_statement` (what to solve)
 * and `base_commit` (the repo state to check out) — these are threaded through
 * from the pool task (the generator's mapping in `swe-rebench-v2.ts`).
 * `hf_dataset`/`hf_split` are the evaluator's row-fetch key; `repo` comes from
 * the fetched row. A pool task missing an optional field falls back the same
 * way the generator does, so the object stays schema-valid.
 */
function buildTask(
  poolTask: PoolTask,
  hf_dataset: string,
  hf_split: string,
  row: HfRow,
): SweRebenchV2Task {
  const language = SweRebenchV2LanguageSchema.safeParse(poolTask.language);
  return {
    schemaVersion: 'swe-rebench-v2.v1',
    instance_id: poolTask.instance_id,
    repo: row.repo,
    base_commit: poolTask.base_commit ?? '0'.repeat(40),
    language: language.success ? language.data : 'python',
    problem_statement: poolTask.problem_statement ?? '',
    interface: poolTask.interface ?? '',
    hf_dataset,
    hf_split,
    deadline_unix: 1,
    round_month: hf_split.replace('_', '-'),
  };
}
