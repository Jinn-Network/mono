import { randomUUID } from 'node:crypto';
import { getAddress } from 'viem';
import type { ExecutionAdapter } from '../adapters/adapter.js';
import { emitEvent } from '../observability/emit-event.js';
import type { Store } from '../store/store.js';
import type { IntentPostRecord, IntentPostingPolicyType } from '../store/store.js';
import { TransientError, type DesiredState, type RequestId } from '../types/index.js';
import type { IntentCandidate, IntentPostingPolicy } from './sources.js';
import type { Registry8004 } from '../discovery/registry.js';

const GLOBAL_CREATOR_SCOPE = '__global__';
const POST_LOCK_STALE_AFTER_MS = 60_000;

export interface IntentPostResult {
  requestId: RequestId;
  desiredState: DesiredState;
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
    private readonly registry?: Registry8004,
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
        `Intent post already in progress for ${candidate.sourceKey} (${candidate.desiredState.id})`,
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
      const attemptId = `${candidate.desiredState.id}/${attemptNumber}`;
      const desiredState: DesiredState = {
        ...candidate.desiredState,
        type: 'restoration',
        attemptId,
        attemptNumber,
      };
      const requestId = await this.adapter.postDesiredState(desiredState);

      // ERC-8004 Intent registration (Plan E Task 10). Best-effort: a failure here
      // does NOT roll back the post. Registration fires only when a registry is
      // injected and the adapter surfaces the intent CID (IPFS-backed adapters only).
      if (this.registry && candidate.desiredState.spec?.kind) {
        const intentCid = this.adapter.getLastPostedIntentCid?.();
        if (intentCid) {
          const creator = opts.creatorSafeAddress
            ? getAddress(opts.creatorSafeAddress)
            : creatorSafeAddress === GLOBAL_CREATOR_SCOPE
              ? ''
              : creatorSafeAddress;
          try {
            await this.registry.registerIntent({
              intentCid,
              kind: candidate.desiredState.spec.kind,
              creator,
              createdAt: nowMs,
              requestId: requestId as `0x${string}`,
            });
          } catch (err) {
            // Registration is best-effort; a failure here should not prevent the
            // intent from being posted. Log + emit but don't throw.
            console.warn(`[posting-service] registerIntent failed: ${err instanceof Error ? err.message : err}`);
            emitEvent(this.store, {
              kind: 'intent_registry_failed',
              requestId,
              specKind: candidate.desiredState.spec?.kind,
              outcome: 'failed',
              detail: err instanceof Error ? err.message : String(err),
            }, 'creator');
          }
        }
      }

      this.store.recordOwnActivity(requestId, 'created');
      emitEvent(this.store, {
        kind: 'intent_posted',
        requestId,
        specKind: candidate.desiredState.spec?.kind,
        outcome: 'ok',
        detail: `Posted intent for desired state ${candidate.desiredState.id} via ${candidate.sourceKey}`,
      }, 'creator');
      this.store.upsertIntentPostRecord({
        creatorSafeAddress,
        sourceKey: candidate.sourceKey,
        policyType,
        scopeKey,
        desiredStateId: candidate.desiredState.id,
        requestId,
        firstPostedAt: lockedExisting?.firstPostedAt ?? nowIso,
        lastPostedAt: nowIso,
        postCount: attemptNumber,
      });
      return {
        requestId,
        desiredState,
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
        desiredStateId: candidate.desiredState.id,
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
    const attemptId = `${candidate.desiredState.id}/${attemptNumber}`;
    return {
      requestId: record.requestId,
      desiredState: {
        ...candidate.desiredState,
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
