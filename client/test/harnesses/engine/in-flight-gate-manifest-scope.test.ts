// Regression: the engine's single-flight gate must key on
// `{routingKey, solverNetManifestCid}`, not on `routingKey` alone.
//
// Bug (verified live on task 211, 2026-05-22): an operator joined to multiple
// SolverNets that share the same `contract.id.version` routing key (e.g.
// mainline SWE-rebench v2 at one manifest CID and an isolated SWE-rebench v2
// launch at another) had ONE in-flight slot across both SolverNets. While a
// task in SolverNet A was running, every task in SolverNet B was silently
// rejected with `another <routingKey>/<role> task is already in flight` —
// silently because the rejection was de-duped by the watcher's skip-log.
//
// Fix: `hasInFlightFor({ manifestCid })` partitions by SolverNet manifest
// CID, so distinct SolverNets each hold their own slot.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import Database from 'better-sqlite3';

import { Store } from '../../../src/store/store.js';
import { TaskEngine } from '../../../src/harnesses/engine/engine.js';
import {
  TaskRunPersistence,
  type PersistedTaskRunInput,
} from '../../../src/harnesses/engine/persistence.js';
import type { Task } from '../../../src/types/task.js';
import type { Harness, Solution, ReadyStatus } from '../../../src/harnesses/types.js';

const ROUTING_KEY = 'swe-rebench-v2.v1';
const MANIFEST_A = 'bafkreichd-mainline-swe-rebench-v2';
const MANIFEST_B = 'bafkreievik-isolated-swe-rebench-v2';
const MANIFEST_C = 'bafkreiother-third-swe-rebench-v2';

function stubImpl(): Harness {
  return {
    name: 'stub-impl',
    version: '1.0.0',
    supports: () => true,
    isReady: async (): Promise<ReadyStatus> => ({ ready: true }),
    run: async (): Promise<Solution> => ({ venueRef: { name: 'stub' }, gating: {} }),
  };
}

// Cutover stage 1 (docs/superpowers/plans/2026-07-30-cutover-stage-1-solver-flow.md Task 16):
// canAcceptTask({ taskRole: 'restoration', ... }) is now always refused before the
// manifest-scoped in-flight gate below runs (see test/daemon/solution-path-retired.test.ts).
// The gate itself is role-agnostic and unchanged, so this suite (originally 'restoration')
// now probes it via taskRole: 'evaluation', which still reaches runnableFailureReason's
// in-flight check unmodified.
function makeTask(opts: { id: string; manifestCid: string }): Task {
  return {
    id: opts.id,
    description: 'test',
    solverType: ROUTING_KEY,
    contractId: 'swe-rebench-v2',
    contractVersion: 'v1',
    solverNetManifestCid: opts.manifestCid,
    role: 'evaluation',
  } as unknown as Task;
}

function makeInput(opts: { requestId: string; manifestCid: string }): PersistedTaskRunInput {
  const now = Date.now();
  return {
    requestId: opts.requestId,
    taskCid: `bafy-${opts.requestId}`,
    onchainCreationTx: '0xdeadbeef',
    onchainCreationBlock: 1,
    solverType: ROUTING_KEY,
    taskRole: 'evaluation',
    windowStartTs: now + 1_000,
    windowEndTs: now + 60_000,
    task: makeTask({ id: opts.requestId, manifestCid: opts.manifestCid }),
  };
}

class TestEngine extends TaskEngine {
  get db(): import('../../../src/harnesses/engine/persistence.js').TaskRunPersistence {
    return this.persistence;
  }
}

describe('TaskEngine — single-flight gate scoped by solverNetManifestCid', () => {
  let dir: string;
  let store: Store;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'jinn-inflight-manifest-scope-'));
    store = new Store(join(dir, 'jinn.db'));
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function makeEngine(): TestEngine {
    return new TestEngine({
      store,
      paths: { workingDirRoot: join(dir, 'work'), implStateDirRoot: join(dir, 'impl-state') },
      implRegistry: { findFor: () => stubImpl() },
    });
  }

  it('accepts a task in a SolverNet that is NOT yet in flight, even when another SolverNet sharing the same routing key has an in-flight task (bug fix)', async () => {
    const engine = makeEngine();
    // SolverNet A has a DISCOVERED in-flight task on routing key swe-rebench-v2.v1.
    engine.db.insertDiscovered(makeInput({ requestId: 'task-A1', manifestCid: MANIFEST_A }));

    // A task arriving for SolverNet C (different manifest CID, same routing
    // key) must NOT be rejected — each SolverNet holds its own slot.
    const accept = await engine.canAcceptTask({
      solverType: ROUTING_KEY,
      taskRole: 'evaluation',
      task: makeTask({ id: 'task-C1', manifestCid: MANIFEST_C }),
    });

    expect(accept).toEqual({ ok: true });
  });

  it('still rejects a SECOND task whose manifestCid matches an in-flight task (single-flight slot per SolverNet preserved)', async () => {
    const engine = makeEngine();
    engine.db.insertDiscovered(makeInput({ requestId: 'task-A1', manifestCid: MANIFEST_A }));

    // Another task in the SAME SolverNet (matching manifest CID) must still
    // be rejected — the per-SolverNet single-flight slot is preserved.
    const accept = await engine.canAcceptTask({
      solverType: ROUTING_KEY,
      taskRole: 'evaluation',
      task: makeTask({ id: 'task-A2', manifestCid: MANIFEST_A }),
    });

    expect(accept.ok).toBe(false);
    if (!accept.ok) {
      expect(accept.reason).toMatch(/another swe-rebench-v2\.v1\/evaluation task is already in flight/);
    }
  });

  it('accepts the third manifestCid when two distinct SolverNets are already in flight on the same routing key', async () => {
    // The headline scenario: operator is joined to three SolverNets all
    // sharing routing key swe-rebench-v2.v1. Two are in flight; the third
    // must still accept work.
    const engine = makeEngine();
    engine.db.insertDiscovered(makeInput({ requestId: 'task-A1', manifestCid: MANIFEST_A }));
    engine.db.insertDiscovered(makeInput({ requestId: 'task-B1', manifestCid: MANIFEST_B }));

    const accept = await engine.canAcceptTask({
      solverType: ROUTING_KEY,
      taskRole: 'evaluation',
      task: makeTask({ id: 'task-C1', manifestCid: MANIFEST_C }),
    });

    expect(accept).toEqual({ ok: true });

    // …but a fourth task matching one of the in-flight manifestCids is still
    // rejected.
    const reject = await engine.canAcceptTask({
      solverType: ROUTING_KEY,
      taskRole: 'evaluation',
      task: makeTask({ id: 'task-A2', manifestCid: MANIFEST_A }),
    });
    expect(reject.ok).toBe(false);
    if (!reject.ok) {
      expect(reject.reason).toMatch(/another swe-rebench-v2\.v1\/evaluation task is already in flight/);
    }
  });

  it('a terminal in-flight task no longer occupies its SolverNet slot', async () => {
    // Sanity: the manifest scope doesn't break the existing terminal-state
    // filter. Once task-A1 completes, a new task in SolverNet A is accepted.
    const engine = makeEngine();
    engine.db.insertDiscovered(makeInput({ requestId: 'task-A1', manifestCid: MANIFEST_A }));
    // Force the row to a terminal state directly via the DB.
    store.db.prepare(
      "UPDATE task_runs SET state = 'COMPLETE', state_updated_at = ? WHERE request_id = ?",
    ).run(Date.now(), 'task-A1');

    const accept = await engine.canAcceptTask({
      solverType: ROUTING_KEY,
      taskRole: 'evaluation',
      task: makeTask({ id: 'task-A2', manifestCid: MANIFEST_A }),
    });

    expect(accept).toEqual({ ok: true });
  });

  it('persists solver_net_manifest_cid on insertDiscovered for use by the gate', async () => {
    // Schema regression: the column must be populated at insert-time, not
    // only via the JSON backfill in migrations.
    const engine = makeEngine();
    engine.db.insertDiscovered(makeInput({ requestId: 'task-A1', manifestCid: MANIFEST_A }));

    const row = store.db
      .prepare('SELECT solver_net_manifest_cid FROM task_runs WHERE request_id = ?')
      .get('task-A1') as { solver_net_manifest_cid: string | null } | undefined;

    expect(row).toBeDefined();
    expect(row!.solver_net_manifest_cid).toBe(MANIFEST_A);
  });
});

// ── Migration backfill ──────────────────────────────────────────────────────
// Existing operators have in-flight task_runs that pre-date the
// `solver_net_manifest_cid` column. Their `task_payload` JSON does carry
// `solverNetManifestCid`, so the migration backfills the new column from
// that JSON. Without backfill, post-upgrade the gate would treat every
// pre-existing in-flight row as belonging to the "NULL bucket" (a different
// bucket than incoming SolverNet-aware tasks) — fine for correctness, but
// wasted slots. With backfill, the slot accounting is right on day one.
describe('migration: solver_net_manifest_cid backfill from task_payload JSON', () => {
  // DDL for a pre-fix database that still has `task_payload` but no
  // `solver_net_manifest_cid`.
  const PRE_FIX_DDL = `
    CREATE TABLE IF NOT EXISTS task_runs (
      request_id              TEXT PRIMARY KEY,
      task_cid                TEXT NOT NULL,
      onchain_creation_tx     TEXT NOT NULL,
      onchain_creation_block  INTEGER NOT NULL,
      solver_type             TEXT,
      task_role               TEXT,
      impl_name               TEXT,
      state                   TEXT NOT NULL,
      state_updated_at        INTEGER NOT NULL,
      working_dir             TEXT,
      impl_state_dir          TEXT,
      window_start_ts         INTEGER NOT NULL,
      window_end_ts           INTEGER NOT NULL,
      pre_snapshot_captured_at  INTEGER,
      pre_snapshot_payload      TEXT,
      post_snapshot_captured_at INTEGER,
      post_snapshot_payload     TEXT,
      fills_payload             TEXT,
      gating_claim              TEXT,
      informational_claim       TEXT,
      artifact_cids           TEXT,
      manifest_cid            TEXT,
      delivery_tx_hash        TEXT,
      task_payload            TEXT,
      failure_reason          TEXT,
      failure_at              INTEGER
    );
  `;

  it('adds the column and backfills from task_payload.solverNetManifestCid', () => {
    const db = new Database(':memory:');
    db.exec(PRE_FIX_DDL);

    // Pre-fix in-flight row with manifest CID in task_payload but no
    // dedicated column.
    db.prepare(`
      INSERT INTO task_runs (
        request_id, task_cid, onchain_creation_tx, onchain_creation_block,
        solver_type, task_role, state, state_updated_at,
        window_start_ts, window_end_ts, task_payload
      ) VALUES (
        'pre-fix-1', 'bafy-pre', '0xtx', 1,
        'swe-rebench-v2.v1', 'restoration', 'CLAIMED', 100,
        100, 999, ?
      )
    `).run(JSON.stringify({ id: 'pre-fix-1', solverNetManifestCid: MANIFEST_A }));

    // Row that legitimately has no manifest CID (legacy / health-check).
    db.prepare(`
      INSERT INTO task_runs (
        request_id, task_cid, onchain_creation_tx, onchain_creation_block,
        solver_type, task_role, state, state_updated_at,
        window_start_ts, window_end_ts, task_payload
      ) VALUES (
        'pre-fix-legacy', 'bafy-leg', '0xtx', 1,
        'portfolio.v0', 'restoration', 'CLAIMED', 100,
        100, 999, ?
      )
    `).run(JSON.stringify({ id: 'pre-fix-legacy' }));

    // Instantiating TaskRunPersistence runs the additive migrations + backfill.
    new TaskRunPersistence(db);

    const columns = (db.pragma('table_info(task_runs)') as Array<{ name: string }>)
      .map(r => r.name);
    expect(columns).toContain('solver_net_manifest_cid');

    const backfilled = db.prepare(
      'SELECT solver_net_manifest_cid FROM task_runs WHERE request_id = ?',
    ).get('pre-fix-1') as { solver_net_manifest_cid: string | null };
    expect(backfilled.solver_net_manifest_cid).toBe(MANIFEST_A);

    const legacy = db.prepare(
      'SELECT solver_net_manifest_cid FROM task_runs WHERE request_id = ?',
    ).get('pre-fix-legacy') as { solver_net_manifest_cid: string | null };
    expect(legacy.solver_net_manifest_cid).toBeNull();

    db.close();
  });

  it('is idempotent: running migrations twice does not change rows', () => {
    const db = new Database(':memory:');
    db.exec(PRE_FIX_DDL);
    db.prepare(`
      INSERT INTO task_runs (
        request_id, task_cid, onchain_creation_tx, onchain_creation_block,
        solver_type, task_role, state, state_updated_at,
        window_start_ts, window_end_ts, task_payload
      ) VALUES (
        'r-1', 'bafy', '0xtx', 1, 'k.v1', 'restoration', 'CLAIMED', 100, 100, 999, ?
      )
    `).run(JSON.stringify({ id: 'r-1', solverNetManifestCid: MANIFEST_A }));

    new TaskRunPersistence(db);
    new TaskRunPersistence(db); // second invocation — must not throw

    const row = db.prepare(
      'SELECT solver_net_manifest_cid FROM task_runs WHERE request_id = ?',
    ).get('r-1') as { solver_net_manifest_cid: string | null };
    expect(row.solver_net_manifest_cid).toBe(MANIFEST_A);

    db.close();
  });
});
