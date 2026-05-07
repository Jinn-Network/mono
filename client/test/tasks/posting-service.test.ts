import { describe, expect, it, vi } from 'vitest';
import { LocalAdapter } from '../../src/adapters/local/adapter.js';
import { TaskPostingService } from '../../src/tasks/posting-service.js';
import { Store } from '../../src/store/store.js';
import { TransientError } from '../../src/types/index.js';
import type { SignedTaskV1 } from '../../src/types/task-document.js';

const SAFE_A = '0x00112233445566778899aabbccddeeff00112233';
const SAFE_B = '0x1111222233334444555566667777888899990000';

describe('TaskPostingService', () => {
  it('returns the same protocol Task id for repeated manual submissions from the same Safe', async () => {
    const adapter = new LocalAdapter();
    await adapter.initialize();
    const store = new Store(':memory:');
    const service = new TaskPostingService(adapter, store);

    const postSpy = vi.spyOn(adapter, 'postTask');
    const candidate = {
      task: { id: 'manual-1', description: 'test manual submission' },
      sourceKey: 'manual:manual-1',
      postingPolicy: { kind: 'once_per_safe' } as const,
    };

    const first = await service.postCandidate(candidate, { creatorSafeAddress: SAFE_A });
    const second = await service.postCandidate(candidate, { creatorSafeAddress: SAFE_A });

    expect(first.idempotent).toBe(false);
    expect(second.idempotent).toBe(true);
    expect(second.taskId).toBe(first.taskId);
    expect(postSpy).toHaveBeenCalledTimes(1);

    store.close();
    await adapter.stop();
  });

  it('scopes idempotency by creator Safe', async () => {
    const adapter = new LocalAdapter();
    await adapter.initialize();
    const store = new Store(':memory:');
    const service = new TaskPostingService(adapter, store);

    const postSpy = vi.spyOn(adapter, 'postTask');
    const candidate = {
      task: { id: 'shared-id', description: 'same logical id' },
      sourceKey: 'manual:shared-id',
      postingPolicy: { kind: 'once_per_safe' } as const,
    };

    const first = await service.postCandidate(candidate, { creatorSafeAddress: SAFE_A });
    const second = await service.postCandidate(candidate, { creatorSafeAddress: SAFE_B });

    expect(first.taskId).not.toBe(second.taskId);
    expect(postSpy).toHaveBeenCalledTimes(2);

    store.close();
    await adapter.stop();
  });

  it('prevents concurrent callers from double-posting the same candidate', async () => {
    const adapter = new LocalAdapter();
    await adapter.initialize();
    const store = new Store(':memory:');
    const service = new TaskPostingService(adapter, store);

    let releasePost: (() => void) | null = null;
    const postingGate = new Promise<void>((resolve) => {
      releasePost = resolve;
    });

    const postSpy = vi.spyOn(adapter, 'postTask').mockImplementation(async (state) => {
      await postingGate;
      return {
        taskId: `task-${state.id}`,
        taskCid: `local-${state.id}`,
      };
    });

    const candidate = {
      task: { id: 'race-1', description: 'race test' },
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
    expect(firstResult.taskId).toBe('task-race-1');
    expect(postSpy).toHaveBeenCalledTimes(1);

    store.close();
    await adapter.stop();
  });

  it('propagates SignedTaskV1 on Task through to the adapter unchanged', async () => {
    const adapter = new LocalAdapter();
    await adapter.initialize();
    const store = new Store(':memory:');
    const service = new TaskPostingService(adapter, store);

    const stubTask: SignedTaskV1 = {
      schemaVersion: 'task.v1',
      id: 'task-propagation-test',
      solverType: 'health_check',
      contractId: 'health',
      contractVersion: 'v0',
      solverNetManifestCid: 'bafyfixturecid',
      role: 'restoration',
      description: 'propagation test',
      window: { startTs: '2026-01-01T00:00:00.000Z', endTs: '2026-12-31T23:59:59.999Z' },
      spec: {},
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

    const postSpy = vi.spyOn(adapter, 'postTask');
    const candidate = {
      task: {
        id: 'task-propagation-test',
        description: 'propagation test',
        signedTask: stubTask,
      },
      sourceKey: 'manual:task-propagation-test',
      postingPolicy: { kind: 'once_per_safe' } as const,
    };

    const result = await service.postCandidate(candidate, { creatorSafeAddress: SAFE_A });

    expect(result.idempotent).toBe(false);
    expect(result.task.signedTask).toBe(stubTask);
    expect(postSpy).toHaveBeenCalledOnce();
    const posted = postSpy.mock.calls[0][0];
    expect(posted.signedTask).toBe(stubTask);

    store.close();
    await adapter.stop();
  });

  // ERC-8004 per-execution registration is rebuilt under bead jinn-mono-3zk
  // against the operator-rooted entity model — see DR
  // docs/superpowers/specs/2026-04-27-erc-8004-entity-model-design.md. The
  // previous per-CID registerIntent test block was removed with PR #37 cleanup
  // (jinn-mono-2k6); new posting-service tests covering setMetadata land with
  // jinn-mono-3zk.
});
