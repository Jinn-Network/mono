import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { Daemon, type DaemonConfig } from '../../src/daemon/daemon.js';
import { LocalAdapter } from '../../src/adapters/local/adapter.js';
import { SimpleRunner } from '../../src/runner/simple.js';
import { HarnessRegistry } from '../../src/harnesses/engine/registry.js';
import { getEventBuffer } from '../../src/events/emitter.js';
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
 * The mech-adapter's `claimDelivery` failure path is paired-emitted in the
 * same change; coverage of that path is left to the daemon-harness e2e
 * (`yarn e2e:daemon-harness`) because it requires the on-chain plumbing
 * the unit-level harness cannot stand up cheaply.
 */

class FailingClaimLocalAdapter extends LocalAdapter {
  readonly failureMessage: string;

  constructor(failureMessage = 'forced claim failure') {
    super();
    this.failureMessage = failureMessage;
  }

  override async claimTask(_taskId: string): Promise<TaskRequest> {
    throw new Error(this.failureMessage);
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
    const adapter = new FailingClaimLocalAdapter('forced claim failure');
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
});
