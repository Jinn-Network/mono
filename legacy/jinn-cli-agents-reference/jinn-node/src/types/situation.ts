export const SITUATION_ARTIFACT_VERSION = "sit-enc-v1.1";

export interface SituationJob {
  requestId: string;
  jobDefinitionId?: string;
  jobName?: string;
  blueprint?: string;  // Blueprint-based job specification
  objective?: string;  // Legacy: extracted from prompt
  acceptanceCriteria?: string;  // Legacy: extracted from prompt
  prompt?: string;  // Legacy: pre-blueprint jobs
  model?: string;
  enabledTools?: string[];
}

export interface ExecutionTraceStep {
  tool: string;
  args: string;
  result_summary: string;
}

export interface SituationExecution {
  status: 'COMPLETED' | 'DELEGATING' | 'WAITING' | 'FAILED';
  trace: ExecutionTraceStep[];
  finalOutputSummary: string;
}

export interface SituationContext {
  parentRequestId?: string;
  parent?: {
    requestId?: string;
    jobDefinitionId?: string;
  };
  childRequestIds?: string[];
  siblingRequestIds?: string[];
}

export interface SituationArtifactReference {
  topic: string;
  name: string;
  contentPreview?: string;
}

export interface SituationEmbedding {
  model: string;
  dim: number;
  vector: number[];
}

export interface Situation {
  version: typeof SITUATION_ARTIFACT_VERSION;
  job: SituationJob;
  execution?: SituationExecution;
  context: SituationContext;
  artifacts?: SituationArtifactReference[];
  embedding?: SituationEmbedding;
  meta?: Record<string, unknown>;
}

export interface SituationNodeEmbeddingRecord {
  nodeId: string;
  model: string;
  dim: number;
  vector: number[];
  summary?: string | null;
  meta?: Record<string, unknown>;
  updatedAt?: string;
}
