import type { LocalLearningPort, LocalLearningRun } from '../ports/local-learning-port.js';
import { ok, unavailable } from '../outcome.js';

export class InMemoryLocalLearningPort implements LocalLearningPort {
  private readonly runs = new Map<string, LocalLearningRun>();
  private counter = 0;

  async run(_input: { episodeIds: string[] }) {
    this.counter += 1;
    const runId = `run-${this.counter}`;
    this.runs.set(runId, { runId, state: 'pending' });
    return ok({ runId });
  }

  async status(runId: string) {
    const run = this.runs.get(runId);
    if (!run) return unavailable(`no such run: ${runId}`);
    return ok(run);
  }

  async list() {
    return ok([...this.runs.values()]);
  }
}
