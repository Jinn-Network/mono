import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
// zod/v3, not zod: `JinnRepoMergedPrTaskSchema` is re-exported from the SDK's
// zod/v3-authored schema (see ./jinn-repo.ts), and `.extend()` needs its shape
// values to be zod/v3 ZodType instances to interop correctly with the base
// schema's zod/v3 ZodObject.
import { z } from 'zod/v3';
import { JinnRepoMergedPrTaskSchema } from './jinn-repo.js';

// Pool items are mined exclusively from merged PRs (see jinn-repo-extract.ts) —
// gold tests and a reference solution only exist retrospectively, so the pool
// item extends the merged-pr branch, never the live-issue branch.
// Pool item = the solver-visible task + evaluator-side secrets (gold tests, reference solution).
export const JinnRepoPoolItemSchema = JinnRepoMergedPrTaskSchema.extend({
  gold_tests: z.record(z.string(), z.string()),  // relpath -> file contents (evaluator-side)
  solution_patch: z.string(),                     // reference fix (admission only; never shown to solver)
});
export type JinnRepoPoolItem = z.infer<typeof JinnRepoPoolItemSchema>;

// What the solver harness is allowed to see. Leak-control: no gold tests, no solution.
export interface JinnRepoSolverView {
  schemaVersion: 'jinn-repo.v1';
  instance_id: string;
  repo: 'Jinn-Network/mono';
  base_commit: string;
  problem_statement: string;
}
export function solverView(item: JinnRepoPoolItem): JinnRepoSolverView {
  return {
    schemaVersion: item.schemaVersion,
    instance_id: item.instance_id,
    repo: item.repo,
    base_commit: item.base_commit,
    problem_statement: item.problem_statement,
  };
}

export function loadJinnRepoPool(opts: { path?: string } = {}): JinnRepoPoolItem[] {
  const path = opts.path ?? fileURLToPath(new URL('./jinn-repo-pool.json', import.meta.url));
  const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown[];
  return raw.map((r) => JinnRepoPoolItemSchema.parse(r));
}

export function resolveJinnRepoSlate(pool: JinnRepoPoolItem[], ids: Set<string>): JinnRepoPoolItem[] {
  return pool.filter((p) => ids.has(p.instance_id));
}
