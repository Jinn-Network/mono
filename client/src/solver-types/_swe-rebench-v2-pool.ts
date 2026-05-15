/**
 * Historical pool builder for the swe-rebench-v2 task generator. Pulls
 * monthly partitions from `nebius/SWE-rebench-leaderboard` via the HF
 * datasets-server API and aggregates them into a deduplicated task pool.
 *
 * Spec: docs/superpowers/specs/2026-05-06-agent-harness-solvernet-design.md §3.6
 * DR: log/decisions/2026-05-06-task-generator-success-cap.md
 */

import { request } from 'node:https';

export interface PoolTask {
  instance_id: string;
  hf_dataset: string;
  hf_split: string;
  repo?: string;
  base_commit?: string;
  language?: string;
  problem_statement?: string;
  interface?: string;
  patch?: string;
  test_patch?: string;
  meta?: { num_modified_files?: number; num_modified_lines?: number };
}

/** Filter dataset split names to only the YYYY_MM monthly partitions. */
export function listMonthlyPartitions(splits: string[]): string[] {
  return splits
    .filter((s) => /^\d{4}_\d{2}$/.test(s))
    .sort();
}

export interface BuildPoolArgs {
  months: string[];
  fetchSplit: (split: string) => Promise<Array<{
    instance_id: string;
    repo?: string;
    base_commit?: string;
    language?: string;
    problem_statement?: string;
    interface?: string;
    patch?: string;
    test_patch?: string;
    meta?: any;
  }>>;
}

/**
 * Build a deduplicated historical pool. Tasks appearing in multiple
 * partitions are kept only from the earliest partition (first-seen wins).
 */
export async function buildHistoricalPool(args: BuildPoolArgs): Promise<PoolTask[]> {
  const seen = new Set<string>();
  const pool: PoolTask[] = [];
  for (const split of args.months) {
    const rows = await args.fetchSplit(split);
    for (const row of rows) {
      if (seen.has(row.instance_id)) continue;
      seen.add(row.instance_id);
      pool.push({
        instance_id: row.instance_id,
        hf_dataset: 'nebius/SWE-rebench-leaderboard',
        hf_split: split,
        repo: row.repo,
        base_commit: row.base_commit,
        language: row.language,
        problem_statement: row.problem_statement,
        interface: row.interface,
        patch: row.patch,
        test_patch: row.test_patch,
        meta: row.meta,
      });
    }
  }
  return pool;
}

/** HTTP fetcher for HF datasets-server rows API. Use as fetchSplit in production. */
export async function fetchHfSplit(args: { dataset: string; split: string; limit?: number }): Promise<any[]> {
  const url = new URL('https://datasets-server.huggingface.co/rows');
  url.searchParams.set('dataset', args.dataset);
  url.searchParams.set('config', 'default');
  url.searchParams.set('split', args.split);
  url.searchParams.set('offset', '0');
  url.searchParams.set('length', String(args.limit ?? 100));
  return new Promise((resolve, reject) => {
    const req = request(url, { method: 'GET' }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          resolve((parsed.rows ?? []).map((r: any) => r.row));
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}
