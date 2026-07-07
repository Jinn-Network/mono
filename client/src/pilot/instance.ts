/**
 * Solve-side pilot instance fields. The grader's `HfRow` (swe-rebench-v2-evaluator/hf-fetcher.ts)
 * omits `base_commit` and `problem_statement` — this parses those out of the raw HF row.
 */
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
