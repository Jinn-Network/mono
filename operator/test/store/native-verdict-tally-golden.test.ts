import { describe, expect, it } from 'vitest';
import { withTempStore } from '@test/store.js';
import type { Store } from '@/store/store.js';
import { NativeVerdictTallyReadModel } from '@/store/native-verdict-tally-read-model.js';
import { gatherTaskRunsStatus } from '@/api/task-runs-build.js';
import { applyOutcomes } from '@/api/task-runs-build.js';

/**
 * One-swap R2 (umbrella #2461) — GOLDEN outcome-enrichment + PORT-selection proof.
 *
 *  1. Golden: a fixed native seed (solve engagement + verdict observations) drives
 *     the SAME `gatherTaskRunsStatus` → `applyOutcomes` seam gather-status runs,
 *     and pins the resolved task-relative `outcome` per run. This is the wire the
 *     SPA's Activity `Outcome` column reads; a mapping regression fails loudly.
 *  2. Port selection: `Store.verdictTallyReadModel()` is the native read model,
 *     and legacy verdict tallies do NOT come from the Store (they stay on
 *     DiscoveryAPI) — so this method is native-only by construction.
 */

const OBS_TABLE_DDL = `
  CREATE TABLE IF NOT EXISTS native_canonical_observations (
    observation_id TEXT PRIMARY KEY,
    observation_json TEXT NOT NULL,
    accepted_at TEXT NOT NULL
  );
`;

const ATTEMPT_TERMINAL = 'network.jinn.task-execution.attempt-terminal.v1';
const DIGEST_PASS = `sha256:${'a'.repeat(64)}`;
const DIGEST_FAIL = `sha256:${'c'.repeat(64)}`;

let seq = 0;
function insertObservation(store: Store, taskdigest: string, data: Record<string, unknown>): void {
  seq += 1;
  store.db
    .prepare(
      `INSERT INTO native_canonical_observations (observation_id, observation_json, accepted_at)
       VALUES (?, ?, ?)`,
    )
    .run(
      `obs-${seq}`,
      JSON.stringify({ id: `obs-${seq}`, type: ATTEMPT_TERMINAL, taskdigest, data }),
      '2026-08-01T00:00:00.000Z',
    );
}

function insertSolveEngagement(store: Store, taskId: string, taskDigest: string): void {
  store.db
    .prepare(
      `INSERT INTO native_engagements
        (engagement_id, chain_id, coordinator, task_id, role, operator_agent, task_digest,
         submission_uri, submission_digest, state, attempt_index, attempt_uri, request_id,
         policy_json, capability_json, created_at, updated_at)
       VALUES (?, '84532', '0xcoord', ?, 'solver', '0xop', ?,
               'urn:uuid:00000000-0000-0000-0000-000000000001', 'sha256:${'b'.repeat(64)}',
               'solution-settled', 0, NULL, ?, '{}', '{}',
               '2026-08-01T00:00:02.000Z', '2026-08-01T00:00:05.000Z')`,
    )
    .run(`eng-${taskId}`, taskId, taskDigest, `0xreq-${taskId}`);
}

function seedNativeVerdicts(store: Store): void {
  store.db.exec(OBS_TABLE_DDL);
  // Task 301 solved → two PASS verdicts (strict-majority pass).
  insertSolveEngagement(store, '301', DIGEST_PASS);
  insertObservation(store, DIGEST_PASS, { state: 'delivered' });
  insertObservation(store, DIGEST_PASS, { state: 'delivered' });
  // Task 302 solved → two FAIL verdicts (strict-majority fail).
  insertSolveEngagement(store, '302', DIGEST_FAIL);
  insertObservation(store, DIGEST_FAIL, { state: 'rejected', detail: 'verdict-fail' });
  insertObservation(store, DIGEST_FAIL, { state: 'rejected', detail: 'verdict-fail' });
}

describe('native verdict-tally golden outcome enrichment (one-swap R2)', () => {
  it('resolves COMPLETE solve outcomes from the native observation store via the same seam', async () => {
    await withTempStore(async (store) => {
      seedNativeVerdicts(store);

      const taskRuns = gatherTaskRunsStatus(store.taskRunReadModel('native'));
      const solveTaskIds = [
        ...new Set(
          taskRuns.recentTasks
            .filter((r) => r.taskRole !== 'evaluation' && r.state === 'COMPLETE' && r.taskId)
            .map((r) => r.taskId as string),
        ),
      ];
      const tallies = store.verdictTallyReadModel().getVerdictTallies({ taskIds: solveTaskIds });
      applyOutcomes(taskRuns.recentTasks, tallies);

      const byTask = new Map(taskRuns.recentTasks.map((r) => [r.taskId, r.outcome]));
      expect(byTask.get('301')).toBe('pass');
      expect(byTask.get('302')).toBe('fail');
    });
  });

  it('leaves a COMPLETE solve with no observed verdicts at awaiting (never a wrong fail)', async () => {
    await withTempStore(async (store) => {
      store.db.exec(OBS_TABLE_DDL);
      insertSolveEngagement(store, '303', `sha256:${'d'.repeat(64)}`);

      const taskRuns = gatherTaskRunsStatus(store.taskRunReadModel('native'));
      const solveTaskIds = taskRuns.recentTasks
        .filter((r) => r.state === 'COMPLETE' && r.taskId)
        .map((r) => r.taskId as string);
      const tallies = store.verdictTallyReadModel().getVerdictTallies({ taskIds: solveTaskIds });
      applyOutcomes(taskRuns.recentTasks, tallies);

      const row = taskRuns.recentTasks.find((r) => r.taskId === '303');
      expect(row?.state).toBe('COMPLETE');
      expect(row?.outcome).toBe('awaiting');
    });
  });

  it('exposes the native verdict-tally read model from Store.verdictTallyReadModel()', async () => {
    await withTempStore(async (store) => {
      expect(store.verdictTallyReadModel()).toBeInstanceOf(NativeVerdictTallyReadModel);
    });
  });
});
