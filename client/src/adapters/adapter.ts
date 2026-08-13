import type {
  Task,
  RequestId,
  PostedTask,
  TaskAnnouncement,
  TaskRequest,
  TaskResult,
  DeliveredResult,
} from '../types/index.js';
import type { Hex } from 'viem';
import type { VerdictCode } from './mech/verdict-code.js';
import type { SignedTaskV1 } from '../types/task-document.js';

export interface RecoverTaskPostInput {
  creatorSafeAddress: string;
  signedTask: SignedTaskV1;
  pendingTxHash?: Hex;
}

export interface PostTaskOptions {
  beforeBroadcast?: () => void | Promise<void>;
  assertFunding?: (facts: {
    creatorSafe: string;
    solverNetManifestCid: string;
    proposedSpendWei: bigint;
  }) => void | Promise<void>;
  onTransactionHash?: (txHash: Hex) => void | Promise<void>;
}

export interface ExecutionAdapter {
  readonly name: string;

  initialize(): Promise<void>;

  // Creator
  postTask(state: Task, options?: PostTaskOptions): Promise<PostedTask>;
  recoverTaskPost?(input: RecoverTaskPostInput): Promise<PostedTask | null>;

  /**
   * Optional: returns the IPFS CID of the most recently posted Task payload.
   * Populated by adapters that upload to IPFS as part of `postTask`
   * (e.g. MechAdapter). Used by the posting service for ERC-8004 registration.
   * Returns undefined for adapters that do not upload (e.g. LocalAdapter).
   */
  getLastPostedTaskCid?(): string | undefined;

  // Harness
  watchForTasks(): AsyncIterable<TaskAnnouncement>;
  claimTask(taskId: string): Promise<TaskRequest>;
  submitResult(requestId: RequestId, result: TaskResult): Promise<void>;
  claimEvaluation?(
    taskId: string,
    attemptIndex: number,
    evaluationTaskCidDigest: Hex,
  ): Promise<{
    taskId: string;
    attemptIndex: number;
    verdictIndex: number;
    requestId: string;
    txHash: Hex;
    blockNumber?: number;
  }>;
  submitSolutionDelivery?(requestId: RequestId, solutionDigest: Hex): Promise<void>;
  submitVerdictDelivery?(requestId: RequestId, verdictDigest: Hex, verdictCode: VerdictCode): Promise<void>;

  // Deliveries
  watchForDeliveries(): AsyncIterable<DeliveredResult>;

  // Lifecycle
  stop(): Promise<void>;
}
