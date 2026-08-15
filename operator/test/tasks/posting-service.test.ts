import { describe, expect, it, vi } from 'vitest';
import { LocalAdapter } from '../../src/adapters/local/adapter.js';
import { TaskPostingService } from '../../src/tasks/posting-service.js';
import { Store } from '../../src/store/store.js';
import { TransientError } from '../../src/types/index.js';
import type { SignedTaskV1 } from '../../src/types/task-document.js';
import { canonicalJson } from '../../src/util/canonical-json.js';
import { getAddress } from 'viem';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

  it('returns an existing completed immutable post during recovery-only submission', async () => {
    const adapter = new LocalAdapter();
    await adapter.initialize();
    const store = new Store(':memory:');
    const service = new TaskPostingService(adapter, store);
    const signedTask = {
      schemaVersion: 'task.v1',
      id: 'autopilot:completed-recovery-only',
      solverType: 'jinn-repo.v1',
      solverNetManifestCid: 'bafy-manifest',
    } as SignedTaskV1;
    const candidate = {
      task: { id: signedTask.id, description: 'completed recovery', signedTask },
      sourceKey: signedTask.id,
      postingPolicy: { kind: 'once_per_safe' } as const,
      sourceMeta: { request: { schemaVersion: 'jinn-task-submit-request.v1' } },
    };

    const first = await service.postCandidate(candidate, { creatorSafeAddress: SAFE_A });
    const postSpy = vi.spyOn(adapter, 'postTask');
    const recovered = await service.postCandidate(candidate, {
      creatorSafeAddress: SAFE_A,
      recoveryOnly: true,
    });

    expect(recovered).toMatchObject({
      taskId: first.taskId,
      idempotent: true,
      source: 'store',
    });
    expect(postSpy).not.toHaveBeenCalled();

    store.close();
    await adapter.stop();
  });

  it('refuses recovery-only submission for a completed legacy unsigned post', async () => {
    const adapter = new LocalAdapter();
    await adapter.initialize();
    const store = new Store(':memory:');
    const service = new TaskPostingService(adapter, store);
    const candidate = {
      task: { id: 'legacy:completed-recovery-only', description: 'legacy completed recovery' },
      sourceKey: 'legacy:completed-recovery-only',
      postingPolicy: { kind: 'once_per_safe' } as const,
    };

    await service.postCandidate(candidate, { creatorSafeAddress: SAFE_A });
    const postSpy = vi.spyOn(adapter, 'postTask');

    await expect(service.postCandidate(candidate, {
      creatorSafeAddress: SAFE_A,
      recoveryOnly: true,
    })).rejects.toThrow(/recovery-only/i);

    expect(postSpy).not.toHaveBeenCalled();
    store.close();
    await adapter.stop();
  });

  it('adopts a recovered pending immutable post during recovery-only submission', async () => {
    const adapter = new LocalAdapter();
    await adapter.initialize();
    const store = new Store(':memory:');
    const service = new TaskPostingService(adapter, store);
    const signedTask = {
      schemaVersion: 'task.v1',
      id: 'autopilot:pending-recovery-only',
      solverType: 'jinn-repo.v1',
      solverNetManifestCid: 'bafy-manifest',
    } as SignedTaskV1;
    const candidate = {
      task: { id: signedTask.id, description: 'pending recovery', signedTask },
      sourceKey: signedTask.id,
      postingPolicy: { kind: 'once_per_safe' } as const,
      sourceMeta: { request: { schemaVersion: 'jinn-task-submit-request.v1' } },
    };
    const postTask = vi.spyOn(adapter, 'postTask').mockRejectedValueOnce(new Error('crash'));
    const recoverTaskPost = vi.fn().mockResolvedValue({
      taskId: 'recovered-pending-task',
      taskCid: `f01551220${'ab'.repeat(32)}`,
      txHash: `0x${'cd'.repeat(32)}`,
      blockNumber: 123,
    });
    Object.assign(adapter, { recoverTaskPost });

    await expect(service.postCandidate(candidate, { creatorSafeAddress: SAFE_A })).rejects.toThrow('crash');
    const recovered = await service.postCandidate(candidate, {
      creatorSafeAddress: SAFE_A,
      recoveryOnly: true,
    });

    expect(recovered).toMatchObject({
      taskId: 'recovered-pending-task',
      idempotent: true,
      source: 'recovered',
    });
    expect(postTask).toHaveBeenCalledOnce();
    expect(recoverTaskPost).toHaveBeenCalledOnce();

    store.close();
    await adapter.stop();
  });

  it('refuses recovery-only submission when no immutable post can be recovered', async () => {
    const adapter = new LocalAdapter();
    await adapter.initialize();
    const store = new Store(':memory:');
    const service = new TaskPostingService(adapter, store);
    const signedTask = {
      schemaVersion: 'task.v1',
      id: 'autopilot:no-recovery-only-record',
      solverType: 'jinn-repo.v1',
      solverNetManifestCid: 'bafy-manifest',
    } as SignedTaskV1;
    const candidate = {
      task: { id: signedTask.id, description: 'no recovery record', signedTask },
      sourceKey: signedTask.id,
      postingPolicy: { kind: 'once_per_safe' } as const,
      sourceMeta: { request: { schemaVersion: 'jinn-task-submit-request.v1' } },
    };
    const postSpy = vi.spyOn(adapter, 'postTask');

    await expect(service.postCandidate(candidate, {
      creatorSafeAddress: SAFE_A,
      recoveryOnly: true,
    })).rejects.toThrow(/recovery-only/i);

    expect(postSpy).not.toHaveBeenCalled();
    expect(store.getTaskPostRecord({
      creatorSafeAddress: getAddress(SAFE_A),
      sourceKey: candidate.sourceKey,
      policyType: 'once_per_safe',
      scopeKey: '',
    })).toBeNull();

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

  it('never reposts across processes when the broadcast hash Store write fails, then adopts exact recovery', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jinn-task-broadcast-intent-'));
    const dbPath = join(dir, 'jinn.sqlite');
    const txHash = `0x${'de'.repeat(32)}` as const;
    const signedTask = {
      schemaVersion: 'task.v1',
      id: 'autopilot:store-write-failure',
      solverType: 'jinn-repo.v1',
      solverNetManifestCid: 'bafy-manifest',
    } as SignedTaskV1;
    const candidate = {
      task: { id: signedTask.id, description: 'durable uncertainty', signedTask },
      sourceKey: signedTask.id,
      postingPolicy: { kind: 'once_per_safe' } as const,
      sourceMeta: { request: { schemaVersion: 'jinn-task-submit-request.v1' } },
    };
    const key = {
      creatorSafeAddress: getAddress(SAFE_A),
      sourceKey: candidate.sourceKey,
      policyType: 'once_per_safe' as const,
      scopeKey: '',
    };

    const firstAdapter = new LocalAdapter();
    await firstAdapter.initialize();
    const firstStore = new Store(dbPath);
    const realUpsert = firstStore.upsertTaskPostRecord.bind(firstStore);
    vi.spyOn(firstStore, 'upsertTaskPostRecord').mockImplementation((record) => {
      if (record.creationTxHash) {
        throw new Error('simulated durable task_posts hash write failure');
      }
      realUpsert(record);
    });
    const walletWrite = vi.fn();
    Object.assign(firstAdapter, {
      postTask: vi.fn(async (_task: unknown, options?: {
        beforeBroadcast?: () => void | Promise<void>;
        onTransactionHash?: (hash: typeof txHash) => void | Promise<void>;
      }) => {
        await options?.beforeBroadcast?.();
        walletWrite();
        await options?.onTransactionHash?.(txHash);
        throw new Error('unreachable after failed hash persistence');
      }),
    });
    const firstService = new TaskPostingService(firstAdapter, firstStore);

    await expect(
      firstService.postCandidate(candidate, { creatorSafeAddress: SAFE_A }),
    ).rejects.toThrow(/hash write failure/);
    expect(walletWrite).toHaveBeenCalledOnce();
    expect(firstStore.getTaskPostRecord(key)?.broadcastIntentAt).toEqual(expect.any(String));
    firstStore.close();
    await firstAdapter.stop();

    const secondAdapter = new LocalAdapter();
    await secondAdapter.initialize();
    const recovered = {
      taskId: 'recovered-task-91',
      taskCid: `f01551220${'ab'.repeat(32)}`,
      txHash,
      blockNumber: 901,
    };
    const recoverTaskPost = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(recovered);
    const secondPostTask = vi.fn(async () => ({
      taskId: 'must-not-repost',
      taskCid: `f01551220${'cd'.repeat(32)}`,
    }));
    Object.assign(secondAdapter, { recoverTaskPost, postTask: secondPostTask });
    const secondStore = new Store(dbPath);
    const secondService = new TaskPostingService(secondAdapter, secondStore);

    await expect(
      secondService.postCandidate(candidate, { creatorSafeAddress: SAFE_A }),
    ).rejects.toMatchObject({
      name: 'TaskPostBroadcastUncertainError',
      broadcastIntentAt: expect.any(String),
    });
    expect(secondPostTask).not.toHaveBeenCalled();

    await expect(
      secondService.postCandidate(candidate, { creatorSafeAddress: SAFE_A }),
    ).resolves.toMatchObject({
      taskId: recovered.taskId,
      txHash,
      source: 'recovered',
      idempotent: true,
    });
    expect(recoverTaskPost).toHaveBeenCalledTimes(2);
    expect(secondPostTask).not.toHaveBeenCalled();

    secondStore.close();
    await secondAdapter.stop();
  });

  it('keeps a crash after durable intent but before wallet write uncertain across processes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jinn-task-prewrite-intent-'));
    const dbPath = join(dir, 'jinn.sqlite');
    const signedTask = {
      schemaVersion: 'task.v1',
      id: 'autopilot:prewrite-crash',
      solverType: 'jinn-repo.v1',
      solverNetManifestCid: 'bafy-manifest',
    } as SignedTaskV1;
    const candidate = {
      task: { id: signedTask.id, description: 'crash before write', signedTask },
      sourceKey: signedTask.id,
      postingPolicy: { kind: 'once_per_safe' } as const,
      sourceMeta: { request: { schemaVersion: 'jinn-task-submit-request.v1' } },
    };

    const firstAdapter = new LocalAdapter();
    await firstAdapter.initialize();
    const firstStore = new Store(dbPath);
    const walletWrite = vi.fn();
    Object.assign(firstAdapter, {
      postTask: vi.fn(async (_task: unknown, options?: {
        beforeBroadcast?: () => void | Promise<void>;
      }) => {
        await options?.beforeBroadcast?.();
        throw new Error('simulated process crash before wallet write');
      }),
    });
    const firstService = new TaskPostingService(firstAdapter, firstStore);

    await expect(
      firstService.postCandidate(candidate, { creatorSafeAddress: SAFE_A }),
    ).rejects.toThrow(/before wallet write/);
    expect(walletWrite).not.toHaveBeenCalled();
    expect(firstStore.getTaskPostRecord({
      creatorSafeAddress: getAddress(SAFE_A),
      sourceKey: candidate.sourceKey,
      policyType: 'once_per_safe',
      scopeKey: '',
    })?.broadcastIntentAt).toEqual(expect.any(String));
    firstStore.close();
    await firstAdapter.stop();

    const secondAdapter = new LocalAdapter();
    await secondAdapter.initialize();
    const recoverTaskPost = vi.fn().mockResolvedValue(null);
    const secondPostTask = vi.fn(async () => {
      walletWrite();
      return {
        taskId: 'must-not-post-after-uncertainty',
        taskCid: `f01551220${'ef'.repeat(32)}`,
      };
    });
    Object.assign(secondAdapter, { recoverTaskPost, postTask: secondPostTask });
    const secondStore = new Store(dbPath);
    const secondService = new TaskPostingService(secondAdapter, secondStore);

    await expect(
      secondService.postCandidate(candidate, { creatorSafeAddress: SAFE_A }),
    ).rejects.toMatchObject({ name: 'TaskPostBroadcastUncertainError' });
    expect(recoverTaskPost).toHaveBeenCalledOnce();
    expect(secondPostTask).not.toHaveBeenCalled();
    expect(walletWrite).not.toHaveBeenCalled();

    secondStore.close();
    await secondAdapter.stop();
  });

  it('keeps unsigned legacy posts retryable across process crashes without durable intent', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jinn-task-legacy-retry-'));
    const dbPath = join(dir, 'jinn.sqlite');
    const candidate = {
      task: {
        id: 'legacy-unsigned-retry',
        description: 'legacy adapter signs this task during posting',
      },
      sourceKey: 'legacy:unsigned-retry',
      postingPolicy: { kind: 'once_per_safe' } as const,
    };
    const key = {
      creatorSafeAddress: getAddress(SAFE_A),
      sourceKey: candidate.sourceKey,
      policyType: 'once_per_safe' as const,
      scopeKey: '',
    };
    const walletWrite = vi.fn();

    const firstAdapter = new LocalAdapter();
    await firstAdapter.initialize();
    Object.assign(firstAdapter, {
      postTask: vi.fn(async (_task: unknown, options?: {
        beforeBroadcast?: () => void | Promise<void>;
      }) => {
        await options?.beforeBroadcast?.();
        walletWrite();
        throw new Error('simulated legacy process crash after wallet boundary');
      }),
    });
    const firstStore = new Store(dbPath);
    const firstService = new TaskPostingService(firstAdapter, firstStore);

    await expect(
      firstService.postCandidate(candidate, { creatorSafeAddress: SAFE_A }),
    ).rejects.toThrow(/legacy process crash/);
    expect(walletWrite).toHaveBeenCalledOnce();
    expect(firstStore.getTaskPostRecord(key)).toMatchObject({
      requestJson: null,
      canonicalTaskJson: null,
      broadcastIntentAt: null,
    });
    firstStore.close();
    await firstAdapter.stop();

    const secondAdapter = new LocalAdapter();
    await secondAdapter.initialize();
    const secondPostTask = vi.fn(async (_task: unknown, options?: {
      beforeBroadcast?: () => void | Promise<void>;
    }) => {
      await options?.beforeBroadcast?.();
      walletWrite();
      return {
        taskId: 'legacy-retry-landed',
        taskCid: 'local-legacy-retry',
      };
    });
    Object.assign(secondAdapter, { postTask: secondPostTask });
    const secondStore = new Store(dbPath);
    const secondService = new TaskPostingService(secondAdapter, secondStore);

    await expect(
      secondService.postCandidate(candidate, { creatorSafeAddress: SAFE_A }),
    ).resolves.toMatchObject({
      taskId: 'legacy-retry-landed',
      source: 'posted',
      idempotent: false,
    });
    expect(secondPostTask).toHaveBeenCalledOnce();
    expect(walletWrite).toHaveBeenCalledTimes(2);
    expect(secondStore.getTaskPostRecord(key)?.broadcastIntentAt).toBeNull();

    secondStore.close();
    await secondAdapter.stop();
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
    const candidate = {
      task: { id: 'legacy-wallet-fence', description: 'legacy wallet fence' },
      sourceKey: 'legacy:wallet-fence',
      postingPolicy: { kind: 'once_per_safe' } as const,
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
    expect(store.getTaskPostRecord({
      creatorSafeAddress: getAddress(SAFE_A),
      sourceKey: candidate.sourceKey,
      policyType: 'once_per_safe',
      scopeKey: '',
    })?.broadcastIntentAt).toBeNull();

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
