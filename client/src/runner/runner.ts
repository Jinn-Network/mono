import type { RestorationJob, RestorationResult, RequestId } from '../types/index.js';

export interface RunnerContext {
  requestId: RequestId;
  workingDirectory: string;
  timeoutMs: number;
  storePath?: string;
  daemonApiUrl?: string;
}

export interface Runner {
  run(restorationJob: RestorationJob, context: RunnerContext): Promise<RestorationResult>;
}
