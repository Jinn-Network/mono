import { randomUUID } from 'node:crypto';
import { getAddress } from 'viem';
import type { ExecutionAdapter } from '../adapters/adapter.js';
import { emitEvent } from '../observability/emit-event.js';
import type { Store } from '../store/store.js';
import type { TaskPostRecord, TaskPostingPolicyType } from '../store/store.js';
import { TransientError, type Task } from '../types/index.js';
import type { TaskCandidate, TaskPostingPolicy } from './sources.js';

const GLOBAL_CREATOR_SCOPE = '__global__';
const POST_LOCK_STALE_AFTER_MS = 60_000;

export interface TaskPostResult {
  taskId: string;
  taskCid: string;
  txHash?: `0x${string}`;
  blockNumber?: number;
  task: Task;
  attemptNumber: number;
  attemptId: string;
  idempotent: boolean;
  source: 'store' | 'posted';
}

export interface PostTaskCandidateOptions {
  creatorSafeAddress?: string;
}

function normalizeCreatorSafeAddress(safeAddress?: string): string {
  return safeAddress ? getAddress(safeAddress) : GLOBAL_CREATOR_SCOPE;
}

function policyTypeOf(policy: TaskPostingPolicy): TaskPostingPolicyType {
  return policy.kind;
}

function scopeKeyOf(policy: TaskPostingPolicy): string {
  switch (policy.kind) {
    case 'once_per_safe':
      return '';
    case 'once_per_bucket':
      return policy.bucketKey;
    case 'interval':
      return policy.scopeKey ?? '';
  }
}

function shouldSkipPost(record: TaskPostRecord, policy: TaskPostingPolicy, nowMs: number): boolean {
  if (policy.kind !== 'interval') return true;
  const lastPostedAt = Date.parse(record.lastPostedAt);
  return Number.isFinite(lastPostedAt) && (nowMs - lastPostedAt) < policy.intervalMs;
}

export class TaskPostingService {
  constructor(
    private readonly adapter: ExecutionAdapter,
    private readonly store: Store,
  ) {}

  async postCandidate(
    candidate: TaskCandidate,
    opts: PostTaskCandidateOptions = {},
  ): Promise<TaskPostResult> {
    const creatorSafeAddress = normalizeCreatorSafeAddress(opts.creatorSafeAddress);
    const policyType = policyTypeOf(candidate.postingPolicy);
    const scopeKey = scopeKeyOf(candidate.postingPolicy);
    const now = new Date();
    const nowIso = now.toISOString();
    const nowMs = now.getTime();

    const existing = this.store.getTaskPostRecord({
      creatorSafeAddress,
      sourceKey: candidate.sourceKey,
      policyType,
      scopeKey,
    });
    if (existing && shouldSkipPost(existing, candidate.postingPolicy, nowMs)) {
      return this.buildIdempotentResult(candidate, existing, 'store');
    }

    const ownerToken = randomUUID();
    const lockAcquired = this.store.acquireTaskPostLock({
      creatorSafeAddress,
      sourceKey: candidate.sourceKey,
      policyType,
      scopeKey,
      ownerToken,
      lockedAt: nowIso,
      staleAfterMs: POST_LOCK_STALE_AFTER_MS,
    });
    if (!lockAcquired) {
      throw new TransientError(
        `Task post already in progress for ${candidate.sourceKey} (${candidate.task.id})`,
      );
    }

    try {
      const lockedExisting = this.store.getTaskPostRecord({
        creatorSafeAddress,
        sourceKey: candidate.sourceKey,
        policyType,
        scopeKey,
      });
      if (lockedExisting && shouldSkipPost(lockedExisting, candidate.postingPolicy, nowMs)) {
        return this.buildIdempotentResult(candidate, lockedExisting, 'store');
      }

      const previousPostCount = lockedExisting?.postCount ?? 0;
      const attemptNumber = previousPostCount + 1;
      const attemptId = `${candidate.task.id}/${attemptNumber}`;
      const task: Task = {
        ...candidate.task,
        role: 'restoration',
        attemptId,
        attemptNumber,
      };
      const posted = await this.adapter.postTask(task);

      this.store.recordOwnActivity(posted.taskId, 'created');
      emitEvent(this.store, {
        kind: 'task_posted',
        requestId: posted.taskId,
        solverType: candidate.task.solverType,
        outcome: 'ok',
        detail: `Posted task ${candidate.task.id} via ${candidate.sourceKey}`,
      }, 'creator');

      // ERC-8004 per-execution registration uses the operator-rooted entity model
      // (DR docs/superpowers/specs/2026-04-27-erc-8004-entity-model-design.md).
      this.store.upsertTaskPostRecord({
        creatorSafeAddress,
        sourceKey: candidate.sourceKey,
        policyType,
        scopeKey,
        taskId: candidate.task.id,
        requestId: posted.taskId,
        protocolTaskId: posted.taskId,
        taskCid: posted.taskCid,
        firstPostedAt: lockedExisting?.firstPostedAt ?? nowIso,
        lastPostedAt: nowIso,
        postCount: attemptNumber,
      });
      return {
        taskId: posted.taskId,
        taskCid: posted.taskCid,
        txHash: posted.txHash,
        blockNumber: posted.blockNumber,
        task,
        attemptNumber,
        attemptId,
        idempotent: false,
        source: 'posted',
      };
    } finally {
      this.store.releaseTaskPostLock({
        creatorSafeAddress,
        sourceKey: candidate.sourceKey,
        policyType,
        scopeKey,
        ownerToken,
      });
    }
  }

  private buildIdempotentResult(
    candidate: TaskCandidate,
    record: TaskPostRecord,
    source: 'store',
  ): TaskPostResult {
    const attemptNumber = Math.max(1, record.postCount);
    const attemptId = `${candidate.task.id}/${attemptNumber}`;
    return {
      taskId: record.protocolTaskId ?? record.requestId,
      taskCid: record.taskCid ?? '',
      task: {
        ...candidate.task,
        role: 'restoration',
        attemptId,
        attemptNumber,
      },
      attemptNumber,
      attemptId,
      idempotent: true,
      source,
    };
  }
}
