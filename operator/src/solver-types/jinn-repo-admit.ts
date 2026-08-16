import type { JinnRepoPoolItem } from './_jinn-repo-pool.js';
import type { JinnRepoEvalResult } from '../harnesses/impls/jinn-repo-evaluator/eval-runner.js';

type RunFn = (args: { task: JinnRepoPoolItem; patch: string; goldTests: Record<string, string>; monoRepoUrl: string }) => Promise<JinnRepoEvalResult>;

export interface AdmissionVerdict { admitted: boolean; reason: string; }

export async function validateAdmissible(
  item: JinnRepoPoolItem,
  deps: { run: RunFn; monoRepoUrl?: string },
): Promise<AdmissionVerdict> {
  const monoRepoUrl = deps.monoRepoUrl ?? 'https://github.com/Jinn-Network/mono.git';
  const common = { task: item, goldTests: item.gold_tests, monoRepoUrl };
  const withoutFix = await deps.run({ ...common, patch: '' });
  if (withoutFix.unscorable) return { admitted: false, reason: `unscorable without fix: ${withoutFix.logExcerpt}` };
  if (withoutFix.passed === true) return { admitted: false, reason: 'gold test PASSes without the fix — not FAIL_TO_PASS' };
  const withFix = await deps.run({ ...common, patch: item.solution_patch });
  if (withFix.unscorable) return { admitted: false, reason: `unscorable with fix: ${withFix.logExcerpt}` };
  if (withFix.passed !== true) return { admitted: false, reason: 'gold test FAILs even with the reference solution — not reproducible' };
  return { admitted: true, reason: 'FAIL_TO_PASS verified' };
}
