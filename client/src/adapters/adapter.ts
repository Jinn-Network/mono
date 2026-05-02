import type {
  Task,
  RequestId,
  TaskRequest,
  TaskResult,
  DeliveredResult,
} from '../types/index.js';

export interface TaskPostReceipt {
  /** TaskCoordinator task id when posting through the Task-first lifecycle. */
  taskId?: string;
  /** Legacy/restoration marketplace request id, present only on request-first adapters. */
  requestId?: RequestId;
  taskCid?: string;
  txHash?: `0x${string}`;
}

export interface ExecutionAdapter {
  readonly name: string;

  initialize(): Promise<void>;

  // Creator
  postTask(state: Task): Promise<RequestId | TaskPostReceipt>;

  /**
   * Optional: returns the IPFS CID of the most recently posted Task payload.
   * Populated by adapters that upload to IPFS as part of `postTask`
   * (e.g. MechAdapter). Used by the posting service for ERC-8004 registration.
   * Returns undefined for adapters that do not upload (e.g. LocalAdapter).
   */
  getLastPostedTaskCid?(): string | undefined;

  // Harness
  watchForRequests(): AsyncIterable<TaskRequest>;
  claimRequest(requestId: RequestId): Promise<void>;
  submitResult(requestId: RequestId, result: TaskResult): Promise<void>;

  // Deliveries
  watchForDeliveries(): AsyncIterable<DeliveredResult>;

  // Lifecycle
  stop(): Promise<void>;
}

export interface TaskFirstExecutionAdapter extends ExecutionAdapter {
  watchForTasks(): AsyncIterable<Task>;
  claimTask(taskId: string): Promise<TaskRequest & {
    taskId: string;
    attemptIndex: number;
    alreadyClaimed: true;
  }>;
}

export function isTaskFirstExecutionAdapter(adapter: ExecutionAdapter): adapter is TaskFirstExecutionAdapter {
  const candidate = adapter as Partial<TaskFirstExecutionAdapter>;
  return typeof candidate.watchForTasks === 'function' && typeof candidate.claimTask === 'function';
}
