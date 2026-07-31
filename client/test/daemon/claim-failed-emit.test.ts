import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach } from 'vitest';
import type { Hex } from 'viem';
import Database from 'better-sqlite3';
import { Daemon, type DaemonConfig } from '../../src/daemon/daemon.js';
import { LocalAdapter } from '../../src/adapters/local/adapter.js';
import { SimpleRunner } from '../../src/runner/simple.js';
import { HarnessRegistry } from '../../src/harnesses/engine/registry.js';
import { getEventBuffer } from '../../src/events/emitter.js';
import { SafeInnerRevertError } from '../../src/adapters/mech/safe-revert.js';
import { Store } from '../../src/store/store.js';
import type { RequestId, TaskRequest } from '../../src/types/index.js';

/**
 * Issue #442 — daemon-side wiring for the `claim_failed` notification.
 *
 * The daemon's task-claim catch path already writes a durable `tick_error`
 * row to the activity table via `emitEvent`. This test pins the new contract:
 * a *paired* `kind: 'intent', errorCode: 'claim_failed'` structured event
 * must also land in the `/v1/events` ring buffer so the operator-app's
 * `useNotifications` hook can surface a notification (the event-driven
 * 12th kind from OPERATOR-APP-SPEC §2.10).
 *
 * The mech-adapter's `ensureDeliveryClaimed` failure path is paired-emitted
 * in the same change; unit-level coverage of that path is deferred to a
 * dedicated follow-up — see #639 — because it requires mocking the on-chain
 * claim plumbing. The daemon-harness e2e (`yarn e2e:daemon-harness`) exercises
 * it indirectly today.
 *
 * Cutover stage 1 (docs/superpowers/plans/2026-07-30-cutover-stage-1-solver-flow.md
 * Task 16): the solution path retired — `_runEngineWatcherLoop` now skips any
 * announcement whose task.role isn't 'evaluation' before it ever reaches
 * canAcceptTask/claimTask. Both posted tasks below now carry role: 'evaluation'
 * so the announcement still reaches the claim-failed emission path under test.
 */

function tcMaxVerdictsRaceLoss(): SafeInnerRevertError {
  return new SafeInnerRevertError(
    'Safe execTransaction inner revert (estimate): TCMaxVerdictsReached(1, 0)',
    '0x39d0ed4c' as Hex,
    null,
    'TCMaxVerdictsReached',
    [1n, 0],
    null,
  );
}

class FailingClaimLocalAdapter extends LocalAdapter {
  constructor(private readonly claimError: Error = new Error('forced claim failure')) {
    super();
  }

  override async claimTask(_taskId: string): Promise<TaskRequest> {
    throw this.claimError;
  }
}

function minimalEngineConfig(): DaemonConfig['restorationEngine'] {
  const root = mkdtempSync(join(tmpdir(), 'jinn-claim-failed-test-'));
  const implRegistry = new HarnessRegistry({ default: 'legacy-claude' });
  return {
    implRegistry,
    paths: {
      workingDirRoot: join(root, 'work'),
      implStateDirRoot: join(root, 'impl-state'),
    },
  };
}

async function waitForRingEvent(
  predicate: (e: { kind: string; errorCode?: string; requestId?: string }) => boolean,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (getEventBuffer().snapshot().some(predicate)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for ring buffer event matching predicate');
}

describe('Daemon claim-failed emission', () => {
  beforeEach(() => {
    getEventBuffer().clear();
  });

  it('emits a paired claim_failed structured event AND a tick_error activity row when claimTask throws', async () => {
    const adapter = new FailingClaimLocalAdapter();
    const dbPath = join(mkdtempSync(join(tmpdir(), 'jinn-claim-failed-db-')), 'jinn.db');

    const daemon = new Daemon({
      adapter,
      runner: new SimpleRunner(async (desc) => `Done: ${desc}`),
      taskSources: [],
      dbPath,
      restorationEngine: minimalEngineConfig(),
    });

    await daemon.start();

    try {
      const posted = await adapter.postTask({
        id: 'claim-failed-task-1',
        description: 'task whose claim is forced to fail',
        role: 'evaluation',
      });

      // Wait for the paired structured event to land in the ring buffer.
      await waitForRingEvent(
        (e) =>
          e.kind === 'intent' &&
          e.errorCode === 'claim_failed' &&
          e.requestId === posted.taskId,
      );

      const events = getEventBuffer().snapshot({ kinds: ['intent'] });
      const matching = events.filter(
        (e) => e.errorCode === 'claim_failed' && e.requestId === posted.taskId,
      );
      expect(matching.length).toBeGreaterThanOrEqual(1);
      expect(matching[0].message).toMatch(/claim/i);

      // The activity-DB row stays — that's the durable record. Stop the
      // daemon so the SQLite handle is closed before we read from the file.
      await daemon.stop();

      const db = new Database(dbPath, { readonly: true });
      try {
        const rows = db
          .prepare(
            `SELECT kind, request_id, outcome
             FROM activity_events
             WHERE request_id = ? AND kind = 'tick_error'`,
          )
          .all(posted.taskId) as Array<{ kind: string; request_id: string; outcome: string | null }>;
        expect(rows.length).toBeGreaterThanOrEqual(1);
        expect(rows[0].outcome).toBe('failed');
      } finally {
        db.close();
      }
    } finally {
      if (daemon.getShutdownState() !== 'clean') {
        await daemon.stop();
      }
    }
  });

  it('does not emit claim_failed when claimTask throws a terminal evaluation race loss (issue #512)', async () => {
    const adapter = new FailingClaimLocalAdapter(tcMaxVerdictsRaceLoss());
    const store = new Store(':memory:');
    const daemon = new Daemon({
      adapter,
      runner: new SimpleRunner(async (desc) => `Done: ${desc}`),
      taskSources: [],
      dbPath: ':memory:',
      store,
      apiPort: 0,
      restorationEngine: minimalEngineConfig(),
    });

    await daemon.start();

    try {
      await adapter.postTask({
        id: 'race-lost-eval-1',
        description: 'evaluation slot already taken',
        role: 'evaluation',
      });

      const deadline = Date.now() + 2_000;
      while (Date.now() < deadline) {
        const raceLost = store.getRecentActivityEvents(50).find((r) => r.kind === 'race_lost');
        if (raceLost) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      expect(store.getRecentActivityEvents(50).find((r) => r.kind === 'race_lost')).toBeDefined();
      expect(
        getEventBuffer().snapshot({ kinds: ['intent'] }).some((e) => e.errorCode === 'claim_failed'),
      ).toBe(false);
      expect(store.getRecentActivityEvents(50).find((r) => r.kind === 'tick_error')).toBeUndefined();
    } finally {
      await daemon.stop();
    }
  });
});
