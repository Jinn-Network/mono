import { randomUUID } from 'node:crypto';
import { getAddress } from 'viem';
import type { ExecutionAdapter } from '../adapters/adapter.js';
import { emitEvent } from '../observability/emit-event.js';
import type { Store } from '../store/store.js';
import type { TaskPostRecord, TaskPostingPolicyType } from '../store/store.js';
import { TransientError, type Task } from '../types/index.js';
import type { TaskCandidate, TaskPostingPolicy } from './sources.js';
import { canonicalJson } from '../harnesses/engine/canonical-json.js';

const GLOBAL_CREATOR_SCOPE = '__global__';
const POST_LOCK_STALE_AFTER_MS = 60_000;
const POST_LOCK_HEARTBEAT_MS = 20_000;

export interface TaskPostingServiceScheduler {
  now: () => Date;
  setInterval: (callback: () => void, intervalMs: number) => unknown;
  clearInterval: (handle: unknown) => void;
}

const DEFAULT_SCHEDULER: TaskPostingServiceScheduler = {
  now: () => new Date(),
  setInterval: (callback, intervalMs) => setInterval(callback, intervalMs),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

export interface TaskPostResult {
  taskId: string;
  taskCid: string;
  txHash?: `0x${string}`;
  blockNumber?: number;
  task: Task;
  attemptNumber: number;
  attemptId: string;
  idempotent: boolean;
  source: 'store' | 'posted' | 'recovered';
}

export interface PostTaskCandidateOptions {
  creatorSafeAddress?: string;
  beforeBroadcast?: () => void | Promise<void>;
  assertFunding?: (facts: {
    creatorSafe: string;
    solverNetManifestCid: string;
    proposedSpendWei: bigint;
  }) => void | Promise<void>;
  recoveryOnly?: boolean;
}

export class TaskPostOwnershipLostError extends TransientError {
  readonly name = 'TaskPostOwnershipLostError';
}

export class TaskPostBroadcastUncertainError extends TransientError {
  readonly name = 'TaskPostBroadcastUncertainError';

  constructor(
    readonly broadcastIntentAt: string,
    sourceKey: string,
  ) {
    super(
      `Task post ${sourceKey} has durable broadcast intent from ${broadcastIntentAt} ` +
      'but no matching TaskCreated event is visible; refusing to broadcast again',
    );
  }
}

export class TaskPostRecoveryOnlyError extends Error {
  readonly name = 'TaskPostRecoveryOnlyError';

  constructor(sourceKey: string) {
    super(
      `Task post ${sourceKey} has no existing immutable record that can be recovered; ` +
      'refusing recovery-only submission',
    );
  }
}

class TaskPostImmutableCandidateMismatchError extends Error {
  readonly name = 'TaskPostImmutableCandidateMismatchError';
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

function canonicalCandidateBytes(candidate: TaskCandidate): {
  canonicalTaskJson: string | null;
  requestJson: string | null;
} {
  return {
    canonicalTaskJson: candidate.task.signedTask
      ? canonicalJson(candidate.task.signedTask)
      : null,
    requestJson: candidate.sourceMeta?.request
      ? canonicalJson(candidate.sourceMeta.request)
      : null,
  };
}

function assertImmutableCandidate(
  candidate: TaskCandidate,
  record: TaskPostRecord,
  current: ReturnType<typeof canonicalCandidateBytes>,
): void {
  const immutableMachinePost = record.requestJson !== null || current.requestJson !== null;
  if (!immutableMachinePost) return;
  if (
    record.canonicalTaskJson !== current.canonicalTaskJson
    || record.requestJson !== current.requestJson
  ) {
    throw new TaskPostImmutableCandidateMismatchError(
      `Task post recovery content mismatch for ${candidate.sourceKey}; refusing to overwrite or broadcast different content`,
    );
  }
}

export class TaskPostingService {
  constructor(
    private readonly adapter: ExecutionAdapter,
    private readonly store: Store,
    private readonly scheduler: TaskPostingServiceScheduler = DEFAULT_SCHEDULER,
  ) {}

  async postCandidate(
    candidate: TaskCandidate,
    opts: PostTaskCandidateOptions = {},
  ): Promise<TaskPostResult> {
    const creatorSafeAddress = normalizeCreatorSafeAddress(opts.creatorSafeAddress);
    const policyType = policyTypeOf(candidate.postingPolicy);
    const scopeKey = scopeKeyOf(candidate.postingPolicy);
    const now = this.scheduler.now();
    const nowIso = now.toISOString();
    const nowMs = now.getTime();
    const immutableBytes = canonicalCandidateBytes(candidate);

    const existing = this.store.getTaskPostRecord({
      creatorSafeAddress,
      sourceKey: candidate.sourceKey,
      policyType,
      scopeKey,
    });
    if (
      opts.recoveryOnly
      && (
        !existing
        || existing.requestJson === null
        || candidate.task.signedTask === undefined
      )
    ) {
      throw new TaskPostRecoveryOnlyError(candidate.sourceKey);
    }
    if (opts.recoveryOnly && existing?.protocolTaskId) {
      assertImmutableCandidate(candidate, existing, immutableBytes);
      return this.buildIdempotentResult(candidate, existing, 'store');
    }
    if (existing?.protocolTaskId && shouldSkipPost(existing, candidate.postingPolicy, nowMs)) {
      assertImmutableCandidate(candidate, existing, immutableBytes);
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

    let lockLost = false;
    const heartbeat = immutableBytes.requestJson !== null
      ? this.scheduler.setInterval(() => {
        const renewed = this.store.renewTaskPostLock({
          creatorSafeAddress,
          sourceKey: candidate.sourceKey,
          policyType,
          scopeKey,
          ownerToken,
          lockedAt: this.scheduler.now().toISOString(),
        });
        if (!renewed) lockLost = true;
      }, POST_LOCK_HEARTBEAT_MS)
      : undefined;

    try {
      const lockedExisting = this.store.getTaskPostRecord({
        creatorSafeAddress,
        sourceKey: candidate.sourceKey,
        policyType,
        scopeKey,
      });
      if (
        opts.recoveryOnly
        && (
          !lockedExisting
          || lockedExisting.requestJson === null
          || candidate.task.signedTask === undefined
        )
      ) {
        throw new TaskPostRecoveryOnlyError(candidate.sourceKey);
      }
      if (lockedExisting?.protocolTaskId && shouldSkipPost(lockedExisting, candidate.postingPolicy, nowMs)) {
        assertImmutableCandidate(candidate, lockedExisting, immutableBytes);
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
      const { canonicalTaskJson, requestJson } = immutableBytes;
      const usesDurableBroadcastIntent =
        requestJson !== null && task.signedTask !== undefined;
      if (lockedExisting) assertImmutableCandidate(candidate, lockedExisting, immutableBytes);
      this.store.upsertTaskPostRecord({
        creatorSafeAddress,
        sourceKey: candidate.sourceKey,
        policyType,
        scopeKey,
        taskId: candidate.task.id,
        requestId: candidate.task.id,
        firstPostedAt: lockedExisting?.firstPostedAt ?? nowIso,
        lastPostedAt: lockedExisting?.lastPostedAt ?? nowIso,
        postCount: previousPostCount,
        canonicalTaskJson,
        requestJson,
      });

      if (lockedExisting && task.signedTask && this.adapter.recoverTaskPost) {
        const recovered = await this.adapter.recoverTaskPost({
          creatorSafeAddress,
          signedTask: task.signedTask,
          pendingTxHash: lockedExisting.creationTxHash ?? undefined,
        });
        if (recovered) {
          this.store.upsertTaskPostRecord({
            creatorSafeAddress,
            sourceKey: candidate.sourceKey,
            policyType,
            scopeKey,
            taskId: candidate.task.id,
            requestId: recovered.taskId,
            protocolTaskId: recovered.taskId,
            taskCid: recovered.taskCid,
            firstPostedAt: lockedExisting.firstPostedAt,
            lastPostedAt: nowIso,
            postCount: attemptNumber,
            canonicalTaskJson,
            requestJson,
            creationTxHash: recovered.txHash,
            creationBlockNumber: recovered.blockNumber,
          });
          return {
            ...recovered,
            task,
            attemptNumber,
            attemptId,
            idempotent: true,
            source: 'recovered',
          };
        }
      }
      if (
        lockedExisting?.broadcastIntentAt
        && lockedExisting.requestJson !== null
        && !lockedExisting.protocolTaskId
      ) {
        throw new TaskPostBroadcastUncertainError(
          lockedExisting.broadcastIntentAt,
          candidate.sourceKey,
        );
      }
      if (opts.recoveryOnly) {
        throw new TaskPostRecoveryOnlyError(candidate.sourceKey);
      }
      const stillOwnsPost = this.store.renewTaskPostLock({
        creatorSafeAddress,
        sourceKey: candidate.sourceKey,
        policyType,
        scopeKey,
        ownerToken,
        lockedAt: this.scheduler.now().toISOString(),
      });
      if (!stillOwnsPost) {
        throw new TransientError(
          `Task post ownership was lost before posting ${candidate.sourceKey}; refusing to broadcast`,
        );
      }
      const posted = await this.adapter.postTask(task, {
        assertFunding: opts.assertFunding,
        beforeBroadcast: async () => {
          await opts.beforeBroadcast?.();
          const intentAt = this.scheduler.now().toISOString();
          const stillOwnsBroadcast = usesDurableBroadcastIntent
            ? this.store.markTaskPostBroadcastIntent({
                creatorSafeAddress,
                sourceKey: candidate.sourceKey,
                policyType,
                scopeKey,
                ownerToken,
                lockedAt: intentAt,
                broadcastIntentAt: intentAt,
              })
            : this.store.renewTaskPostLock({
                creatorSafeAddress,
                sourceKey: candidate.sourceKey,
                policyType,
                scopeKey,
                ownerToken,
                lockedAt: intentAt,
              });
          lockLost = !stillOwnsBroadcast;
          if (!stillOwnsBroadcast) {
            throw new TaskPostOwnershipLostError(
              `Task post ownership was lost at the wallet boundary for ${candidate.sourceKey}; refusing to broadcast`,
            );
          }
        },
        onTransactionHash: async (txHash) => {
          this.store.upsertTaskPostRecord({
            creatorSafeAddress,
            sourceKey: candidate.sourceKey,
            policyType,
            scopeKey,
            taskId: candidate.task.id,
            requestId: candidate.task.id,
            firstPostedAt: lockedExisting?.firstPostedAt ?? nowIso,
            lastPostedAt: nowIso,
            postCount: previousPostCount,
            canonicalTaskJson,
            requestJson,
            creationTxHash: txHash,
          });
        },
      });
      if (lockLost) {
        throw new TransientError(
          `Task post ownership was lost while posting ${candidate.sourceKey}; reconciliation required`,
        );
      }

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
        canonicalTaskJson,
        requestJson,
        creationTxHash: posted.txHash,
        creationBlockNumber: posted.blockNumber,
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
      if (heartbeat !== undefined) this.scheduler.clearInterval(heartbeat);
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
      txHash: record.creationTxHash ?? undefined,
      blockNumber: record.creationBlockNumber ?? undefined,
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
