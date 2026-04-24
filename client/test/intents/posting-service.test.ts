import { describe, expect, it, vi } from 'vitest';
import { LocalAdapter } from '../../src/adapters/local/adapter.js';
import { IntentPostingService } from '../../src/intents/posting-service.js';
import { Store } from '../../src/store/store.js';
import { TransientError } from '../../src/types/index.js';
import type { SignedIntentV1 } from '../../src/types/intent.js';

const SAFE_A = '0x00112233445566778899aabbccddeeff00112233';
const SAFE_B = '0x1111222233334444555566667777888899990000';

describe('IntentPostingService', () => {
  it('returns the same request id for repeated manual submissions from the same Safe', async () => {
    const adapter = new LocalAdapter();
    await adapter.initialize();
    const store = new Store(':memory:');
    const service = new IntentPostingService(adapter, store);

    const postSpy = vi.spyOn(adapter, 'postRestorationJob');
    const candidate = {
      restorationJob: { id: 'manual-1', description: 'test manual submission' },
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

    const postSpy = vi.spyOn(adapter, 'postRestorationJob');
    const result = await service.postCandidate(
      {
        restorationJob: { id: 'manual-legacy', description: 'legacy' },
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

    const postSpy = vi.spyOn(adapter, 'postRestorationJob');
    const candidate = {
      restorationJob: { id: 'shared-id', description: 'same logical id' },
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

    const postSpy = vi.spyOn(adapter, 'postRestorationJob').mockImplementation(async (state) => {
      await postingGate;
      return `req-${state.id}`;
    });

    const candidate = {
      restorationJob: { id: 'race-1', description: 'race test' },
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

  it('propagates SignedIntentV1 on RestorationJob through to the adapter unchanged', async () => {
    const adapter = new LocalAdapter();
    await adapter.initialize();
    const store = new Store(':memory:');
    const service = new IntentPostingService(adapter, store);

    const stubIntent: SignedIntentV1 = {
      schemaVersion: 'intent.v1',
      id: 'intent-propagation-test',
      kind: 'health_check',
      description: 'propagation test',
      window: { startTs: '2026-01-01T00:00:00.000Z', endTs: '2026-12-31T23:59:59.999Z' },
      spec: { kind: 'health_check' },
      eligibility: {},
      creator: {
        safeAddress: '0x0000000000000000000000000000000000000001',
        agentEoa: '0x0000000000000000000000000000000000000002',
      },
      createdAt: 1_700_000_000_000,
      signature: {
        algo: 'secp256k1',
        signer: '0x0000000000000000000000000000000000000002',
        hash: '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
        sig: '0xcafecafecafecafecafecafecafecafecafecafecafecafecafecafecafecafecafecafecafecafecafecafecafecafecafecafecafecafecafecafecafecafe01',
      },
    };

    const postSpy = vi.spyOn(adapter, 'postRestorationJob');
    const candidate = {
      restorationJob: {
        id: 'intent-propagation-test',
        description: 'propagation test',
        intent: stubIntent,
      },
      sourceKey: 'manual:intent-propagation-test',
      postingPolicy: { kind: 'once_per_safe' } as const,
    };

    const result = await service.postCandidate(candidate, { creatorSafeAddress: SAFE_A });

    expect(result.idempotent).toBe(false);
    expect(result.restorationJob.intent).toBe(stubIntent);
    expect(postSpy).toHaveBeenCalledOnce();
    const posted = postSpy.mock.calls[0][0];
    expect(posted.intent).toBe(stubIntent);

    store.close();
    await adapter.stop();
  });

  describe('ERC-8004 registry integration (Plan E)', () => {
    it('calls registerIntent after a successful post when intentCid + spec.kind are provided', async () => {
      const adapter = new LocalAdapter();
      await adapter.initialize();
      const store = new Store(':memory:');

      const registerIntent = vi.fn().mockResolvedValue(1n);
      const mockRegistry = { registerIntent } as any;

      const service = new IntentPostingService(adapter, store, mockRegistry);
      const candidate = {
        restorationJob: {
          id: 'registry-test',
          description: 'registry test',
          spec: { kind: 'portfolio.v0' },
        },
        sourceKey: 'manual:registry-test',
        postingPolicy: { kind: 'once_per_safe' } as const,
        intentCid: 'bafy-test-cid',
      };

      await service.postCandidate(candidate, { creatorSafeAddress: SAFE_A });

      // Give the fire-and-forget promise a chance to settle.
      await new Promise(resolve => setTimeout(resolve, 10));

      expect(registerIntent).toHaveBeenCalledTimes(1);
      const args = registerIntent.mock.calls[0][0];
      expect(args.intentCid).toBe('bafy-test-cid');
      expect(args.kind).toBe('portfolio.v0');

      store.close();
      await adapter.stop();
    });

    it('skips registry call when intentCid is absent', async () => {
      const adapter = new LocalAdapter();
      await adapter.initialize();
      const store = new Store(':memory:');

      const registerIntent = vi.fn().mockResolvedValue(1n);
      const mockRegistry = { registerIntent } as any;

      const service = new IntentPostingService(adapter, store, mockRegistry);
      const candidate = {
        restorationJob: {
          id: 'no-cid-test',
          description: 'no cid',
          spec: { kind: 'portfolio.v0' },
        },
        sourceKey: 'manual:no-cid-test',
        postingPolicy: { kind: 'once_per_safe' } as const,
        // No intentCid
      };

      await service.postCandidate(candidate, { creatorSafeAddress: SAFE_A });
      await new Promise(resolve => setTimeout(resolve, 10));

      expect(registerIntent).not.toHaveBeenCalled();

      store.close();
      await adapter.stop();
    });

    it('does not throw if registerIntent rejects (best-effort)', async () => {
      const adapter = new LocalAdapter();
      await adapter.initialize();
      const store = new Store(':memory:');

      const registerIntent = vi.fn().mockRejectedValue(new Error('rpc error'));
      const mockRegistry = { registerIntent } as any;

      const service = new IntentPostingService(adapter, store, mockRegistry);
      const candidate = {
        restorationJob: {
          id: 'fail-registry-test',
          description: 'fail test',
          spec: { kind: 'portfolio.v0' },
        },
        sourceKey: 'manual:fail-registry-test',
        postingPolicy: { kind: 'once_per_safe' } as const,
        intentCid: 'bafy-fail',
      };

      // Should not throw even though registerIntent rejects
      await expect(service.postCandidate(candidate, { creatorSafeAddress: SAFE_A })).resolves.toBeDefined();

      store.close();
      await adapter.stop();
    });
  });
});
