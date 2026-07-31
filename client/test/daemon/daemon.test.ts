import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { Daemon, type DaemonConfig } from '../../src/daemon/daemon.js';
import { LocalAdapter } from '../../src/adapters/local/adapter.js';
import { SimpleRunner } from '../../src/runner/simple.js';
import { HarnessRegistry } from '../../src/harnesses/engine/registry.js';

function minimalEngineConfig(): DaemonConfig['restorationEngine'] {
  const root = mkdtempSync(join(tmpdir(), 'jinn-daemon-test-'));
  const implRegistry = new HarnessRegistry({ default: 'legacy-claude' });
  return {
    implRegistry,
    paths: {
      workingDirRoot: join(root, 'work'),
      implStateDirRoot: join(root, 'impl-state'),
    },
  };
}

describe('Daemon', () => {
  it('initializes and stops cleanly', async () => {
    const config: DaemonConfig = {
      adapter: new LocalAdapter(),
      runner: new SimpleRunner(async (desc) => `Done: ${desc}`),
      taskSources: [],
      dbPath: ':memory:',
      restorationEngine: minimalEngineConfig(),
    };

    const daemon = new Daemon(config);
    await daemon.start();
    await daemon.stop();
  });

  it('tracks shutdown state in store', async () => {
    const config: DaemonConfig = {
      adapter: new LocalAdapter(),
      runner: new SimpleRunner(async (desc) => `Done: ${desc}`),
      taskSources: [],
      dbPath: ':memory:',
      restorationEngine: minimalEngineConfig(),
    };

    const daemon = new Daemon(config);
    await daemon.start();
    expect(daemon.getShutdownState()).toBe('running');
    await daemon.stop();
    expect(daemon.getShutdownState()).toBe('clean');
  });

  it('accepts static configured Tasks when taskSources are omitted', async () => {
    const config: DaemonConfig = {
      adapter: new LocalAdapter(),
      runner: new SimpleRunner(async (desc) => `Done: ${desc}`),
      tasks: [{ id: 'legacy-static', description: 'legacy static task' }],
      dbPath: ':memory:',
      restorationEngine: minimalEngineConfig(),
    };

    const daemon = new Daemon(config);
    await daemon.start();
    await daemon.stop();
    expect(daemon.getShutdownState()).toBe('clean');
  });

  it('persists a recent runStartedAt after claiming a task with an old window start', async () => {
    const adapter = new LocalAdapter();
    const dbPath = join(mkdtempSync(join(tmpdir(), 'jinn-daemon-started-test-')), 'jinn.db');
    const daemon = new Daemon({
      adapter,
      runner: new SimpleRunner(async (desc) => `Done: ${desc}`),
      taskSources: [],
      dbPath,
      restorationEngine: minimalEngineConfig(),
    });
    await daemon.start();

    try {
      const beforeClaim = Date.now();
      const oldWindowStart = beforeClaim - 6 * 86_400_000;
      // Cutover stage 1 (docs/superpowers/plans/2026-07-30-cutover-stage-1-solver-flow.md
      // Task 16): _runEngineWatcherLoop now skips any announcement whose task.role
      // isn't 'evaluation' before it reaches claimTask, so this task must carry
      // role: 'evaluation' to still get claimed — the runStartedAt persistence
      // behavior under test is unrelated to role.
      await adapter.postTask({
        id: 'old-window-fresh-claim',
        description: 'old window, newly claimed',
        role: 'evaluation',
        window: { startTs: oldWindowStart, endTs: beforeClaim + 3_600_000 },
      });

      await waitForTaskRunRow(dbPath, '1');
      const afterClaim = Date.now();
      await daemon.stop();

      const db = new Database(dbPath, { readonly: true });
      try {
        const row = db
          .prepare(
            `SELECT window_start_ts, run_started_at
             FROM task_runs
             WHERE task_id = ?`,
          )
          .get('1') as { window_start_ts: number; run_started_at: number };
        expect(row.window_start_ts).toBe(oldWindowStart);
        expect(row.run_started_at).toBeGreaterThanOrEqual(beforeClaim);
        expect(row.run_started_at).toBeLessThanOrEqual(afterClaim);
      } finally {
        db.close();
      }
    } finally {
      if (daemon.getShutdownState() !== 'clean') {
        await daemon.stop();
      }
    }
  });
});

async function waitForTaskRunRow(
  dbPath: string,
  taskId: string,
): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    let db: Database.Database | undefined;
    try {
      db = new Database(dbPath, { readonly: true, fileMustExist: true });
      const row = db
        .prepare(
          `SELECT 1
           FROM task_runs
           WHERE task_id = ?`,
        )
        .get(taskId) as { 1: number } | undefined;
      if (row) return;
    } catch {
      // DB file may not exist during the first few milliseconds of daemon startup.
    } finally {
      db?.close();
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for task run row for taskId ${taskId}`);
}
