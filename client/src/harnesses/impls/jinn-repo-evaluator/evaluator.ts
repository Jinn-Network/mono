import { runJinnRepoEval, type JinnRepoEvalResult } from './eval-runner.js';
import type { JinnRepoTask } from '../../../solver-types/jinn-repo.js';

type RunFn = (args: { task: JinnRepoTask; patch: string; monoRepoUrl: string }) => Promise<JinnRepoEvalResult>;

export class JinnRepoEvaluator {
  private readonly run: RunFn;
  private readonly monoRepoUrl: string;
  constructor(opts?: { run?: RunFn; monoRepoUrl?: string }) {
    this.run = opts?.run ?? runJinnRepoEval;
    this.monoRepoUrl = opts?.monoRepoUrl ?? 'https://github.com/Jinn-Network/mono.git';
  }
  async grade(args: { task: JinnRepoTask; solution: { patch: string } }): Promise<JinnRepoEvalResult> {
    return this.run({ task: args.task, patch: args.solution.patch, monoRepoUrl: this.monoRepoUrl });
  }
}
