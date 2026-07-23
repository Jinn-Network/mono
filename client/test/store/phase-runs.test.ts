import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../src/store/store.js';
import { PhaseRunStore, ConcurrentPhaseTransitionError } from '../../src/store/phase-runs.js';

function tmpDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'jinn-phase-runs-'));
  return join(dir, 'jinn.db');
}

describe('PhaseRunStore', () => {
  it('roundtrips phase, revision, state, and events across a reopen', () => {
    const dbPath = tmpDbPath();
    let store = new Store(dbPath);
    let phaseRuns = store.phaseRuns();

    phaseRuns.createRun('run-1', 'plan', { foo: 'bar' });
    phaseRuns.transition('run-1', 0, { phase: 'execute', event: { kind: 'started' } });
    phaseRuns.transition('run-1', 1, { phase: 'verify', event: { kind: 'executed' } });
    phaseRuns.transition('run-1', 2, { phase: 'done', state: { foo: 'baz' }, event: { kind: 'verified' } });

    store.close();

    store = new Store(dbPath);
    phaseRuns = store.phaseRuns();
    const run = phaseRuns.getRun('run-1');

    expect(run).not.toBeNull();
    expect(run!.phase).toBe('done');
    expect(run!.revision).toBe(3);
    expect(run!.state).toEqual({ foo: 'baz' });
    expect(run!.events).toEqual([
      { kind: 'started' },
      { kind: 'executed' },
      { kind: 'verified' },
    ]);

    store.close();
  });

  it('lets exactly one of two racing transitions at the same expected revision succeed', () => {
    const store = new Store(':memory:');
    const phaseRuns = store.phaseRuns();
    phaseRuns.createRun('run-race', 'plan');

    let succeeded = 0;
    let caught: unknown = null;
    for (const label of ['a', 'b']) {
      try {
        phaseRuns.transition('run-race', 0, { phase: 'execute', event: { by: label } });
        succeeded++;
      } catch (err) {
        caught = err;
      }
    }

    expect(succeeded).toBe(1);
    expect(caught).toBeInstanceOf(ConcurrentPhaseTransitionError);
    expect((caught as ConcurrentPhaseTransitionError).runKey).toBe('run-race');
    expect((caught as ConcurrentPhaseTransitionError).expectedRevision).toBe(0);

    const run = phaseRuns.getRun('run-race');
    expect(run!.revision).toBe(1);

    store.close();
  });

  it('rolls back the losing transition atomically -- no orphan event row', () => {
    const store = new Store(':memory:');
    const phaseRuns = store.phaseRuns();
    phaseRuns.createRun('run-atomic', 'plan');

    phaseRuns.transition('run-atomic', 0, { phase: 'execute', event: { by: 'winner' } });
    expect(() =>
      phaseRuns.transition('run-atomic', 0, { phase: 'execute', event: { by: 'loser' } }),
    ).toThrow(ConcurrentPhaseTransitionError);

    const row = store.db
      .prepare('SELECT COUNT(*) as c FROM phase_run_events WHERE run_key = ?')
      .get('run-atomic') as { c: number };
    expect(row.c).toBe(1);

    store.close();
  });

  it('migrates an existing database without disturbing task_posts or activity_events rows', () => {
    const dbPath = tmpDbPath();
    let store = new Store(dbPath);

    store.upsertTaskPostRecord({
      creatorSafeAddress: '0xsafe',
      sourceKey: 'src-1',
      policyType: 'once_per_safe',
      scopeKey: '',
      taskId: 'task-1',
      requestId: 'req-1',
      firstPostedAt: '2026-01-01T00:00:00.000Z',
      lastPostedAt: '2026-01-01T00:00:00.000Z',
      postCount: 1,
    });
    store.recordActivityEvent({ ts: '2026-01-01T00:00:00.000Z', kind: 'created', requestId: 'req-1' });

    store.close();

    store = new Store(dbPath);

    const taskPosts = store.db.prepare('SELECT COUNT(*) as c FROM task_posts').get() as { c: number };
    const activityEvents = store.db.prepare('SELECT COUNT(*) as c FROM activity_events').get() as { c: number };
    expect(taskPosts.c).toBe(1);
    // >=1 because Store startup can write additional bookkeeping activity events.
    expect(activityEvents.c).toBeGreaterThanOrEqual(1);

    const phaseRunsCount = store.db.prepare('SELECT COUNT(*) as c FROM phase_runs').get() as { c: number };
    const phaseRunEventsCount = store.db.prepare('SELECT COUNT(*) as c FROM phase_run_events').get() as { c: number };
    expect(phaseRunsCount.c).toBe(0);
    expect(phaseRunEventsCount.c).toBe(0);

    store.close();
  });

  it('createRun is idempotent; getRun of a nonexistent run is null; events accumulate in order', () => {
    const store = new Store(':memory:');
    const phaseRuns = store.phaseRuns();

    phaseRuns.createRun('run-crud', 'plan');
    phaseRuns.createRun('run-crud', 'plan');

    expect(phaseRuns.getRun('run-crud')!.revision).toBe(0);
    expect(phaseRuns.getRun('run-crud')!.phase).toBe('plan');
    expect(phaseRuns.getRun('nonexistent')).toBeNull();

    phaseRuns.transition('run-crud', 0, { phase: 'a', event: { n: 1 } });
    phaseRuns.transition('run-crud', 1, { phase: 'b', event: { n: 2 } });
    phaseRuns.transition('run-crud', 2, { phase: 'c', event: { n: 3 } });

    expect(phaseRuns.getRun('run-crud')!.events).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);

    store.close();
  });

  it('preserves state when a transition omits it', () => {
    const store = new Store(':memory:');
    const phaseRuns = store.phaseRuns();

    phaseRuns.createRun('run-2', 'plan', { foo: 1 });
    phaseRuns.transition('run-2', 0, { phase: 'execute', event: { kind: 'noop' } });

    expect(phaseRuns.getRun('run-2')!.state).toEqual({ foo: 1 });

    store.close();
  });
});
