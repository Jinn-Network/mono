import { runJinnRepoEval, type JinnRepoEvalResult } from './eval-runner.js';
import type { JinnRepoTask } from '../../../solver-types/jinn-repo.js';
import type { JinnRepoPoolItem } from '../../../solver-types/_jinn-repo-pool.js';

type RunFn = (args: { task: JinnRepoTask; patch: string; monoRepoUrl: string; goldTests: Record<string, string> }) => Promise<JinnRepoEvalResult>;

export class JinnRepoEvaluator {
  private readonly run: RunFn;
  private readonly monoRepoUrl: string;
  constructor(opts?: { run?: RunFn; monoRepoUrl?: string }) {
    this.run = opts?.run ?? runJinnRepoEval;
    this.monoRepoUrl = opts?.monoRepoUrl ?? 'https://github.com/Jinn-Network/mono.git';
  }
  async grade(args: { task: JinnRepoPoolItem; solution: { patch: string } }): Promise<JinnRepoEvalResult> {
    return this.run({ task: args.task, patch: args.solution.patch, monoRepoUrl: this.monoRepoUrl, goldTests: args.task.gold_tests });
  }
}
