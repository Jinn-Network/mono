import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CreatorLoop } from '../../src/daemon/creator.js';
import { LocalAdapter } from '../../src/adapters/local/adapter.js';
import { GeneratedTaskSource, StaticConfiguredTaskSource } from '../../src/tasks/sources.js';
import { Store } from '../../src/store/store.js';
import { GeneratorStateStore } from '../../src/solver-types/_swe-rebench-v2-state.js';
import { PermanentError, type Task } from '../../src/types/index.js';

const SAFE = '0x00112233445566778899aabbccddeeff00112233';

describe('CreatorLoop', () => {
  it('posts Tasks with role and attemptId', async () => {
    const adapter = new LocalAdapter();
    await adapter.initialize();
    const store = new Store(':memory:');

    const tasks: Task[] = [
      { id: 'ds-1', description: 'API returns 200' },
    ];

    const postSpy = vi.spyOn(adapter, 'postTask');
    const loop = new CreatorLoop(adapter, [new StaticConfiguredTaskSource(tasks)], store);

    await loop.tick();

    expect(postSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'ds-1',
        description: 'API returns 200',
        role: 'restoration',
        attemptId: 'ds-1/1',
        attemptNumber: 1,
      }),
    );
    store.close();
    await adapter.stop();
  });

  it('posts all static configured Tasks collected in one tick', async () => {
    const adapter = new LocalAdapter();
    await adapter.initialize();
    const store = new Store(':memory:');

    const tasks: Task[] = [
      { id: 'ds-1', description: 'first' },
      { id: 'ds-2', description: 'second' },
      { id: 'ds-3', description: 'third' },
    ];

    const postSpy = vi.spyOn(adapter, 'postTask');
    const loop = new CreatorLoop(adapter, [new StaticConfiguredTaskSource(tasks)], store);

    const postedIds = await loop.tick();

    expect(postedIds).toHaveLength(3);
    expect(postSpy).toHaveBeenCalledTimes(3);
    expect(postSpy.mock.calls.map(([task]) => task.id)).toEqual(['ds-1', 'ds-2', 'ds-3']);
    store.close();
    await adapter.stop();
  });

  it('does not re-post already posted Tasks', async () => {
    const adapter = new LocalAdapter();
    await adapter.initialize();
    const store = new Store(':memory:');

    const tasks: Task[] = [
      { id: 'ds-1', description: 'API returns 200' },
    ];

    const postSpy = vi.spyOn(adapter, 'postTask');
    const loop = new CreatorLoop(adapter, [new StaticConfiguredTaskSource(tasks)], store);

    await loop.tick();
    await loop.tick();

    expect(postSpy).toHaveBeenCalledTimes(1);
    store.close();
    await adapter.stop();
  });

  it('calls task generators each tick and posts their results', async () => {
    const adapter = new LocalAdapter();
    await adapter.initialize();
    const store = new Store(':memory:');

    const generated: Task = {
      id: 'auto-1',
      description: 'auto-generated',
      window: { startTs: 0, endTs: 3_600_000 },
    };
    const generator = vi.fn(async () => generated);

    const postSpy = vi.spyOn(adapter, 'postTask');
    const loop = new CreatorLoop(
      adapter,
      [new GeneratedTaskSource('generated:prediction.v0', generator)],
      store,
    );

    await loop.tick();
    expect(generator).toHaveBeenCalledTimes(1);
    expect(postSpy).toHaveBeenCalledWith(expect.objectContaining({ id: 'auto-1', role: 'restoration' }));

    store.close();
    await adapter.stop();
  });

  it('skips null generator returns silently', async () => {
    const adapter = new LocalAdapter();
    await adapter.initialize();
    const store = new Store(':memory:');

    const generator = vi.fn(async () => null);
    const postSpy = vi.spyOn(adapter, 'postTask');
    const loop = new CreatorLoop(
      adapter,
      [new GeneratedTaskSource('generated:prediction.v0', generator)],
      store,
    );

    await loop.tick();
    expect(generator).toHaveBeenCalledTimes(1);
    expect(postSpy).not.toHaveBeenCalled();

    store.close();
    await adapter.stop();
  });

  it('SQLite idempotency survives simulated daemon restart (shared store)', async () => {
    const adapter = new LocalAdapter();
    await adapter.initialize();
    const store = new Store(':memory:');

    const states: Task[] = [{ id: 'ds-restart', description: 'survives restart' }];

    const postSpy = vi.spyOn(adapter, 'postTask');

    // First loop instance posts.
    const source = new StaticConfiguredTaskSource(states);
    const loop1 = new CreatorLoop(adapter, [source], store, SAFE);
    await loop1.tick();
    expect(postSpy).toHaveBeenCalledTimes(1);

    // New loop instance (fresh in-memory Map) reusing the same store.
    const loop2 = new CreatorLoop(adapter, [source], store, SAFE);
    await loop2.tick();
    expect(postSpy).toHaveBeenCalledTimes(1); // no double-post

    store.close();
    await adapter.stop();
  });

  it('generator errors are caught; next tick retries', async () => {
    const adapter = new LocalAdapter();
    await adapter.initialize();
    const store = new Store(':memory:');

    let attempts = 0;
    const generator = vi.fn(async () => {
      attempts++;
      if (attempts === 1) throw new Error('transient read failure');
      return { id: 'auto-retry', description: 'after retry' } as Task;
    });

    const postSpy = vi.spyOn(adapter, 'postTask');
    const loop = new CreatorLoop(
      adapter,
      [new GeneratedTaskSource('generated:prediction.v0', generator)],
      store,
    );

    await loop.tick(); // generator throws; no post
    expect(postSpy).not.toHaveBeenCalled();

    await loop.tick(); // generator succeeds; posts
    expect(postSpy).toHaveBeenCalledTimes(1);

    store.close();
    await adapter.stop();
  });

  it('backs off permanent create failures for the same task without throwing', async () => {
    const adapter = new LocalAdapter();
    await adapter.initialize();
    const store = new Store(':memory:');

    const states: Task[] = [{ id: 'gated', description: 'router-gated' }];
    const postSpy = vi
      .spyOn(adapter, 'postTask')
      .mockRejectedValue(new PermanentError('No request IDs returned from router'));
    const loop = new CreatorLoop(adapter, [new StaticConfiguredTaskSource(states)], store, SAFE);

    await expect(loop.tick()).resolves.toEqual([]);
    await expect(loop.tick()).resolves.toEqual([]);

    expect(postSpy).toHaveBeenCalledTimes(1);
    store.close();
    await adapter.stop();
  });

  it('continues posting later candidates after a mid-batch failure', async () => {
    const adapter = new LocalAdapter();
    await adapter.initialize();
    const store = new Store(':memory:');

    const states: Task[] = [
      { id: 'before-failure', description: 'posts first' },
      { id: 'fails', description: 'throws in the middle' },
      { id: 'after-failure', description: 'still posts' },
    ];
    const postSpy = vi.spyOn(adapter, 'postTask').mockImplementation(async (task) => {
      if (task.id === 'fails') {
        throw new Error('unexpected adapter failure');
      }
      return { taskId: `task-${task.id}`, taskCid: `cid-${task.id}` };
    });
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const loop = new CreatorLoop(adapter, [new StaticConfiguredTaskSource(states)], store, SAFE);

    const postedIds = await loop.tick();

    expect(postedIds).toEqual(['task-before-failure', 'task-after-failure']);
    expect(postSpy).toHaveBeenCalledTimes(3);
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('[creator] Create failure for fails'),
      expect.any(Error),
    );
    store.close();
    await adapter.stop();
    consoleSpy.mockRestore();
  });

  it('posts generated tasks once per bucket and again in a new bucket', async () => {
    const adapter = new LocalAdapter();
    await adapter.initialize();
    const store = new Store(':memory:');

    let bucketStart = 0;
    const generator = vi.fn(async () => ({
      id: `auto-${bucketStart}`,
      description: 'bucketed',
      window: { startTs: bucketStart, endTs: bucketStart + 600_000 },
    } satisfies Task));

    const postSpy = vi.spyOn(adapter, 'postTask');
    const loop = new CreatorLoop(
      adapter,
      [new GeneratedTaskSource('generated:prediction.v0', generator)],
      store,
      SAFE,
    );

    await loop.tick();
    await loop.tick();
    expect(postSpy).toHaveBeenCalledTimes(1);

    bucketStart = 600_000;
    await loop.tick();
    expect(postSpy).toHaveBeenCalledTimes(2);

    store.close();
    await adapter.stop();
  });

  it('dedupes generated same-window batch members by default', async () => {
    const adapter = new LocalAdapter();
    await adapter.initialize();
    const store = new Store(':memory:');

    const tasks: Task[] = [
      { id: 'same-window-1', description: 'first', window: { startTs: 0, endTs: 600_000 } },
      { id: 'same-window-2', description: 'second', window: { startTs: 0, endTs: 600_000 } },
    ];
    const generator = vi.fn(async () => tasks);
    const postSpy = vi.spyOn(adapter, 'postTask');
    const loop = new CreatorLoop(
      adapter,
      [new GeneratedTaskSource('generated:batch', generator)],
      store,
      SAFE,
    );

    const postedIds = await loop.tick();

    expect(postedIds).toHaveLength(1);
    expect(postSpy).toHaveBeenCalledTimes(1);
    expect(postSpy.mock.calls[0][0].id).toBe('same-window-1');

    store.close();
    await adapter.stop();
  });

  it('posts generated same-window batch members when bucket override makes them distinct', async () => {
    const adapter = new LocalAdapter();
    await adapter.initialize();
    const store = new Store(':memory:');

    const tasks: Task[] = [
      { id: 'same-window-1', description: 'first', window: { startTs: 0, endTs: 600_000 } },
      { id: 'same-window-2', description: 'second', window: { startTs: 0, endTs: 600_000 } },
    ];
    const generator = vi.fn(async () => tasks);
    const postSpy = vi.spyOn(adapter, 'postTask');
    const loop = new CreatorLoop(
      adapter,
      [
        new GeneratedTaskSource('generated:batch', generator, {
          bucketKeyForTask: (task) => `batch:${task.id}`,
        }),
      ],
      store,
      SAFE,
    );

    const postedIds = await loop.tick();

    expect(postedIds).toHaveLength(2);
    expect(postSpy).toHaveBeenCalledTimes(2);
    expect(postSpy.mock.calls.map(([task]) => task.id)).toEqual([
      'same-window-1',
      'same-window-2',
    ]);

    store.close();
    await adapter.stop();
  });
});

describe('CreatorLoop — swe-rebench-v2 last_task_id ledger (#802)', () => {
  let stateDir: string;
  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'jinn-creator-802-'));
    process.env['JINN_SWE_REBENCH_V2_STATE_DIR'] = stateDir;
  });
  afterEach(() => {
    delete process.env['JINN_SWE_REBENCH_V2_STATE_DIR'];
    rmSync(stateDir, { recursive: true, force: true });
  });

  // The CreatorLoop hook records last_task_id fire-and-forget (matching the
  // delivery-watcher recordSuccess precedent), so the write resolves on a later
  // microtask than `tick()` returns. Capture the write promise via a prototype
  // spy and await it before asserting / teardown — otherwise the assertion races
  // the write and afterEach can remove the state dir mid-write.
  function captureLastTaskIdWrites(): Promise<void>[] {
    const pending: Promise<void>[] = [];
    const orig = GeneratorStateStore.prototype.recordLastTaskId;
    vi.spyOn(GeneratorStateStore.prototype, 'recordLastTaskId').mockImplementation(
      function (this: GeneratorStateStore, instance_id: string, taskId: string) {
        const p = orig.call(this, instance_id, taskId);
        pending.push(p);
        return p;
      },
    );
    return pending;
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('records the on-chain taskId for the posted instance', async () => {
    const adapter = new LocalAdapter();
    await adapter.initialize();
    const store = new Store(':memory:');
    const writes = captureLastTaskIdWrites();

    const tasks: Task[] = [
      {
        id: 'swe-1',
        description: 'SWE-rebench v2: org__repo-1',
        solverType: 'swe-rebench-v2.v1',
        spec: { instance_id: 'org__repo-1' },
      },
    ];
    const loop = new CreatorLoop(adapter, [new StaticConfiguredTaskSource(tasks)], store);

    const postedIds = await loop.tick();
    expect(postedIds).toHaveLength(1);
    await Promise.all(writes);

    const ledger = new GeneratorStateStore({ stateDir });
    expect((await ledger.getCounters('org__repo-1')).last_task_id).toBe(postedIds[0]);

    store.close();
    await adapter.stop();
  });

  it('does not record last_task_id for non-swe-rebench-v2 candidates', async () => {
    const adapter = new LocalAdapter();
    await adapter.initialize();
    const store = new Store(':memory:');
    const writes = captureLastTaskIdWrites();

    const tasks: Task[] = [
      {
        id: 'pred-1',
        description: 'prediction',
        solverType: 'prediction.v1',
        spec: { instance_id: 'x' },
      },
    ];
    const loop = new CreatorLoop(adapter, [new StaticConfiguredTaskSource(tasks)], store);

    await loop.tick();
    await Promise.all(writes);
    expect(writes).toHaveLength(0);

    const ledger = new GeneratorStateStore({ stateDir });
    expect((await ledger.getCounters('x')).last_task_id).toBeUndefined();

    store.close();
    await adapter.stop();
  });
});
