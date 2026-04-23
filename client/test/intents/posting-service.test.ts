import { describe, expect, it, vi } from 'vitest';
import { LocalAdapter } from '../../src/adapters/local/adapter.js';
import { IntentPostingService } from '../../src/intents/posting-service.js';
import { Store } from '../../src/store/store.js';
import { TransientError } from '../../src/types/index.js';

const SAFE_A = '0x00112233445566778899aabbccddeeff00112233';
const SAFE_B = '0x1111222233334444555566667777888899990000';

describe('IntentPostingService', () => {
  it('returns the same request id for repeated manual submissions from the same Safe', async () => {
    const adapter = new LocalAdapter();
    await adapter.initialize();
    const store = new Store(':memory:');
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

    store.close();
    await adapter.stop();
  });

  it('migrates legacy config keys into intent_posts on first lookup', async () => {
    const adapter = new LocalAdapter();
    await adapter.initialize();
    const store = new Store(':memory:');
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

    store.close();
    await adapter.stop();
  });

  it('scopes idempotency by creator Safe', async () => {
    const adapter = new LocalAdapter();
    await adapter.initialize();
    const store = new Store(':memory:');
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

    store.close();
    await adapter.stop();
  });

  it('prevents concurrent callers from double-posting the same candidate', async () => {
    const adapter = new LocalAdapter();
    await adapter.initialize();
    const store = new Store(':memory:');
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

    store.close();
    await adapter.stop();
  });
});
