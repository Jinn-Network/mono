import type { PoolTask } from '../solver-types/_swe-rebench-v2-pool.js';

/** Stratification / diversity key: the org prefix of an instance_id
 *  (`tobymao__sqlglot-4661` → `tobymao`). Derivable without an HF fetch. */
export function repoOf(task: PoolTask): string {
  const idx = task.instance_id.indexOf('__');
  return idx === -1 ? task.instance_id : task.instance_id.slice(0, idx);
}

/**
 * Order candidates round-robin across repos so the first N base-fails span
 * repos rather than clumping in alphabetically-early ones. Deterministic:
 * instances sort by instance_id within each repo group; repo groups iterate in
 * sorted repo order.
 */
export function stratifyByRepo(pool: PoolTask[]): PoolTask[] {
  const groups = new Map<string, PoolTask[]>();
  for (const task of pool) {
    const repo = repoOf(task);
    (groups.get(repo) ?? groups.set(repo, []).get(repo)!).push(task);
  }
  const repos = [...groups.keys()].sort((a, b) => a.localeCompare(b));
  for (const repo of repos) {
    groups.get(repo)!.sort((a, b) => a.instance_id.localeCompare(b.instance_id));
  }
  const out: PoolTask[] = [];
  let added = true;
  for (let i = 0; added; i++) {
    added = false;
    for (const repo of repos) {
      const g = groups.get(repo)!;
      if (i < g.length) {
        out.push(g[i]!);
        added = true;
      }
    }
  }
  return out;
}
