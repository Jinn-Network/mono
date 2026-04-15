/**
 * Shared types for worker modules
 * 
 * These types are used across orchestration, git, metadata, execution, and other worker subsystems.
 */

import type { CodeMetadata } from '../agent/shared/code_metadata.js';
import type { RecognitionPhaseResult } from './recognition_helpers.js';

/**
 * Final status inferred from execution telemetry and child job states
 */
export interface FinalStatus {
  status: 'COMPLETED' | 'DELEGATING' | 'WAITING' | 'FAILED';
  message: string;
}

/**
 * Execution summary extracted from agent output
 */
export interface ExecutionSummaryDetails {
  heading: string;
  lines: string[];
  text: string;
}

/**
 * Job in the hierarchy (from additionalContext.hierarchy array)
 */
export interface HierarchyJob {
  id?: string;
  requestId?: string;
  name?: string;
  jobName?: string;
  level?: number;
  status?: 'completed' | 'active' | 'failed' | 'delivered' | 'success' | 'error';
  jobId?: string;
  sourceJobDefinitionId?: string;
  summary?: string;
  deliverySummary?: string;
  /** Branch name where this child job worked (for parent review) */
  branchName?: string;
  /** Base branch the child branched from */
  baseBranch?: string;
  artifactRefs?: Array<{
    name?: string;
    topic?: string;
    cid: string;
    id?: string;
    type?: string;
    /** For GIT_BRANCH artifacts, contains headBranch/baseBranch */
    details?: {
      headBranch?: string;
      baseBranch?: string;
      diffSummary?: string;
    };
  }>;
  requestIds?: string[];
}

/**
 * Aggregated summary of job hierarchy
 */
export interface HierarchySummary {
  totalJobs: number;
  completedJobs: number;
  activeJobs: number;
  totalArtifacts?: number;
  hasErrors?: boolean;
}

/**
 * Work Protocol message structure
 */
export interface WorkProtocolMessage {
  content: string;
  to?: string;
  from?: string;
}

/**
 * Completed child run tracking for deterministic context
 */
export interface CompletedChildRun {
  requestId: string;
  artifacts?: Array<{
    cid?: string;
    id?: string;
  }>;
}

/**
 * Additional context structure attached to IPFS metadata
 * Contains job hierarchy, messages, and legacy compatibility fields
 */
export interface AdditionalContext {
  /** Work Protocol messaging */
  message?: WorkProtocolMessage | string;

  /** Job hierarchy information */
  hierarchy?: HierarchyJob[];

  /** Aggregated summary of job hierarchy */
  summary?: HierarchySummary;

  /** Backward compatibility: blueprint stored in additionalContext (prefer root-level) */
  blueprint?: string;

  /** Backward compatibility: dependencies stored here (prefer root-level) */
  dependencies?: string[];

  /** Additional context from parent jobs */
  objective?: string;
  acceptanceCriteria?: string;

  /** Completed child run tracking */
  completedChildRuns?: CompletedChildRun[];

  /** Verification phase: set when job needs to verify merged child work */
  verificationRequired?: boolean;

  /** Current verification attempt number (1-indexed) */
  verificationAttempt?: number;

  /** Timestamp when verification was triggered */
  verificationTriggeredAt?: string;

  /** Request ID that triggered verification */
  verificationSourceRequestId?: string;

  /** Merge conflicts from dependency branch sync - agent must resolve these */
  mergeConflicts?: Array<{
    /** The branch that was merged */
    branch: string;
    /** List of files with conflict markers */
    files: string[];
  }>;

  /**
   * Files that were stashed before checkout due to uncommitted changes from a previous failed job.
   * These changes are not part of the current branch and were set aside to allow checkout.
   */
  stashedChanges?: string[];

  /** Whether this job involves coding work (triggers coding standards assertion) */
  isCodingJob?: boolean;

  /** Loop recovery: set when job is re-dispatched after loop protection terminated previous run */
  loopRecovery?: {
    /** Current loop recovery attempt (1-indexed) */
    attempt: number;
    /** Message explaining what caused the loop */
    loopMessage: string;
    /** Timestamp when loop recovery was triggered */
    triggeredAt: string;
    /** Request ID of the run that was terminated due to loop */
    previousRequestId?: string;
  };

  /** Cycle: set when a cyclic job is re-dispatched for a new cycle */
  cycle?: {
    /** Whether this is a cycle run (as opposed to initial run) */
    isCycleRun: boolean;
    /** Current cycle number (1-indexed) */
    cycleNumber: number;
    /** Timestamp when the previous cycle completed */
    previousCycleCompletedAt?: string;
    /** Request ID of the previous cycle run */
    previousCycleRequestId?: string;
  };

  /**
   * Venture context for scheduled dispatches.
   * Contains venture-level invariants and last measurements.
   */
  ventureContext?: {
    ventureId: string;
    ventureName: string;
    ventureInvariants: Array<{
      id: string;
      type: 'FLOOR' | 'CEILING' | 'RANGE';
      metric: string;
      min?: number;
      max?: number;
      assessment: string;
    }>;
    lastMeasurements?: Array<{
      invariantId: string;
      type: string;
      value: number | boolean;
      passed: boolean;
      measuredAt: string;
    }>;
  };

  /**
   * Public environment variables to inject into the worker/agent process.
   * Only keys matching /^JINN_JOB_[A-Z0-9_]+$/ with string values are allowed.
   * Any invalid key/value causes job initialization to fail.
   * NOTE: Do NOT put secrets here (passwords, API keys) as this is stored on IPFS.
   */
  env?: Record<string, string>;

  /**
   * Optional repository to clone as the workspace for this job.
   * Used for multi-tenant products where each customer has their own repo.
   * Only applicable for root jobs; children inherit codeMetadata from parent.
   */
  workspaceRepo?: {
    /** Git repository URL (e.g., https://github.com/org/repo) */
    url: string;
    /** Branch to checkout (defaults to main/master) */
    branch?: string;
  };
}

/**
 * Unclaimed request from Ponder/on-chain
 */
export interface UnclaimedRequest {
  id: string;           // on-chain requestId (decimal string or 0x)
  mech: string;         // mech address (0x...) — the priority mech assigned to this request
  requester: string;    // requester address (0x...)
  workstreamId?: string; // workstream context for dependency resolution
  blockTimestamp?: number;
  ipfsHash?: string;
  delivered?: boolean;
  dependencies?: string[];  // request IDs that must be delivered first
  responseTimeout?: number; // absolute unix timestamp (seconds) after which any mech can deliver
  ventureId?: string;       // venture that owns this request (from Ponder)
}

/**
 * Fetched IPFS metadata payload
 * Note: blueprint is now the primary job specification (replaces legacy "prompt" field)
 */
export interface IpfsMetadata {
  blueprint?: string;  // Primary job specification
  enabledTools?: string[];
  tools?: Array<{ name: string; required?: boolean }>;
  sourceRequestId?: string;
  sourceJobDefinitionId?: string;
  workstreamId?: string;  // ID of the root job in the hierarchy
  additionalContext?: AdditionalContext;
  lineage?: {
    dispatcherRequestId?: string;
    dispatcherJobDefinitionId?: string;
    parentDispatcherRequestId?: string;
    dispatcherBranchName?: string;
    dispatcherBaseBranch?: string;
  };
  jobName?: string;
  jobDefinitionId?: string;
  codeMetadata?: CodeMetadata;
  model?: string;
  allowedModels?: string[];  // Cascaded model allowlist from blueprint/workstream
  recognition?: RecognitionPhaseResult | null;
  dependencies?: string[];  // Request IDs that must complete first
  /** Venture ID if job was dispatched from a venture schedule */
  ventureId?: string;
  /** Template ID if job was dispatched from a template */
  templateId?: string;
  /** OutputSpec for structured result extraction (passthrough from template) */
  outputSpec?: {
    schema: {
      type: 'object';
      properties: Record<string, { type: string; description?: string; items?: { type: string } }>;
      required?: string[];
    };
    mapping: Record<string, string>;
    transforms?: Record<string, { type: string; params?: Record<string, any> }>;
  };
  /** Whether this job operates cyclically (continuously re-dispatches after completion) */
  cyclic?: boolean;
}

/**
 * Agent execution result
 */
export interface AgentExecutionResult {
  output: string;
  structuredSummary?: string;
  jobInstanceStatusUpdate?: string;
  telemetry: any;
  delegated?: boolean;
  artifacts?: Array<{
    cid: string;
    topic: string;
    name?: string;
    type?: string;
    contentPreview?: string;
  }>;
  pullRequestUrl?: string;
}

/**
 * Transaction execution result (for EOA/Safe executors)
 */
export interface ExecutionResult {
  success: boolean;
  txHash?: string;
  errorCode?: string;
  errorMessage?: string;
}

/**
 * Git repository context
 */
export interface RepoContext {
  repoRoot: string;
  remoteUrl?: string;
  branchName?: string;
  baseBranch?: string;
}

/**
 * Git operation result
 */
export interface GitOperationResult {
  success: boolean;
  error?: string;
  branchCreated?: boolean;
  commitMade?: boolean;
  prUrl?: string | null;
}

/**
 * Job metadata combined with execution context
 */
export interface JobContext {
  requestId: string;
  request: UnclaimedRequest;
  metadata: IpfsMetadata;
  workerAddress: string;
}

/**
 * Delivery context for on-chain delivery
 */
export interface DeliveryContext {
  requestId: string;
  result: AgentExecutionResult;
  finalStatus: FinalStatus;
  metadata: IpfsMetadata;
  recognition?: RecognitionPhaseResult | null;
  reflection?: any;
  error?: any;
}

/**
 * Parent dispatch decision
 */
export interface ParentDispatchDecision {
  shouldDispatch: boolean;
  parentJobDefId?: string;
  reason?: string;
}

/**
 * Recognition result (re-exported from recognition_helpers)
 */
export type { RecognitionPhaseResult } from './recognition_helpers.js';

/**
 * Reflection result
 */
export interface ReflectionResult {
  output: string;
  telemetry: any;
  artifacts?: Array<{
    cid: string;
    topic: string;
  }>;
}

/**
 * Child job status from Ponder
 */
export interface ChildJobStatus {
  id: string;
  delivered: boolean;
}
