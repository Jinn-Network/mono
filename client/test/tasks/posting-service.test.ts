import { describe, expect, it, vi } from 'vitest';
import { LocalAdapter } from '../../src/adapters/local/adapter.js';
import { TaskPostingService } from '../../src/tasks/posting-service.js';
import { Store } from '../../src/store/store.js';
import { TransientError } from '../../src/types/index.js';
import type { SignedTaskV1 } from '../../src/types/task-document.js';
import { canonicalJson } from '../../src/harnesses/engine/canonical-json.js';
import { getAddress } from 'viem';

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

  it('renews immutable machine-post ownership across work longer than the stale-lock window', async () => {
    const adapter = new LocalAdapter();
    await adapter.initialize();
    const store = new Store(':memory:');
    let nowMs = Date.parse('2026-07-23T00:00:00.000Z');
    const intervals = new Set<() => void>();
    const scheduler = {
      now: () => new Date(nowMs),
      setInterval: (callback: () => void) => {
        intervals.add(callback);
        return callback;
      },
      clearInterval: (handle: unknown) => {
        intervals.delete(handle as () => void);
      },
    };
    const firstService = new TaskPostingService(adapter, store, scheduler);
    const secondService = new TaskPostingService(adapter, store, scheduler);
    let releasePost!: () => void;
    const postingGate = new Promise<void>((resolve) => { releasePost = resolve; });
    const postSpy = vi.spyOn(adapter, 'postTask').mockImplementation(async () => {
      await postingGate;
      return {
        taskId: 'machine-long-1',
        taskCid: `f01551220${'ab'.repeat(32)}`,
      };
    });
    const candidate = {
      task: {
        id: 'autopilot:long-post',
        description: 'long immutable post',
        signedTask: {
          schemaVersion: 'task.v1',
          id: 'autopilot:long-post',
          solverType: 'jinn-repo.v1',
          solverNetManifestCid: 'bafy-manifest',
        } as SignedTaskV1,
      },
      sourceKey: 'autopilot:long-post',
      postingPolicy: { kind: 'once_per_safe' } as const,
      sourceMeta: { request: { schemaVersion: 'jinn-task-submit-request.v1' } },
    };

    const first = firstService.postCandidate(candidate, { creatorSafeAddress: SAFE_A });
    await vi.waitFor(() => expect(postSpy).toHaveBeenCalledOnce());
    expect(intervals.size).toBe(1);
    nowMs += 61_000;
    for (const heartbeat of intervals) heartbeat();

    await expect(
      secondService.postCandidate(candidate, { creatorSafeAddress: SAFE_A }),
    ).rejects.toBeInstanceOf(TransientError);
    expect(postSpy).toHaveBeenCalledOnce();

    releasePost();
    await first;
    expect(intervals.size).toBe(0);
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

  it('persists exact signed content before broadcast and recovers a matching chain event after a crash', async () => {
    const adapter = new LocalAdapter();
    await adapter.initialize();
    const store = new Store(':memory:');
    const service = new TaskPostingService(adapter, store);
    const signedTask = {
      schemaVersion: 'task.v1',
      id: 'autopilot:attempt-1',
      solverType: 'jinn-repo.v1',
      solverNetManifestCid: 'bafy-manifest',
    } as SignedTaskV1;
    const candidate = {
      task: {
        id: signedTask.id,
        description: 'recover me',
        solverType: signedTask.solverType,
        solverNetManifestCid: signedTask.solverNetManifestCid,
        signedTask,
      },
      sourceKey: 'autopilot:attempt-1',
      postingPolicy: { kind: 'once_per_safe' } as const,
      sourceMeta: { request: { schemaVersion: 'jinn-task-submit-request.v1' } },
    };
    vi.spyOn(adapter, 'postTask').mockRejectedValueOnce(new Error('process crashed after broadcast'));
    const recover = vi.fn().mockResolvedValue({
      taskId: '77',
      taskCid: 'f01551220' + 'ab'.repeat(32),
      txHash: `0x${'cd'.repeat(32)}`,
      blockNumber: 123,
    });
    Object.assign(adapter, { recoverTaskPost: recover });

    await expect(service.postCandidate(candidate, { creatorSafeAddress: SAFE_A })).rejects.toThrow();
    const pending = store.getTaskPostRecord({
      creatorSafeAddress: getAddress(SAFE_A),
      sourceKey: candidate.sourceKey,
      policyType: 'once_per_safe',
      scopeKey: '',
    });
    expect(pending?.canonicalTaskJson).toContain('"autopilot:attempt-1"');

    const recovered = await service.postCandidate(candidate, { creatorSafeAddress: SAFE_A });
    expect(recovered).toMatchObject({
      taskId: '77',
      idempotent: true,
      source: 'recovered',
      txHash: `0x${'cd'.repeat(32)}`,
      blockNumber: 123,
    });
    expect(recover).toHaveBeenCalledWith(expect.objectContaining({
      creatorSafeAddress: getAddress(SAFE_A),
      signedTask,
    }));

    store.close();
    await adapter.stop();
  });

  it('preserves a surfaced Safe transaction hash across repeated pending recovery until the event lands', async () => {
    const adapter = new LocalAdapter();
    await adapter.initialize();
    const store = new Store(':memory:');
    const service = new TaskPostingService(adapter, store);
    const txHash = `0x${'ef'.repeat(32)}` as const;
    const postTask = vi.fn(async (_task: unknown, options: {
      onTransactionHash?: (hash: typeof txHash) => void | Promise<void>;
    }) => {
      await options.onTransactionHash?.(txHash);
      throw Object.assign(new Error('pending reconciliation'), { txHash });
    });
    const recovered = {
      taskId: 'pending-task-77',
      taskCid: `f01551220${'ab'.repeat(32)}`,
      txHash,
      blockNumber: 777,
    };
    const recoverTaskPost = vi.fn()
      .mockImplementationOnce(async (input: { pendingTxHash?: typeof txHash }) => {
        throw Object.assign(new Error('still pending reconciliation'), {
          txHash: input.pendingTxHash,
        });
      })
      .mockImplementationOnce(async (input: { pendingTxHash?: typeof txHash }) => {
        throw Object.assign(new Error('still pending reconciliation'), {
          txHash: input.pendingTxHash,
        });
      })
      .mockResolvedValueOnce(recovered);
    Object.assign(adapter, {
      postTask,
      recoverTaskPost,
    });
    const signedTask = {
      schemaVersion: 'task.v1',
      id: 'autopilot:pending-hash',
      solverType: 'jinn-repo.v1',
      solverNetManifestCid: 'bafy-manifest',
    } as SignedTaskV1;
    const candidate = {
      task: { id: signedTask.id, description: 'pending hash', signedTask },
      sourceKey: 'autopilot:pending-hash',
      postingPolicy: { kind: 'once_per_safe' } as const,
      sourceMeta: { request: { schemaVersion: 'jinn-task-submit-request.v1' } },
    };

    await expect(
      service.postCandidate(candidate, { creatorSafeAddress: SAFE_A }),
    ).rejects.toThrow('pending reconciliation');
    const pendingRecord = store.getTaskPostRecord({
      creatorSafeAddress: getAddress(SAFE_A),
      sourceKey: candidate.sourceKey,
      policyType: 'once_per_safe',
      scopeKey: '',
    });
    expect(pendingRecord).toMatchObject({ creationTxHash: txHash, protocolTaskId: null });
    store.upsertTaskPostRecord({
      ...pendingRecord!,
      creationBlockNumber: 776,
    });
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(
        service.postCandidate(candidate, { creatorSafeAddress: SAFE_A }),
      ).rejects.toThrow('still pending reconciliation');
      expect(store.getTaskPostRecord({
        creatorSafeAddress: getAddress(SAFE_A),
        sourceKey: candidate.sourceKey,
        policyType: 'once_per_safe',
        scopeKey: '',
      })).toMatchObject({
        creationTxHash: txHash,
        creationBlockNumber: 776,
        protocolTaskId: null,
      });
    }
    await expect(
      service.postCandidate(candidate, { creatorSafeAddress: SAFE_A }),
    ).resolves.toMatchObject({
      taskId: recovered.taskId,
      txHash,
      blockNumber: recovered.blockNumber,
      source: 'recovered',
    });
    expect(recoverTaskPost).toHaveBeenCalledTimes(3);
    for (const [input] of recoverTaskPost.mock.calls) {
      expect(input).toMatchObject({ pendingTxHash: txHash });
    }
    expect(postTask).toHaveBeenCalledOnce();

    store.close();
    await adapter.stop();
  });

  it('fences a stale owner immediately before broadcast when its lease was stolen during recovery', async () => {
    const adapter = new LocalAdapter();
    await adapter.initialize();
    const store = new Store(':memory:');
    let nowMs = Date.parse('2026-07-23T00:00:00.000Z');
    const scheduler = {
      now: () => new Date(nowMs),
      setInterval: (callback: () => void) => callback,
      clearInterval: () => undefined,
    };
    const firstService = new TaskPostingService(adapter, store, scheduler);
    const secondService = new TaskPostingService(adapter, store, scheduler);
    const signedTask = {
      schemaVersion: 'task.v1',
      id: 'autopilot:lease-fence',
      solverType: 'jinn-repo.v1',
      solverNetManifestCid: 'bafy-manifest',
    } as SignedTaskV1;
    const candidate = {
      task: { id: signedTask.id, description: 'lease fence', signedTask },
      sourceKey: signedTask.id,
      postingPolicy: { kind: 'once_per_safe' } as const,
      sourceMeta: { request: { schemaVersion: 'jinn-task-submit-request.v1' } },
    };
    store.upsertTaskPostRecord({
      creatorSafeAddress: getAddress(SAFE_A),
      sourceKey: candidate.sourceKey,
      policyType: 'once_per_safe',
      scopeKey: '',
      taskId: candidate.task.id,
      requestId: candidate.task.id,
      firstPostedAt: new Date(nowMs).toISOString(),
      lastPostedAt: new Date(nowMs).toISOString(),
      postCount: 0,
      canonicalTaskJson: canonicalJson(signedTask),
      requestJson: canonicalJson(candidate.sourceMeta.request),
    });

    let releaseFirstRecovery!: () => void;
    const firstRecoveryGate = new Promise<void>((resolve) => {
      releaseFirstRecovery = resolve;
    });
    const recoverTaskPost = vi.fn()
      .mockImplementationOnce(async () => {
        await firstRecoveryGate;
        return null;
      })
      .mockResolvedValueOnce(null);
    const postTask = vi.fn(async () => ({
      taskId: 'lease-winner',
      taskCid: `f01551220${'cd'.repeat(32)}`,
    }));
    Object.assign(adapter, { recoverTaskPost, postTask });

    const staleOwner = firstService.postCandidate(candidate, { creatorSafeAddress: SAFE_A });
    await vi.waitFor(() => expect(recoverTaskPost).toHaveBeenCalledTimes(1));
    nowMs += 61_000;
    const winner = await secondService.postCandidate(candidate, { creatorSafeAddress: SAFE_A });
    expect(winner.taskId).toBe('lease-winner');
    expect(postTask).toHaveBeenCalledOnce();

    releaseFirstRecovery();
    await expect(staleOwner).rejects.toBeInstanceOf(TransientError);
    expect(postTask).toHaveBeenCalledOnce();

    store.close();
    await adapter.stop();
  });

  it('uses the wallet-bound fence after delayed adapter setup so a stolen owner never writes', async () => {
    const adapter = new LocalAdapter();
    await adapter.initialize();
    const store = new Store(':memory:');
    let nowMs = Date.parse('2026-07-24T00:00:00.000Z');
    const scheduler = {
      now: () => new Date(nowMs),
      setInterval: (callback: () => void) => callback,
      clearInterval: () => undefined,
    };
    const service = new TaskPostingService(adapter, store, scheduler);
    let releaseSetup!: () => void;
    const setupGate = new Promise<void>((resolve) => {
      releaseSetup = resolve;
    });
    const walletWrite = vi.fn();
    const postTask = vi.fn(async (_task: unknown, options?: {
      beforeBroadcast?: () => void | Promise<void>;
    }) => {
      await setupGate; // IPFS/rate/timeout work inside MechAdapter.
      await options?.beforeBroadcast?.();
      walletWrite();
      return {
        taskId: 'must-not-land',
        taskCid: `f01551220${'ef'.repeat(32)}`,
      };
    });
    Object.assign(adapter, { postTask });
    const signedTask = {
      schemaVersion: 'task.v1',
      id: 'autopilot:wallet-fence',
      solverType: 'jinn-repo.v1',
      solverNetManifestCid: 'bafy-manifest',
    } as SignedTaskV1;
    const candidate = {
      task: { id: signedTask.id, description: 'wallet fence', signedTask },
      sourceKey: signedTask.id,
      postingPolicy: { kind: 'once_per_safe' } as const,
      sourceMeta: { request: { schemaVersion: 'jinn-task-submit-request.v1' } },
    };

    const pending = service.postCandidate(candidate, { creatorSafeAddress: SAFE_A });
    await vi.waitFor(() => expect(postTask).toHaveBeenCalledOnce());
    nowMs += 61_000;
    expect(store.acquireTaskPostLock({
      creatorSafeAddress: getAddress(SAFE_A),
      sourceKey: candidate.sourceKey,
      policyType: 'once_per_safe',
      scopeKey: '',
      ownerToken: 'winning-owner',
      lockedAt: new Date(nowMs).toISOString(),
      staleAfterMs: 60_000,
    })).toBe(true);

    releaseSetup();
    await expect(pending).rejects.toBeInstanceOf(TransientError);
    expect(walletWrite).not.toHaveBeenCalled();

    store.close();
    await adapter.stop();
  });

  it('fails closed when a completed key is retried with changed signed Task or request bytes', async () => {
    const adapter = new LocalAdapter();
    await adapter.initialize();
    const store = new Store(':memory:');
    const service = new TaskPostingService(adapter, store);
    const signedTask = {
      schemaVersion: 'task.v1',
      id: 'autopilot:immutable',
      solverType: 'jinn-repo.v1',
      solverNetManifestCid: 'bafy-manifest',
      spec: { session: { expectedHead: 'a'.repeat(40) } },
    } as unknown as SignedTaskV1;
    const candidate = {
      task: {
        id: signedTask.id,
        description: 'immutable',
        signedTask,
      },
      sourceKey: 'autopilot:immutable',
      postingPolicy: { kind: 'once_per_safe' } as const,
      sourceMeta: { request: { deadline: 100 } },
    };
    const postSpy = vi.spyOn(adapter, 'postTask');
    await service.postCandidate(candidate, { creatorSafeAddress: SAFE_A });

    await expect(service.postCandidate({
      ...candidate,
      task: {
        ...candidate.task,
        signedTask: {
          ...signedTask,
          spec: { session: { expectedHead: 'b'.repeat(40) } },
        } as unknown as SignedTaskV1,
      },
    }, { creatorSafeAddress: SAFE_A })).rejects.toThrow(/content mismatch/);
    await expect(service.postCandidate({
      ...candidate,
      sourceMeta: { request: { deadline: 101 } },
    }, { creatorSafeAddress: SAFE_A })).rejects.toThrow(/content mismatch/);
    expect(postSpy).toHaveBeenCalledOnce();

    store.close();
    await adapter.stop();
  });

  it('fails closed when an unfinished key is retried with changed capsule content', async () => {
    const adapter = new LocalAdapter();
    await adapter.initialize();
    const store = new Store(':memory:');
    const service = new TaskPostingService(adapter, store);
    const signedTask = {
      schemaVersion: 'task.v1',
      id: 'autopilot:unfinished',
      solverType: 'jinn-repo.v1',
      solverNetManifestCid: 'bafy-manifest',
      spec: { session: { expectedHead: 'a'.repeat(40) } },
    } as unknown as SignedTaskV1;
    const candidate = {
      task: { id: signedTask.id, description: 'unfinished', signedTask },
      sourceKey: 'autopilot:unfinished',
      postingPolicy: { kind: 'once_per_safe' } as const,
      sourceMeta: { request: { deadline: 100 } },
    };
    vi.spyOn(adapter, 'postTask').mockRejectedValue(new Error('crash'));
    await expect(service.postCandidate(candidate, { creatorSafeAddress: SAFE_A })).rejects.toThrow('crash');

    await expect(service.postCandidate({
      ...candidate,
      task: {
        ...candidate.task,
        signedTask: {
          ...signedTask,
          spec: { session: { expectedHead: 'b'.repeat(40) } },
        } as unknown as SignedTaskV1,
      },
    }, { creatorSafeAddress: SAFE_A })).rejects.toThrow(/content mismatch/);

    store.close();
    await adapter.stop();
  });

  it('returns identical creation provenance on the initial post and store retry', async () => {
    const adapter = new LocalAdapter();
    await adapter.initialize();
    const store = new Store(':memory:');
    const service = new TaskPostingService(adapter, store);
    const candidate = {
      task: { id: 'provenance', description: 'persist chain origin' },
      sourceKey: 'manual:provenance',
      postingPolicy: { kind: 'once_per_safe' } as const,
    };

    const first = await service.postCandidate(candidate, { creatorSafeAddress: SAFE_A });
    const retry = await service.postCandidate(candidate, { creatorSafeAddress: SAFE_A });

    expect(retry.txHash).toBe(first.txHash);
    expect(retry.blockNumber).toBe(first.blockNumber);
    expect(retry.taskCid).toBe(first.taskCid);

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
