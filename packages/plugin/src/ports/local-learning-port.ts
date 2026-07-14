import type { PortResult } from '../outcome.js';

export interface LocalLearningRun {
  runId: string;
  state: 'pending' | 'running' | 'done' | 'failed';
}

export interface LocalLearningPort {
  run(input: { episodeIds: string[] }): Promise<PortResult<{ runId: string }>>;
  status(runId: string): Promise<PortResult<LocalLearningRun>>;
  list(): Promise<PortResult<LocalLearningRun[]>>;
}
