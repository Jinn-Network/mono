import { describe, expect, it } from 'vitest';
import { withTempStore } from '@test/store.js';
import type { Store } from '@/store/store.js';
import { NativeVerdictTallyReadModel } from '@/store/native-verdict-tally-read-model.js';

/**
 * One-swap R2 (umbrella #2461) — native verdict-tally read model unit tests.
 *
 * The model joins the native projector's `attempt-terminal.v1` observations
 * (`native_canonical_observations`) back to the operator's decimal taskIds
 * through `native_engagements.task_digest`, counting only the two decision-grade
 * verdict poles (`delivered` → pass, `rejected`+`verdict-fail` → fail) and
 * excluding every other terminal. Missing tables degrade to an empty Map.
 */

const OBS_TABLE_DDL = `
  CREATE TABLE IF NOT EXISTS native_canonical_observations (
    observation_id TEXT PRIMARY KEY,
    observation_json TEXT NOT NULL,
    accepted_at TEXT NOT NULL
  );
`;

function ensureObsTable(store: Store): void {
  store.db.exec(OBS_TABLE_DDL);
}

let obsSeq = 0;

/** Insert one canonical observation row (plain JSON — no bigint fields read). */
function insertObservation(
  store: Store,
  observation: { type: string; taskdigest?: string; data: Record<string, unknown> },
): void {
  obsSeq += 1;
  store.db
    .prepare(
      `INSERT INTO native_canonical_observations (observation_id, observation_json, accepted_at)
       VALUES (?, ?, ?)`,
    )
    .run(
      `obs-${obsSeq}`,
      JSON.stringify({
        specversion: '1.0',
        id: `obs-${obsSeq}`,
        source: 'urn:jinn:test',
        subject: `urn:uuid:00000000-0000-0000-0000-${String(obsSeq).padStart(12, '0')}`,
        time: '2026-08-01T00:00:00.000Z',
        datacontenttype: 'application/json',
        sequence: String(obsSeq).padStart(16, '0'),
        ...observation,
      }),
      '2026-08-01T00:00:00.000Z',
    );
}

/** Insert one solve engagement (only the columns the join reads matter). */
function insertEngagement(store: Store, taskId: string, taskDigest: string): void {
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

const ATTEMPT_TERMINAL = 'network.jinn.task-execution.attempt-terminal.v1';
const DIGEST_A = `sha256:${'a'.repeat(64)}`;
const DIGEST_C = `sha256:${'c'.repeat(64)}`;

describe('NativeVerdictTallyReadModel (one-swap R2)', () => {
  it('returns an empty Map when the observation table does not exist yet', async () => {
    await withTempStore(async (store) => {
      insertEngagement(store, '42', DIGEST_A);
      const tallies = new NativeVerdictTallyReadModel(store.db).getVerdictTallies({ taskIds: ['42'] });
      expect(tallies.size).toBe(0);
    });
  });

  it('returns an empty Map for empty taskIds without touching the db', async () => {
    await withTempStore(async (store) => {
      const tallies = new NativeVerdictTallyReadModel(store.db).getVerdictTallies({ taskIds: [] });
      expect(tallies.size).toBe(0);
    });
  });

  it('counts delivered as pass and verdict-fail-rejected as fail, joined by task digest', async () => {
    await withTempStore(async (store) => {
      ensureObsTable(store);
      insertEngagement(store, '42', DIGEST_A);
      insertObservation(store, { type: ATTEMPT_TERMINAL, taskdigest: DIGEST_A, data: { state: 'delivered' } });
      insertObservation(store, { type: ATTEMPT_TERMINAL, taskdigest: DIGEST_A, data: { state: 'delivered' } });
      insertObservation(store, {
        type: ATTEMPT_TERMINAL,
        taskdigest: DIGEST_A,
        data: { state: 'rejected', detail: 'verdict-fail' },
      });

      const tallies = new NativeVerdictTallyReadModel(store.db).getVerdictTallies({ taskIds: ['42'] });
      expect(tallies.get('42')).toEqual({ pass: 2, fail: 1 });
    });
  });

  it('excludes non-verdict and INVALID/INDETERMINATE terminals from both poles', async () => {
    await withTempStore(async (store) => {
      ensureObsTable(store);
      insertEngagement(store, '42', DIGEST_A);
      // Invalid (protocol-violation) and Unresolved (result-unavailable): excluded.
      insertObservation(store, {
        type: ATTEMPT_TERMINAL,
        taskdigest: DIGEST_A,
        data: { state: 'rejected', category: 'protocol-violation' },
      });
      insertObservation(store, {
        type: ATTEMPT_TERMINAL,
        taskdigest: DIGEST_A,
        data: { state: 'failed', category: 'result-unavailable' },
      });
      // Non-verdict terminals sharing the 'rejected' state but not verdict-fail.
      insertObservation(store, {
        type: ATTEMPT_TERMINAL,
        taskdigest: DIGEST_A,
        data: { state: 'rejected', category: 'content-corruption', detail: 'today-mode sha256↔keccak correspondence failed' },
      });
      insertObservation(store, { type: ATTEMPT_TERMINAL, taskdigest: DIGEST_A, data: { state: 'expired' } });
      insertObservation(store, { type: ATTEMPT_TERMINAL, taskdigest: DIGEST_A, data: { state: 'cancelled' } });

      const tallies = new NativeVerdictTallyReadModel(store.db).getVerdictTallies({ taskIds: ['42'] });
      expect(tallies.has('42')).toBe(false);
    });
  });

  it('ignores non-attempt-terminal observation types', async () => {
    await withTempStore(async (store) => {
      ensureObsTable(store);
      insertEngagement(store, '42', DIGEST_A);
      insertObservation(store, {
        type: 'network.jinn.task-execution.delivery-recorded.v1',
        taskdigest: DIGEST_A,
        data: { digest: DIGEST_A, state: 'delivered' },
      });
      const tallies = new NativeVerdictTallyReadModel(store.db).getVerdictTallies({ taskIds: ['42'] });
      expect(tallies.size).toBe(0);
    });
  });

  it('ignores verdicts whose digest matches no requested engagement', async () => {
    await withTempStore(async (store) => {
      ensureObsTable(store);
      insertEngagement(store, '42', DIGEST_A);
      // Verdict for a different task's digest — not one of this operator's requested tasks.
      insertObservation(store, { type: ATTEMPT_TERMINAL, taskdigest: DIGEST_C, data: { state: 'delivered' } });
      const tallies = new NativeVerdictTallyReadModel(store.db).getVerdictTallies({ taskIds: ['42'] });
      expect(tallies.size).toBe(0);
    });
  });

  it('scopes tallies per requested task via the engagement digest join', async () => {
    await withTempStore(async (store) => {
      ensureObsTable(store);
      insertEngagement(store, '42', DIGEST_A);
      insertEngagement(store, '43', DIGEST_C);
      insertObservation(store, { type: ATTEMPT_TERMINAL, taskdigest: DIGEST_A, data: { state: 'delivered' } });
      insertObservation(store, {
        type: ATTEMPT_TERMINAL,
        taskdigest: DIGEST_C,
        data: { state: 'rejected', detail: 'verdict-fail' },
      });

      const tallies = new NativeVerdictTallyReadModel(store.db).getVerdictTallies({ taskIds: ['42', '43'] });
      expect(tallies.get('42')).toEqual({ pass: 1, fail: 0 });
      expect(tallies.get('43')).toEqual({ pass: 0, fail: 1 });
    });
  });
});
