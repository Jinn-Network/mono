import { describe, expect, it, vi } from 'vitest';
import { LocalAdapter } from '../../src/adapters/local/adapter.js';
import { IntentPostingService } from '../../src/intents/posting-service.js';
import { withTempStore } from '@test/store.js';
import { TransientError } from '../../src/types/index.js';
import type { Registry8004 } from '../../src/discovery/registry.js';

const SAFE_A = '0x00112233445566778899aabbccddeeff00112233';
const SAFE_B = '0x1111222233334444555566667777888899990000';

/** Adapter stub that exposes getLastPostedIntentCid() for registry tests. */
function makeAdapterWithIntentCid(intentCid: string): LocalAdapter & { getLastPostedIntentCid(): string } {
  const adapter = new LocalAdapter();
  (adapter as LocalAdapter & { getLastPostedIntentCid(): string }).getLastPostedIntentCid = () => intentCid;
  return adapter as LocalAdapter & { getLastPostedIntentCid(): string };
}

describe('IntentPostingService', () => {
  it('returns the same request id for repeated manual submissions from the same Safe', async () => {
    await withTempStore(async (store) => {
      const adapter = new LocalAdapter();
      await adapter.initialize();
      const service = new IntentPostingService(adapter, store);

      const postSpy = vi.spyOn(adapter, 'postDesiredState');
      const candidate = {
        desiredState: { id: 'manual-1', description: 'test manual submission' },
        sourceKey: 'manual:manual-1',
        postingPolicy: { kind: 'once_per_safe' } as const,
      };

      const first = await service.postCandidate(candidate, { creatorSafeAddress: SAFE_A });
      const second = await service.postCandidate(candidate, { creatorSafeAddress: SAFE_A });

      expect(first.idempotent).toBe(false);
      expect(second.idempotent).toBe(true);
      expect(second.requestId).toBe(first.requestId);
      expect(postSpy).toHaveBeenCalledTimes(1);

      await adapter.stop();
    });
  });

  it('migrates legacy config keys into intent_posts on first lookup', async () => {
    await withTempStore(async (store) => {
      const adapter = new LocalAdapter();
      await adapter.initialize();
      const service = new IntentPostingService(adapter, store);

      store.setConfigValue(`cli_intent:${SAFE_A}:manual-legacy`, 'legacy-request-id');

      const postSpy = vi.spyOn(adapter, 'postDesiredState');
      const result = await service.postCandidate(
        {
          desiredState: { id: 'manual-legacy', description: 'legacy' },
          sourceKey: 'manual:manual-legacy',
          postingPolicy: { kind: 'once_per_safe' },
        },
        {
          creatorSafeAddress: SAFE_A,
          legacyConfigKeys: [`cli_intent:${SAFE_A}:manual-legacy`],
        },
      );

      expect(result.idempotent).toBe(true);
      expect(result.requestId).toBe('legacy-request-id');
      expect(postSpy).not.toHaveBeenCalled();
      expect(store.getIntentPostRecord({
        creatorSafeAddress: '0x00112233445566778899AABbCCdDeeFf00112233',
        sourceKey: 'manual:manual-legacy',
        policyType: 'once_per_safe',
        scopeKey: '',
      })?.requestId).toBe('legacy-request-id');

      await adapter.stop();
    });
  });

  it('scopes idempotency by creator Safe', async () => {
    await withTempStore(async (store) => {
      const adapter = new LocalAdapter();
      await adapter.initialize();
      const service = new IntentPostingService(adapter, store);

      const postSpy = vi.spyOn(adapter, 'postDesiredState');
      const candidate = {
        desiredState: { id: 'shared-id', description: 'same logical id' },
        sourceKey: 'manual:shared-id',
        postingPolicy: { kind: 'once_per_safe' } as const,
      };

      const first = await service.postCandidate(candidate, { creatorSafeAddress: SAFE_A });
      const second = await service.postCandidate(candidate, { creatorSafeAddress: SAFE_B });

      expect(first.requestId).not.toBe(second.requestId);
      expect(postSpy).toHaveBeenCalledTimes(2);

      await adapter.stop();
    });
  });

  it('prevents concurrent callers from double-posting the same candidate', async () => {
    await withTempStore(async (store) => {
      const adapter = new LocalAdapter();
      await adapter.initialize();
      const service = new IntentPostingService(adapter, store);

      let releasePost: (() => void) | null = null;
      const postingGate = new Promise<void>((resolve) => {
        releasePost = resolve;
      });

      const postSpy = vi.spyOn(adapter, 'postDesiredState').mockImplementation(async (state) => {
        await postingGate;
        return `req-${state.id}`;
      });

      const candidate = {
        desiredState: { id: 'race-1', description: 'race test' },
        sourceKey: 'manual:race-1',
        postingPolicy: { kind: 'once_per_safe' } as const,
      };

      const first = service.postCandidate(candidate, { creatorSafeAddress: SAFE_A });
      await Promise.resolve();

      await expect(
        service.postCandidate(candidate, { creatorSafeAddress: SAFE_A }),
      ).rejects.toBeInstanceOf(TransientError);

      releasePost?.();
      const firstResult = await first;
      expect(firstResult.idempotent).toBe(false);
      expect(firstResult.requestId).toBe('req-race-1');
      expect(postSpy).toHaveBeenCalledTimes(1);

      await adapter.stop();
    });
  });

  // ── ERC-8004 Intent Registration (Plan E Task 10) ────────────────────────────

  it('calls registerIntent after a successful post when registry is injected', async () => {
    await withTempStore(async (store) => {
      const adapter = makeAdapterWithIntentCid('bafy-intent-test-cid');
      await adapter.initialize();

      const registerIntentMock = vi.fn().mockResolvedValue(1n);
      const mockRegistry = { registerIntent: registerIntentMock } as unknown as Registry8004;

      const service = new IntentPostingService(adapter, store, mockRegistry);

      const candidate = {
        desiredState: {
          id: 'reg-1',
          description: 'test registration',
          spec: { kind: 'portfolio.v0' },
        },
        sourceKey: 'manual:reg-1',
        postingPolicy: { kind: 'once_per_safe' } as const,
      };

      const result = await service.postCandidate(candidate, { creatorSafeAddress: SAFE_A });
      expect(result.idempotent).toBe(false);

      expect(registerIntentMock).toHaveBeenCalledTimes(1);
      expect(registerIntentMock).toHaveBeenCalledWith(
        expect.objectContaining({
          intentCid: 'bafy-intent-test-cid',
          kind: 'portfolio.v0',
          requestId: result.requestId,
        }),
      );

      await adapter.stop();
    });
  });

  it('does NOT call registerIntent when adapter does not expose getLastPostedIntentCid', async () => {
    await withTempStore(async (store) => {
      // LocalAdapter without the method — intentCid is undefined → registration skipped
      const adapter = new LocalAdapter();
      await adapter.initialize();

      const registerIntentMock = vi.fn().mockResolvedValue(1n);
      const mockRegistry = { registerIntent: registerIntentMock } as unknown as Registry8004;

      const service = new IntentPostingService(adapter, store, mockRegistry);

      const candidate = {
        desiredState: {
          id: 'no-cid-1',
          description: 'no cid adapter',
          spec: { kind: 'portfolio.v0' },
        },
        sourceKey: 'manual:no-cid-1',
        postingPolicy: { kind: 'once_per_safe' } as const,
      };

      await service.postCandidate(candidate, { creatorSafeAddress: SAFE_A });
      // registerIntent must NOT be called when no intentCid is available
      expect(registerIntentMock).not.toHaveBeenCalled();

      await adapter.stop();
    });
  });

  it('post succeeds even when registerIntent throws (best-effort)', async () => {
    await withTempStore(async (store) => {
      const adapter = makeAdapterWithIntentCid('bafy-failing-cid');
      await adapter.initialize();

      const registerIntentMock = vi.fn().mockRejectedValue(new Error('registry down'));
      const mockRegistry = { registerIntent: registerIntentMock } as unknown as Registry8004;

      const service = new IntentPostingService(adapter, store, mockRegistry);

      const candidate = {
        desiredState: {
          id: 'fail-reg-1',
          description: 'registry will fail',
          spec: { kind: 'portfolio.v0' },
        },
        sourceKey: 'manual:fail-reg-1',
        postingPolicy: { kind: 'once_per_safe' } as const,
      };

      // Should NOT throw despite registry failure
      const result = await service.postCandidate(candidate, { creatorSafeAddress: SAFE_A });
      expect(result.idempotent).toBe(false);
      expect(result.requestId).toBeTruthy();

      // registerIntent was attempted
      expect(registerIntentMock).toHaveBeenCalledTimes(1);

      await adapter.stop();
    });
  });
});
