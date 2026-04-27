import type { RestorationJob, RestorationResult, RequestId } from '../types/index.js';
import type { TrajectoryCollector } from '../trajectory/index.js';

export interface RunnerContext {
  requestId: RequestId;
  workingDirectory: string;
  timeoutMs: number;
  storePath?: string;
  daemonApiUrl?: string;
  /**
   * In-run trajectory collector. When provided, the runner emits a
   * jinn.state_transition span wrapping the Claude subprocess lifetime.
   * Scope §3.2 traced-I/O boundary.
   */
  trajectory?: TrajectoryCollector;
}

export interface Runner {
  run(restorationJob: RestorationJob, context: RunnerContext): Promise<RestorationResult>;
}
