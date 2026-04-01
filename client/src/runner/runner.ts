import type { DesiredState, RestorationResult, RequestId } from '../types/index.js';

export interface RunnerContext {
  requestId: RequestId;
  workingDirectory: string;
  timeoutMs: number;
  storePath?: string;
}

export interface Runner {
  run(desiredState: DesiredState, context: RunnerContext): Promise<RestorationResult>;
}
