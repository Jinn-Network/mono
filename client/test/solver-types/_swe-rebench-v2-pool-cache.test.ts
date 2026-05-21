import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PoolCacheStore } from '../../src/solver-types/_swe-rebench-v2-pool-cache.js';
import type { PoolTask } from '../../src/solver-types/_swe-rebench-v2-pool.js';

const sampleTasks: PoolTask[] = [
  { instance_id: 'octocat__hello-1', hf_dataset: 'nebius/SWE-rebench-leaderboard', hf_split: '2025_01', language: 'Python' },
  { instance_id: 'octocat__hello-2', hf_dataset: 'nebius/SWE-rebench-leaderboard', hf_split: '2025_02', language: 'TypeScript' },
];

describe('PoolCacheStore', () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await mkdtemp(join(tmpdir(), 'swe-pool-cache-'));
  });

  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });

  it('round-trips tasks through write() then read()', async () => {
    const store = new PoolCacheStore({ stateDir });
    await store.write(sampleTasks);

    const cached = await store.read();
    expect(cached).not.toBeNull();
    expect(cached!.tasks).toEqual(sampleTasks);
    expect(typeof cached!.savedAt).toBe('string');
    expect(Date.parse(cached!.savedAt)).not.toBeNaN();
  });

  it('write() creates the state dir if it does not exist', async () => {
    const nested = join(stateDir, 'does', 'not', 'exist');
    const store = new PoolCacheStore({ stateDir: nested });
    await store.write(sampleTasks);
    expect((await store.read())!.tasks).toEqual(sampleTasks);
  });

  it('read() returns null when no cache file exists', async () => {
    const store = new PoolCacheStore({ stateDir });
    expect(await store.read()).toBeNull();
  });

  it('read() returns null on corrupt JSON', async () => {
    await writeFile(join(stateDir, 'pool-cache.json'), '{ "schemaVersion": ', 'utf8');
    const store = new PoolCacheStore({ stateDir });
    expect(await store.read()).toBeNull();
  });

  it('read() returns null on an unrecognised schemaVersion', async () => {
    await writeFile(
      join(stateDir, 'pool-cache.json'),
      JSON.stringify({ schemaVersion: 'swe-rebench-v2-pool-cache.v999', savedAt: new Date().toISOString(), tasks: [] }),
      'utf8',
    );
    const store = new PoolCacheStore({ stateDir });
    expect(await store.read()).toBeNull();
  });

  it('round-trips an empty task list', async () => {
    const store = new PoolCacheStore({ stateDir });
    await store.write([]);
    expect((await store.read())!.tasks).toEqual([]);
  });
});
