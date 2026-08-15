/**
 * Solve-side pilot instance fields. The grader's `HfRow` (swe-rebench-v2-evaluator/hf-fetcher.ts)
 * omits `base_commit` and `problem_statement` — this parses those out of the raw HF row.
 */
import {
  fetchHfWithRetry,
  type FetchHfWithRetryOptions,
} from '../harnesses/impls/swe-rebench-v2-evaluator/hf-fetcher.js';

export interface PilotInstance {
  instance_id: string;
  repo: string;
  base_commit: string;
  problem_statement: string;
  /** SWE-rebench-V2 acceptance spec (the API contract the solution must satisfy).
   *  Optional — fed to BOTH arms when present so it never biases the comparison;
   *  it is the *spec*, not the hidden test (feeding the test would be cheating). */
  interface?: string;
  hf_dataset: string;
  hf_split: string;
}

export function parsePilotInstanceRow(
  row: Record<string, unknown>,
  ctx: { hf_dataset: string; hf_split: string },
): PilotInstance {
  const s = (k: string): string => {
    const v = row[k];
    if (typeof v !== 'string' || !v) throw new Error(`pilot instance row missing '${k}'`);
    return v;
  };
  const iface = typeof row['interface'] === 'string' && row['interface'] ? (row['interface'] as string) : undefined;
  return {
    instance_id: s('instance_id'),
    repo: s('repo'),
    base_commit: s('base_commit'),
    problem_statement: s('problem_statement'),
    ...(iface ? { interface: iface } : {}),
    hf_dataset: ctx.hf_dataset,
    hf_split: ctx.hf_split,
  };
}

export async function fetchPilotRawRow(
  ref: { instance_id: string; hf_dataset: string; hf_split: string },
  retryOptions: FetchHfWithRetryOptions = {},
): Promise<Record<string, unknown>> {
  const pageSize = 100;
  let offset = 0;
  const maxRows = 1000;
  while (offset < maxRows) {
    const url = new URL('https://datasets-server.huggingface.co/rows');
    url.searchParams.set('dataset', ref.hf_dataset);
    url.searchParams.set('config', 'default');
    url.searchParams.set('split', ref.hf_split);
    url.searchParams.set('offset', String(offset));
    url.searchParams.set('length', String(pageSize));
    const res = await fetchHfWithRetry(url.toString(), retryOptions);
    if (!res.ok) {
      throw Object.assign(
        new Error(`HF datasets-server returned ${res.status} for ${ref.hf_dataset}/${ref.hf_split}`),
        { httpStatus: res.status },
      );
    }
    const body = (await res.json()) as { rows?: Array<{ row?: Record<string, unknown> }> };
    const rows = (body.rows ?? []).map((wrapper) => wrapper.row ?? {});
    if (rows.length === 0) break;
    for (const row of rows) {
      if (row['instance_id'] === ref.instance_id) return row;
    }
    if (rows.length < pageSize) break;
    offset += rows.length;
  }
  throw new Error(`instance_id ${ref.instance_id} not found in ${ref.hf_dataset}/${ref.hf_split}`);
}
