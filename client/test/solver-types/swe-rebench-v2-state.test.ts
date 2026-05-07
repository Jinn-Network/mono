import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GeneratorStateStore } from '../../src/solver-types/_swe-rebench-v2-state.js';

describe('GeneratorStateStore', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'state-test-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('starts with zero counters for any task', async () => {
    const store = new GeneratorStateStore({ stateDir: dir });
    expect(await store.getCounters('a')).toEqual({ posted: 0, successful: 0, last_posted_at: 0 });
  });

  it('increments and persists posted_count', async () => {
    const store = new GeneratorStateStore({ stateDir: dir });
    await store.recordPosted('a');
    await store.recordPosted('a');
    expect((await store.getCounters('a')).posted).toBe(2);

    const reloaded = new GeneratorStateStore({ stateDir: dir });
    expect((await reloaded.getCounters('a')).posted).toBe(2);
  });

  it('increments successful_count and persists', async () => {
    const store = new GeneratorStateStore({ stateDir: dir });
    await store.recordSuccess('a');
    expect((await store.getCounters('a')).successful).toBe(1);
    const reloaded = new GeneratorStateStore({ stateDir: dir });
    expect((await reloaded.getCounters('a')).successful).toBe(1);
  });

  it('isolates counters per instance_id', async () => {
    const store = new GeneratorStateStore({ stateDir: dir });
    await store.recordPosted('a');
    await store.recordSuccess('b');
    expect((await store.getCounters('a')).posted).toBe(1);
    expect((await store.getCounters('a')).successful).toBe(0);
    expect((await store.getCounters('b')).posted).toBe(0);
    expect((await store.getCounters('b')).successful).toBe(1);
  });
});
