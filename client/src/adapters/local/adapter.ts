import { randomUUID } from 'node:crypto';
import type { ExecutionAdapter } from '../adapter.js';
import type {
  Task,
  RequestId,
  PostedTask,
  TaskAnnouncement,
  TaskRequest,
  TaskResult,
  DeliveredResult,
} from '../../types/index.js';

export class LocalAdapter implements ExecutionAdapter {
  readonly name = 'local';

  private nextTaskId = 1;
  private tasks = new Map<string, TaskAnnouncement>();
  private requests = new Map<RequestId, TaskRequest>();
  private claimCounts = new Map<string, number>();
  private pendingTasks: TaskAnnouncement[] = [];
  private pendingDeliveries: DeliveredResult[] = [];
  private taskWaiters: Array<(task: TaskAnnouncement) => void> = [];
  private deliveryWaiters: Array<(del: DeliveredResult) => void> = [];
  private stopped = false;

  async initialize(): Promise<void> {
    // No-op for local
  }

  async postTask(state: Task): Promise<PostedTask> {
    const taskId = String(this.nextTaskId++);
    const restorationState: Task = {
      ...state,
      role: state.role ?? 'restoration',
    };
    const announcement: TaskAnnouncement = {
      taskId,
      task: restorationState,
      taskCid: `local-${taskId}`,
      onchainCreationTx: `0x${taskId.padStart(64, '0')}`,
      onchainCreationBlock: this.nextTaskId,
    };
    this.tasks.set(taskId, announcement);

    if (this.taskWaiters.length > 0) {
      this.taskWaiters.shift()!(announcement);
    } else {
      this.pendingTasks.push(announcement);
    }

    return {
      taskId,
      taskCid: announcement.taskCid ?? `local-${taskId}`,
      txHash: announcement.onchainCreationTx,
      blockNumber: announcement.onchainCreationBlock,
    };
  }

  async *watchForTasks(): AsyncIterable<TaskAnnouncement> {
    while (!this.stopped) {
      if (this.pendingTasks.length > 0) {
        yield this.pendingTasks.shift()!;
      } else {
        const task = await new Promise<TaskAnnouncement>((resolve) => {
          this.taskWaiters.push(resolve);
        });
        if (!this.stopped) yield task;
      }
    }
  }

  async claimTask(taskId: string): Promise<TaskRequest> {
    const announcement = this.tasks.get(taskId);
    if (!announcement) throw new Error(`Unknown task: ${taskId}`);

    const requestId = randomUUID();
    const attemptIndex = this.claimCounts.get(taskId) ?? 0;
    this.claimCounts.set(taskId, attemptIndex + 1);
    const request: TaskRequest = {
      requestId,
      taskId,
      attemptIndex,
      task: announcement.task,
      taskCid: announcement.taskCid,
      onchainCreationTx: announcement.onchainCreationTx,
      onchainCreationBlock: announcement.onchainCreationBlock,
    };
    this.requests.set(requestId, request);

    return request;
  }

  async submitResult(requestId: RequestId, result: TaskResult): Promise<void> {
    const request = this.requests.get(requestId);
    if (!request) throw new Error(`Unknown request: ${requestId}`);

    const delivery: DeliveredResult = {
      requestId,
      task: request.task,
      result,
      deliveryMechAddress: 'local',
    };

    if (this.deliveryWaiters.length > 0) {
      this.deliveryWaiters.shift()!(delivery);
    } else {
      this.pendingDeliveries.push(delivery);
    }

  }

  async *watchForDeliveries(): AsyncIterable<DeliveredResult> {
    while (!this.stopped) {
      if (this.pendingDeliveries.length > 0) {
        yield this.pendingDeliveries.shift()!;
      } else {
        const del = await new Promise<DeliveredResult>((resolve) => {
          this.deliveryWaiters.push(resolve);
        });
        if (!this.stopped) yield del;
      }
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const waiter of this.taskWaiters) {
      waiter({ taskId: '', task: { id: '', description: '' } });
    }
    for (const waiter of this.deliveryWaiters) {
      waiter({ requestId: '', task: { id: '', description: '' }, result: { data: '' }, deliveryMechAddress: '' });
    }
    this.taskWaiters = [];
    this.deliveryWaiters = [];
  }
}
