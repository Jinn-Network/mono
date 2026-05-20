import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../../../src/store/store.js';
import { TaskEngine, type TaskEngineOptions } from '../../../src/harnesses/engine/engine.js';
import { TaskRunPersistence, type PersistedTaskRunInput } from '../../../src/harnesses/engine/persistence.js';
import { TaskRunState } from '../../../src/harnesses/engine/state.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeInput(requestId: string): PersistedTaskRunInput {
  const now = Date.now();
  return {
    requestId,
    taskCid: 'bafyabc123',
    onchainCreationTx: '0xdeadbeef',
    onchainCreationBlock: 1000,
    solverType: 'portfolio.v0',
    windowStartTs: now + 60_000,
    windowEndTs: now + 60_000 + 86_400_000,
    task: { id: requestId, description: 'test', solverType: 'portfolio.v0', role: 'restoration' },
  };
}

/** Drive a persisted row all the way to a terminal state via valid transitions. */
function driveToComplete(p: TaskRunPersistence, requestId: string): void {
  p.transition(requestId, TaskRunState.CLAIMED);
  p.transition(requestId, TaskRunState.WAITING);
  p.transition(requestId, TaskRunState.PRE_SNAPSHOT);
  p.transition(requestId, TaskRunState.RUNNING);
  p.transition(requestId, TaskRunState.POST_SNAPSHOT);
  p.transition(requestId, TaskRunState.PACKAGING);
  p.transition(requestId, TaskRunState.DELIVERING);
  p.transition(requestId, TaskRunState.COMPLETE);
}

function makeWorkDir(root: string, requestId: string): string {
  const dir = join(root, requestId);
  mkdirSync(join(dir, 'repo'), { recursive: true });
  writeFileSync(join(dir, 'task.json'), '{}', 'utf-8');
  writeFileSync(join(dir, 'system_snapshot.tar.gz'), 'x'.repeat(128), 'utf-8');
  return dir;
}

describe('TaskEngine work-dir cleanup (#320)', () => {
  let workRoot: string;
  let implRoot: string;
  let store: Store;
  let engine: TaskEngine;
  let persistence: TaskRunPersistence;

  beforeEach(() => {
    workRoot = mkdtempSync(join(tmpdir(), 'jinn-engine-work-'));
    implRoot = mkdtempSync(join(tmpdir(), 'jinn-engine-impl-'));
    store = new Store(':memory:');
    persistence = new TaskRunPersistence(store.db);
    const opts: TaskEngineOptions = {
      store,
      paths: { workingDirRoot: workRoot, implStateDirRoot: implRoot },
    };
    engine = new TaskEngine(opts);
  });

  afterEach(() => {
    rmSync(workRoot, { recursive: true, force: true });
    rmSync(implRoot, { recursive: true, force: true });
  });

  it('reapWorkDirsNow removes the work dir of a COMPLETE task', () => {
    persistence.insertDiscovered(makeInput('0xdone'));
    const dir = makeWorkDir(workRoot, '0xdone');
    driveToComplete(persistence, '0xdone');

    const report = engine.reapWorkDirsNow();

    expect(existsSync(dir)).toBe(false);
    expect(report.removed).toContain('0xdone');
  });

  it('reapWorkDirsNow removes the work dir of a FAILED task', () => {
    persistence.insertDiscovered(makeInput('0xbroke'));
    const dir = makeWorkDir(workRoot, '0xbroke');
    persistence.markFailed('0xbroke', 'harness blew up');

    const report = engine.reapWorkDirsNow();

    expect(existsSync(dir)).toBe(false);
    expect(report.removed).toContain('0xbroke');
  });

  it('reapWorkDirsNow never removes the work dir of an in-flight task', () => {
    persistence.insertDiscovered(makeInput('0xrunning'));
    persistence.transition('0xrunning', TaskRunState.CLAIMED);
    persistence.transition('0xrunning', TaskRunState.WAITING);
    persistence.transition('0xrunning', TaskRunState.PRE_SNAPSHOT);
    persistence.transition('0xrunning', TaskRunState.RUNNING);
    const dir = makeWorkDir(workRoot, '0xrunning');

    const report = engine.reapWorkDirsNow();

    expect(existsSync(dir)).toBe(true);
    expect(report.removed).not.toContain('0xrunning');
    expect(report.protected).toContain('0xrunning');
  });

  it('reapWorkDirsNow clears a backlog of completed dirs in one pass', () => {
    const ids = Array.from({ length: 8 }, (_, i) => `0xbacklog-${i}`);
    for (const id of ids) {
      persistence.insertDiscovered(makeInput(id));
      makeWorkDir(workRoot, id);
      driveToComplete(persistence, id);
    }

    const report = engine.reapWorkDirsNow();

    for (const id of ids) expect(existsSync(join(workRoot, id))).toBe(false);
    expect(report.removed.sort()).toEqual([...ids].sort());
  });

  it('tick() reaps terminal work dirs alongside advancing in-flight tasks', async () => {
    persistence.insertDiscovered(makeInput('0xdone'));
    const doneDir = makeWorkDir(workRoot, '0xdone');
    driveToComplete(persistence, '0xdone');

    await engine.tick();

    expect(existsSync(doneDir)).toBe(false);
  });
});
