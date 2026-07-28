import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Store } from '../../../src/store/store.js';
import { TaskEngine } from '../../../src/harnesses/engine/engine.js';
import {
  TaskRunPersistence,
  type PersistedTaskRunInput,
} from '../../../src/harnesses/engine/persistence.js';
import {
  FAILED_ADOPTION_IDENTITY_REASON,
  recoverFailedAdoption,
} from '../../../src/harnesses/engine/failed-adoption-recovery.js';
import { TaskRunState } from '../../../src/harnesses/engine/state.js';

const REQUEST_ID = `0x${'e5'.repeat(32)}`;
const TASK_ID = '1197';
const ATTEMPT_INDEX = 0;
const V2_ATTEMPT_ID = 'f89a8583-f726-4b0c-b0d0-0bd7019b4e10';
const SEMANTIC_ID = `autopilot:${V2_ATTEMPT_ID}`;
const SOLVER_NET_MANIFEST_CID =
  'bafkreihvpooczub6s7c3yuraotwe43xbu4dliowmnkymegct66ddgrlaoa';
const MANIFEST_CID =
  'bafkreihwxqps24q5wy2lxpu6ktbongiegyjpdcvu7wdjpwy3nwce3v2wpm';
const DELIVERY_TX_HASH = `0x${'d5'.repeat(32)}`;
const DELIVERY_DIGEST =
  '0xf6bc1f2d721db634bbbe9e54c2e699043612f18ab4fd8697db1b6d844dd7567b';
const EVIDENCE_HASH = `0x${'05'.repeat(32)}`;
const DELIVERY_ANCHOR_TX_HASH = `0x${'57'.repeat(32)}`;
const DELIVERY_ANCHOR_BLOCK = 44_742_222;
const MANIFEST_GENERATED_AT = 1_785_252_720_329;
const CLAIM_OID = 'f20b17dc524c390a431b0e5d5501bdee6d489de7';
const EXPECTED_HEAD = CLAIM_OID;
const PR_NUMBER = 2267;
const ADOPTION_WAIT_STARTED_AT = 1_785_252_732_978;
const NEXT_OBSERVATION_AT = 1_785_252_744_669;
const FAILURE_AT = 1_785_252_800_000;
const RECOVERED_AT = 1_785_253_000_000;
const CONTRADICTION_DETAIL =
  'persisted runtime Task identity or role is contradictory';

function session() {
  return {
    schemaVersion: 'jinn-autopilot-session.v1' as const,
    workflow: 'implement' as const,
    repository: 'Jinn-Network/mono',
    language: 'typescript',
    verificationProfile: 'jinn-mono.v1',
    issueNumber: 2266,
    prNumber: PR_NUMBER,
    targetBase: 'next',
    branch: 'autopilot/2266',
    claimOid: CLAIM_OID,
    expectedHead: EXPECTED_HEAD,
    v2AttemptId: V2_ATTEMPT_ID,
    runnerId: 'marketplace-canary-2266-20260728t1518z',
    taskSnapshot: {
      title: 'Add marketplace canary marker',
      body: 'Add the exact marker.',
      prBody: 'Autopilot implementation claim.',
      baseSha: 'd'.repeat(40),
      targetBaseOid: 'd'.repeat(40),
    },
    workflowContract: {
      skill: 'implement-issue' as const,
      version: 'v2' as const,
      resultSchema: 'jinn-autopilot-mutation-result.v1' as const,
    },
    deadline: '2026-07-28T16:21:35.107Z',
    receiptAuthors: ['ritsuKai2000', 'ritsukai'],
  };
}

function taskSpec() {
  return {
    schemaVersion: 'jinn-repo.v1' as const,
    source: 'autopilot-session' as const,
    instance_id: SEMANTIC_ID,
    repo: 'Jinn-Network/mono',
    base_commit: EXPECTED_HEAD,
    language: 'typescript',
    verificationProfile: 'jinn-mono.v1',
    problem_statement: 'Add the exact marketplace canary marker.',
    session: session(),
  };
}

function taskInput(): PersistedTaskRunInput {
  return {
    requestId: REQUEST_ID,
    taskId: TASK_ID,
    attemptIndex: ATTEMPT_INDEX,
    taskCid:
      'f015512203261701212f0221b2a84af434d81ffbe75e6be0704ef8973c26eaab5760eb29d',
    onchainCreationTx: `0x${'0e'.repeat(32)}`,
    onchainCreationBlock: 44_741_907,
    solverType: 'jinn-repo.v1',
    taskRole: 'restoration',
    windowStartTs: Date.now() - 60_000,
    windowEndTs: Date.now() + 3_600_000,
    task: {
      id: SEMANTIC_ID,
      description: 'Autopilot marketplace session',
      solverType: 'jinn-repo.v1',
      solverNetManifestCid: SOLVER_NET_MANIFEST_CID,
      contractId: 'jinn-repo',
      contractVersion: 'v1',
      role: 'restoration',
      spec: taskSpec(),
    },
  };
}

function solutionOutputsJson(): string {
  return JSON.stringify({
    venueRef: { name: 'jinn-repo' },
    gating: {},
    solutionPayload: {
      schemaVersion: 'jinn-autopilot-mutation-result.v1',
      outcome: 'mutation-complete',
      correlation: {
        taskId: TASK_ID,
        attemptIndex: ATTEMPT_INDEX,
        requestId: REQUEST_ID,
        v2AttemptId: V2_ATTEMPT_ID,
        claimOid: CLAIM_OID,
        prNumber: PR_NUMBER,
        expectedHead: EXPECTED_HEAD,
      },
      patch:
        'diff --git a/client/docs/canary.md b/client/docs/canary.md\n'
        + 'new file mode 100644\n'
        + '+JINN_MARKETPLACE_CANARY\n',
      summary: 'Added the canary marker.',
      evidence: {
        commands: ['test -f client/docs/canary.md'],
        tests: ['marker exact'],
      },
    },
  });
}

function seedFalseContradiction(
  store: Store,
  persistence: TaskRunPersistence,
): void {
  persistence.insertDiscovered(taskInput());
  store.db.prepare(`
    UPDATE task_runs
    SET state = 'AWAITING_ADOPTION',
        state_updated_at = ?,
        manifest_cid = ?,
        delivery_tx_hash = ?,
        delivery_digest = ?,
        delivery_discovery_anchor_tx_hash = ?,
        delivery_discovery_anchor_block_number = ?,
        artifact_cids = ?,
        manifest_generated_at = ?,
        evidence_hash = ?,
        solution_outputs_json = ?,
        adoption_receipt_location = ?,
        adoption_receipt_authors = ?,
        adoption_wait_started_at = ?,
        adoption_next_observation_at = ?
    WHERE request_id = ?
  `).run(
    ADOPTION_WAIT_STARTED_AT,
    MANIFEST_CID,
    DELIVERY_TX_HASH,
    DELIVERY_DIGEST,
    DELIVERY_ANCHOR_TX_HASH,
    DELIVERY_ANCHOR_BLOCK,
    JSON.stringify({
      '.execute/solution-payload.json': 'solution-artifact-digest',
      'system_snapshot.tar.gz': 'snapshot-artifact-digest',
    }),
    MANIFEST_GENERATED_AT,
    EVIDENCE_HASH,
    solutionOutputsJson(),
    JSON.stringify({
      repository: 'Jinn-Network/mono',
      prNumber: PR_NUMBER,
    }),
    JSON.stringify(session().receiptAuthors),
    ADOPTION_WAIT_STARTED_AT,
    NEXT_OBSERVATION_AT,
    REQUEST_ID,
  );
  persistence.setAdoptionObservation(
    REQUEST_ID,
    { state: 'contradictory', detail: CONTRADICTION_DETAIL },
    NEXT_OBSERVATION_AT,
  );
  persistence.markFailed(REQUEST_ID, FAILED_ADOPTION_IDENTITY_REASON);
  store.db.prepare(`
    UPDATE task_runs
    SET state_updated_at = ?, failure_at = ?
    WHERE request_id = ?
  `).run(FAILURE_AT, FAILURE_AT, REQUEST_ID);
}

function rawRow(store: Store): Record<string, unknown> {
  return store.db.prepare(
    'SELECT * FROM task_runs WHERE request_id = ?',
  ).get(REQUEST_ID) as Record<string, unknown>;
}

describe('exact failed-adoption recovery', () => {
  let store: Store;
  let persistence: TaskRunPersistence;

  beforeEach(() => {
    store = new Store(':memory:');
    persistence = new TaskRunPersistence(store.db);
    seedFalseContradiction(store, persistence);
  });

  afterEach(() => {
    store.close();
  });

  it('dry-runs every guard without changing one persisted byte', () => {
    const before = rawRow(store);

    expect(recoverFailedAdoption({
      persistence,
      requestId: REQUEST_ID,
      mode: 'dry-run',
      now: () => RECOVERED_AT,
    })).toEqual({
      status: 'eligible',
      requestId: REQUEST_ID,
      previousState: TaskRunState.FAILED,
      targetState: TaskRunState.AWAITING_ADOPTION,
    });

    expect(rawRow(store)).toEqual(before);
  });

  it('applies one exact CAS and changes only recovery state columns', () => {
    const before = rawRow(store);
    const result = recoverFailedAdoption({
      persistence,
      requestId: REQUEST_ID,
      mode: 'apply',
      now: () => RECOVERED_AT,
    });
    const after = rawRow(store);

    expect(result).toEqual({
      status: 'recovered',
      requestId: REQUEST_ID,
      previousState: TaskRunState.FAILED,
      targetState: TaskRunState.AWAITING_ADOPTION,
    });

    const mutableColumns = new Set([
      'state',
      'state_updated_at',
      'failure_reason',
      'failure_at',
      'adoption_last_error',
      'adoption_next_observation_at',
    ]);
    for (const [column, value] of Object.entries(before)) {
      if (!mutableColumns.has(column)) {
        expect(after[column], column).toEqual(value);
      }
    }
    expect(after).toMatchObject({
      state: TaskRunState.AWAITING_ADOPTION,
      state_updated_at: RECOVERED_AT,
      failure_reason: null,
      failure_at: null,
      adoption_last_error: null,
      adoption_next_observation_at: RECOVERED_AT,
      adoption_observation_attempts: 1,
      adoption_last_observation: JSON.stringify({
        state: 'contradictory',
        detail: CONTRADICTION_DETAIL,
      }),
      manifest_cid: MANIFEST_CID,
      delivery_tx_hash: DELIVERY_TX_HASH,
      delivery_digest: DELIVERY_DIGEST,
      delivery_discovery_anchor_tx_hash: DELIVERY_ANCHOR_TX_HASH,
      delivery_discovery_anchor_block_number: DELIVERY_ANCHOR_BLOCK,
      manifest_generated_at: MANIFEST_GENERATED_AT,
      evidence_hash: EVIDENCE_HASH,
    });

    expect(recoverFailedAdoption({
      persistence,
      requestId: REQUEST_ID,
      mode: 'apply',
      now: () => RECOVERED_AT + 1,
    })).toMatchObject({
      status: 'refused',
      reason: expect.stringMatching(/FAILED/i),
    });
  });

  it.each([
    ['recovery-critical scheduling state', (db: Store['db']) => db.prepare(`
      UPDATE task_runs
      SET adoption_next_observation_at = adoption_next_observation_at + 1
      WHERE request_id = ?
    `).run(REQUEST_ID)],
    ['preserved execution state', (db: Store['db']) => db.prepare(`
      UPDATE task_runs
      SET working_dir = '/concurrent-change'
      WHERE request_id = ?
    `).run(REQUEST_ID)],
  ] as const)('loses the exhaustive CAS when %s changes', (_name, mutate) => {
    const validated = persistence.getOrThrow(REQUEST_ID);
    mutate(store.db);

    expect(
      persistence.requeueFailedAdoptionObservation(
        validated,
        RECOVERED_AT,
      ),
    ).toBe(false);
    expect(persistence.getOrThrow(REQUEST_ID).state).toBe(TaskRunState.FAILED);
  });

  it('re-enters only receipt observation during normal engine recovery', async () => {
    recoverFailedAdoption({
      persistence,
      requestId: REQUEST_ID,
      mode: 'apply',
      now: () => RECOVERED_AT,
    });
    const observer = {
      observe: vi.fn().mockResolvedValue({
        state: 'pending' as const,
        observedAt: '2026-07-28T15:40:00.000Z',
        detail: 'receipt not published yet',
      }),
    };
    const engine = new TaskEngine({
      store,
      paths: {
        workingDirRoot: '/must-not-execute',
        implStateDirRoot: '/must-not-execute',
      },
      adoptionReceiptObserver: observer,
    });

    await engine.recoverInFlight();

    expect(observer.observe).toHaveBeenCalledOnce();
    expect(persistence.getOrThrow(REQUEST_ID)).toMatchObject({
      state: TaskRunState.AWAITING_ADOPTION,
      deliveryTxHash: DELIVERY_TX_HASH,
      manifestCid: MANIFEST_CID,
      adoptionLastObservation: {
        state: 'pending',
        detail: 'receipt not published yet',
      },
    });
  });

  it('refuses an invalid recovery clock without changing the eligible row', () => {
    const before = rawRow(store);

    expect(recoverFailedAdoption({
      persistence,
      requestId: REQUEST_ID,
      mode: 'apply',
      now: () => Number.NaN,
    })).toMatchObject({
      status: 'refused',
      reason: expect.stringMatching(/clock/i),
    });
    expect(rawRow(store)).toEqual(before);
  });

  it('refuses a recovery clock that would move durable state backward', () => {
    const before = rawRow(store);

    expect(recoverFailedAdoption({
      persistence,
      requestId: REQUEST_ID,
      mode: 'apply',
      now: () => FAILURE_AT - 1,
    })).toMatchObject({
      status: 'refused',
      reason: expect.stringMatching(/clock|timestamp/i),
    });
    expect(rawRow(store)).toEqual(before);
  });

  it.each([
    ['missing row', () => {}, `0x${'00'.repeat(32)}`, /not found/i],
    ['non-FAILED state', (db: Store['db']) => db.prepare(
      `UPDATE task_runs SET state = 'AWAITING_ADOPTION' WHERE request_id = ?`,
    ).run(REQUEST_ID), REQUEST_ID, /FAILED/i],
    ['different failure', (db: Store['db']) => db.prepare(
      `UPDATE task_runs SET failure_reason = 'other' WHERE request_id = ?`,
    ).run(REQUEST_ID), REQUEST_ID, /failure/i],
    ['different observation', (db: Store['db']) => db.prepare(
      `UPDATE task_runs SET adoption_last_observation = ? WHERE request_id = ?`,
    ).run(JSON.stringify({ state: 'contradictory', detail: 'other' }), REQUEST_ID), REQUEST_ID, /observation/i],
    ['accepted receipt present', (db: Store['db']) => db.prepare(
      `UPDATE task_runs SET adoption_accepted_receipt = '{}' WHERE request_id = ?`,
    ).run(REQUEST_ID), REQUEST_ID, /accepted receipt/i],
    ['adoption error present', (db: Store['db']) => db.prepare(
      `UPDATE task_runs SET adoption_last_error = 'old error' WHERE request_id = ?`,
    ).run(REQUEST_ID), REQUEST_ID, /adoption error/i],
    ['wrong observation count', (db: Store['db']) => db.prepare(
      `UPDATE task_runs SET adoption_observation_attempts = 2 WHERE request_id = ?`,
    ).run(REQUEST_ID), REQUEST_ID, /observation count/i],
    ['non-numeric Task ID', (db: Store['db']) => db.prepare(
      `UPDATE task_runs SET task_id = 'task-1197' WHERE request_id = ?`,
    ).run(REQUEST_ID), REQUEST_ID, /Task ID/i],
    ['missing attempt', (db: Store['db']) => db.prepare(
      `UPDATE task_runs SET attempt_index = NULL WHERE request_id = ?`,
    ).run(REQUEST_ID), REQUEST_ID, /attempt/i],
    ['wrong solver type', (db: Store['db']) => db.prepare(
      `UPDATE task_runs SET solver_type = 'portfolio.v0' WHERE request_id = ?`,
    ).run(REQUEST_ID), REQUEST_ID, /Autopilot|runtime|solver/i],
    ['wrong persisted role', (db: Store['db']) => db.prepare(
      `UPDATE task_runs SET task_role = 'evaluation' WHERE request_id = ?`,
    ).run(REQUEST_ID), REQUEST_ID, /role|output/i],
    ['wrong runtime semantic ID', (db: Store['db']) => db.prepare(`
      UPDATE task_runs
      SET task_payload = json_set(task_payload, '$.id', 'autopilot:wrong')
      WHERE request_id = ?
    `).run(REQUEST_ID), REQUEST_ID, /identity/i],
    ['wrong strict instance ID', (db: Store['db']) => db.prepare(`
      UPDATE task_runs
      SET task_payload = json_set(
        json_set(task_payload, '$.id', 'autopilot:wrong'),
        '$.spec.instance_id',
        'autopilot:wrong'
      )
      WHERE request_id = ?
    `).run(REQUEST_ID), REQUEST_ID, /identity/i],
    ['wrong runtime role', (db: Store['db']) => db.prepare(`
      UPDATE task_runs
      SET task_payload = json_set(task_payload, '$.role', 'evaluation')
      WHERE request_id = ?
    `).run(REQUEST_ID), REQUEST_ID, /role/i],
    ['wrong runtime contract', (db: Store['db']) => db.prepare(`
      UPDATE task_runs
      SET task_payload = json_set(task_payload, '$.contractId', 'portfolio')
      WHERE request_id = ?
    `).run(REQUEST_ID), REQUEST_ID, /runtime|contract/i],
    ['invalid Task creation evidence', (db: Store['db']) => db.prepare(
      `UPDATE task_runs SET onchain_creation_tx = 'bad' WHERE request_id = ?`,
    ).run(REQUEST_ID), REQUEST_ID, /Task creation evidence/i],
    ['invalid Task CID', (db: Store['db']) => db.prepare(
      `UPDATE task_runs SET task_cid = 'printable-but-not-a-cid' WHERE request_id = ?`,
    ).run(REQUEST_ID), REQUEST_ID, /Task creation evidence|Task CID/i],
    ['zero Task creation block', (db: Store['db']) => db.prepare(
      `UPDATE task_runs SET onchain_creation_block = 0 WHERE request_id = ?`,
    ).run(REQUEST_ID), REQUEST_ID, /Task creation evidence/i],
    ['missing SolverNet manifest', (db: Store['db']) => db.prepare(
      `UPDATE task_runs SET solver_net_manifest_cid = NULL WHERE request_id = ?`,
    ).run(REQUEST_ID), REQUEST_ID, /SolverNet manifest/i],
    ['invalid SolverNet manifest', (db: Store['db']) => db.prepare(
      `UPDATE task_runs SET solver_net_manifest_cid = 'printable-but-not-a-cid' WHERE request_id = ?`,
    ).run(REQUEST_ID), REQUEST_ID, /SolverNet manifest/i],
    ['runtime SolverNet manifest mismatch', (db: Store['db']) => db.prepare(`
      UPDATE task_runs
      SET task_payload = json_set(
        task_payload,
        '$.solverNetManifestCid',
        ?
      )
      WHERE request_id = ?
    `).run(MANIFEST_CID, REQUEST_ID), REQUEST_ID, /SolverNet manifest/i],
    ['wrong receipt location', (db: Store['db']) => db.prepare(`
      UPDATE task_runs
      SET adoption_receipt_location = json_set(
        adoption_receipt_location,
        '$.prNumber',
        9999
      )
      WHERE request_id = ?
    `).run(REQUEST_ID), REQUEST_ID, /receipt policy/i],
    ['wrong receipt authors', (db: Store['db']) => db.prepare(`
      UPDATE task_runs
      SET adoption_receipt_authors = '["attacker"]'
      WHERE request_id = ?
    `).run(REQUEST_ID), REQUEST_ID, /receipt policy/i],
    ['wrong output correlation', (db: Store['db']) => db.prepare(`
      UPDATE task_runs
      SET solution_outputs_json = json_set(
        solution_outputs_json,
        '$.solutionPayload.correlation.taskId',
        '1198'
      )
      WHERE request_id = ?
    `).run(REQUEST_ID), REQUEST_ID, /correlation/i],
    ['missing manifest CID', (db: Store['db']) => db.prepare(
      `UPDATE task_runs SET manifest_cid = NULL WHERE request_id = ?`,
    ).run(REQUEST_ID), REQUEST_ID, /manifest|envelope/i],
    ['invalid delivery transaction', (db: Store['db']) => db.prepare(
      `UPDATE task_runs SET delivery_tx_hash = 'bad' WHERE request_id = ?`,
    ).run(REQUEST_ID), REQUEST_ID, /delivery transaction/i],
    ['invalid delivery digest', (db: Store['db']) => db.prepare(
      `UPDATE task_runs SET delivery_digest = 'bad' WHERE request_id = ?`,
    ).run(REQUEST_ID), REQUEST_ID, /delivery digest/i],
    ['mismatched delivery digest', (db: Store['db']) => db.prepare(
      `UPDATE task_runs SET delivery_digest = ? WHERE request_id = ?`,
    ).run(`0x${'11'.repeat(32)}`, REQUEST_ID), REQUEST_ID, /delivery digest/i],
    ['invalid delivery anchor transaction', (db: Store['db']) => db.prepare(
      `UPDATE task_runs SET delivery_discovery_anchor_tx_hash = 'bad' WHERE request_id = ?`,
    ).run(REQUEST_ID), REQUEST_ID, /delivery anchor transaction/i],
    ['missing delivery anchor block', (db: Store['db']) => db.prepare(
      `UPDATE task_runs SET delivery_discovery_anchor_block_number = NULL WHERE request_id = ?`,
    ).run(REQUEST_ID), REQUEST_ID, /delivery anchor block/i],
    ['zero delivery anchor block', (db: Store['db']) => db.prepare(
      `UPDATE task_runs SET delivery_discovery_anchor_block_number = 0 WHERE request_id = ?`,
    ).run(REQUEST_ID), REQUEST_ID, /delivery anchor block/i],
    ['invalid evidence hash', (db: Store['db']) => db.prepare(
      `UPDATE task_runs SET evidence_hash = 'bad' WHERE request_id = ?`,
    ).run(REQUEST_ID), REQUEST_ID, /evidence hash/i],
    ['missing manifest timestamp', (db: Store['db']) => db.prepare(
      `UPDATE task_runs SET manifest_generated_at = NULL WHERE request_id = ?`,
    ).run(REQUEST_ID), REQUEST_ID, /manifest timestamp/i],
    ['missing delivery artifacts', (db: Store['db']) => db.prepare(
      `UPDATE task_runs SET artifact_cids = NULL WHERE request_id = ?`,
    ).run(REQUEST_ID), REQUEST_ID, /delivery artifacts/i],
    ['empty delivery artifacts', (db: Store['db']) => db.prepare(
      `UPDATE task_runs SET artifact_cids = '{}' WHERE request_id = ?`,
    ).run(REQUEST_ID), REQUEST_ID, /delivery artifacts/i],
    ['missing adoption wait', (db: Store['db']) => db.prepare(
      `UPDATE task_runs SET adoption_wait_started_at = NULL WHERE request_id = ?`,
    ).run(REQUEST_ID), REQUEST_ID, /adoption wait/i],
    ['missing next observation', (db: Store['db']) => db.prepare(
      `UPDATE task_runs SET adoption_next_observation_at = NULL WHERE request_id = ?`,
    ).run(REQUEST_ID), REQUEST_ID, /next observation/i],
    ['missing failure timestamp', (db: Store['db']) => db.prepare(
      `UPDATE task_runs SET failure_at = NULL WHERE request_id = ?`,
    ).run(REQUEST_ID), REQUEST_ID, /failure timestamp/i],
    ['inconsistent failure timestamp', (db: Store['db']) => db.prepare(
      `UPDATE task_runs SET state_updated_at = state_updated_at + 1 WHERE request_id = ?`,
    ).run(REQUEST_ID), REQUEST_ID, /failure timestamp/i],
  ] as const)(
    'refuses %s',
    (_name, mutate, requestId, reason) => {
      mutate(store.db);

      expect(recoverFailedAdoption({
        persistence,
        requestId,
        mode: 'dry-run',
        now: () => RECOVERED_AT,
      })).toMatchObject({
        status: 'refused',
        requestId,
        reason: expect.stringMatching(reason),
      });
    },
  );
});
