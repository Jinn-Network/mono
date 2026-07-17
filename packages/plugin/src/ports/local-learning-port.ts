import type { PortResult } from '../outcome.js';

export interface LocalLearningRun {
  runId: string;
  state: 'pending' | 'running' | 'done' | 'failed';
}

/** One locally distilled skill plus the sessions recorded in its provenance. */
export interface LocalLearningSkill {
  ref: string;
  sourceSessionIds: string[];
  state: 'staged' | 'installed';
}

export interface LocalLearningPort {
  run(input: { episodeIds: string[] }): Promise<PortResult<{ runId: string }>>;
  status(runId: string): Promise<PortResult<LocalLearningRun>>;
  list(): Promise<PortResult<LocalLearningRun[]>>;
  /** Optional for older adapters; history reports unavailable when absent. */
  skills?(): Promise<PortResult<LocalLearningSkill[]>>;
}
