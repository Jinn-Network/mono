import { randomUUID } from 'node:crypto';
import { getAddress } from 'viem';
import type { ExecutionAdapter } from '../adapters/adapter.js';
import { emitEvent } from '../observability/emit-event.js';
import type { Store } from '../store/store.js';
import type { IntentPostRecord, IntentPostingPolicyType } from '../store/store.js';
import { TransientError, type RestorationJob, type RequestId } from '../types/index.js';
import type { IntentCandidate, IntentPostingPolicy } from './sources.js';

const GLOBAL_CREATOR_SCOPE = '__global__';
const POST_LOCK_STALE_AFTER_MS = 60_000;

export interface IntentPostResult {
  requestId: RequestId;
  restorationJob: RestorationJob;
  attemptNumber: number;
  attemptId: string;
  idempotent: boolean;
  source: 'store' | 'legacy_config' | 'posted';
}

export interface PostIntentCandidateOptions {
  creatorSafeAddress?: string;
  legacyConfigKeys?: string[];
}

function normalizeCreatorSafeAddress(safeAddress?: string): string {
  return safeAddress ? getAddress(safeAddress) : GLOBAL_CREATOR_SCOPE;
}

function policyTypeOf(policy: IntentPostingPolicy): IntentPostingPolicyType {
  return policy.kind;
}

function scopeKeyOf(policy: IntentPostingPolicy): string {
  switch (policy.kind) {
    case 'once_per_safe':
      return '';
    case 'once_per_bucket':
      return policy.bucketKey;
    case 'interval':
      return policy.scopeKey ?? '';
  }
}

function shouldSkipPost(record: IntentPostRecord, policy: IntentPostingPolicy, nowMs: number): boolean {
  if (policy.kind !== 'interval') return true;
  const lastPostedAt = Date.parse(record.lastPostedAt);
  return Number.isFinite(lastPostedAt) && (nowMs - lastPostedAt) < policy.intervalMs;
}

export class IntentPostingService {
  constructor(
    private readonly adapter: ExecutionAdapter,
    private readonly store: Store,
  ) {}

  async postCandidate(
    candidate: IntentCandidate,
    opts: PostIntentCandidateOptions = {},
  ): Promise<IntentPostResult> {
    const creatorSafeAddress = normalizeCreatorSafeAddress(opts.creatorSafeAddress);
    const policyType = policyTypeOf(candidate.postingPolicy);
    const scopeKey = scopeKeyOf(candidate.postingPolicy);
    const now = new Date();
    const nowIso = now.toISOString();
    const nowMs = now.getTime();

    const existing = this.store.getIntentPostRecord({
      creatorSafeAddress,
      sourceKey: candidate.sourceKey,
      policyType,
      scopeKey,
    });
    if (existing && shouldSkipPost(existing, candidate.postingPolicy, nowMs)) {
      return this.buildIdempotentResult(candidate, existing, 'store');
    }

    const migrated = this.tryImportLegacyRecord(candidate, {
      creatorSafeAddress,
      policyType,
      scopeKey,
      nowIso,
      legacyConfigKeys: opts.legacyConfigKeys ?? [],
    });
    if (migrated) {
      return this.buildIdempotentResult(candidate, migrated, 'legacy_config');
    }

    const ownerToken = randomUUID();
    const lockAcquired = this.store.acquireIntentPostLock({
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
        `Intent post already in progress for ${candidate.sourceKey} (${candidate.restorationJob.id})`,
      );
    }

    try {
      const lockedExisting = this.store.getIntentPostRecord({
        creatorSafeAddress,
        sourceKey: candidate.sourceKey,
        policyType,
        scopeKey,
      });
      if (lockedExisting && shouldSkipPost(lockedExisting, candidate.postingPolicy, nowMs)) {
        return this.buildIdempotentResult(candidate, lockedExisting, 'store');
      }

      const lockedMigrated = this.tryImportLegacyRecord(candidate, {
        creatorSafeAddress,
        policyType,
        scopeKey,
        nowIso,
        legacyConfigKeys: opts.legacyConfigKeys ?? [],
      });
      if (lockedMigrated) {
        return this.buildIdempotentResult(candidate, lockedMigrated, 'legacy_config');
      }

      const previousPostCount = lockedExisting?.postCount ?? 0;
      const attemptNumber = previousPostCount + 1;
      const attemptId = `${candidate.restorationJob.id}/${attemptNumber}`;
      const restorationJob: RestorationJob = {
        ...candidate.restorationJob,
        type: 'restoration',
        attemptId,
        attemptNumber,
      };
      const requestId = await this.adapter.postRestorationJob(restorationJob);

      this.store.recordOwnActivity(requestId, 'created');
      emitEvent(this.store, {
        kind: 'intent_posted',
        requestId,
        specKind: candidate.restorationJob.spec?.kind,
        outcome: 'ok',
        detail: `Posted intent for desired state ${candidate.restorationJob.id} via ${candidate.sourceKey}`,
      }, 'creator');

      // ERC-8004 per-execution registration is rebuilt under bead jinn-mono-3zk
      // against the operator-rooted entity model (DR
      // docs/superpowers/specs/2026-04-27-erc-8004-entity-model-design.md).
      // The previous per-CID registerIntent path was deleted with PR #37 cleanup.
      this.store.upsertIntentPostRecord({
        creatorSafeAddress,
        sourceKey: candidate.sourceKey,
        policyType,
        scopeKey,
        desiredStateId: candidate.restorationJob.id,
        requestId,
        firstPostedAt: lockedExisting?.firstPostedAt ?? nowIso,
        lastPostedAt: nowIso,
        postCount: attemptNumber,
      });
      return {
        requestId,
        restorationJob,
        attemptNumber,
        attemptId,
        idempotent: false,
        source: 'posted',
      };
    } finally {
      this.store.releaseIntentPostLock({
        creatorSafeAddress,
        sourceKey: candidate.sourceKey,
        policyType,
        scopeKey,
        ownerToken,
      });
    }
  }

  private tryImportLegacyRecord(
    candidate: IntentCandidate,
    args: {
      creatorSafeAddress: string;
      policyType: IntentPostingPolicyType;
      scopeKey: string;
      nowIso: string;
      legacyConfigKeys: string[];
    },
  ): IntentPostRecord | null {
    for (const key of args.legacyConfigKeys) {
      const requestId = this.store.getConfigValue(key);
      if (!requestId) continue;
      const record: IntentPostRecord = {
        creatorSafeAddress: args.creatorSafeAddress,
        sourceKey: candidate.sourceKey,
        policyType: args.policyType,
        scopeKey: args.scopeKey,
        desiredStateId: candidate.restorationJob.id,
        requestId,
        firstPostedAt: args.nowIso,
        lastPostedAt: args.nowIso,
        postCount: 1,
      };
      this.store.upsertIntentPostRecord(record);
      return record;
    }
    return null;
  }

  private buildIdempotentResult(
    candidate: IntentCandidate,
    record: IntentPostRecord,
    source: 'store' | 'legacy_config',
  ): IntentPostResult {
    const attemptNumber = Math.max(1, record.postCount);
    const attemptId = `${candidate.restorationJob.id}/${attemptNumber}`;
    return {
      requestId: record.requestId,
      restorationJob: {
        ...candidate.restorationJob,
        type: 'restoration',
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
