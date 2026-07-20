import { runJinnRepoEval, type JinnRepoEvalResult } from './eval-runner.js';
// Retrospective-only: this evaluator grades against merged-PR gold tests.
import type { JinnRepoMergedPrTask } from '../../../solver-types/jinn-repo.js';
import type { JinnRepoPoolItem } from '../../../solver-types/_jinn-repo-pool.js';

type RunFn = (args: { task: JinnRepoMergedPrTask; patch: string; monoRepoUrl: string; goldTests: Record<string, string> }) => Promise<JinnRepoEvalResult>;

export class JinnRepoEvaluator {
  private readonly run: RunFn;
  private readonly monoRepoUrl: string;
  constructor(opts?: { run?: RunFn; monoRepoUrl?: string }) {
    this.run = opts?.run ?? runJinnRepoEval;
    // Resolution order: explicit opt > JINN_MONO_REPO_URL env > GitHub https.
    // The env override lets the evaluator clone from a fast local `file://`
    // checkout in tests/e2e while production defaults to the public GitHub URL.
    this.monoRepoUrl =
      opts?.monoRepoUrl ??
      process.env['JINN_MONO_REPO_URL'] ??
      'https://github.com/Jinn-Network/mono.git';
  }
  async grade(args: { task: JinnRepoPoolItem; solution: { patch: string } }): Promise<JinnRepoEvalResult> {
    return this.run({ task: args.task, patch: args.solution.patch, monoRepoUrl: this.monoRepoUrl, goldTests: args.task.gold_tests });
  }
}
