/**
 * Shared-Store coexistence (one-swap M2, umbrella #2461, risk 2).
 *
 * The load-bearing difference between the retiring `native-main.ts` solver host and the ONE
 * multi-role fleet daemon is WHERE native state lives. `native-solver-production.ts` opens its
 * own `Store(join(stateDir, 'solver.sqlite'))`; the fleet daemon's native composition runs
 * `NativeOperatorStateRepository` over the SAME `Store(config.dbPath)` the legacy readers, the
 * projector cursor, and `task_runs` already use — because the R1 read-plane repoint needs the
 * native tables in the database the API layer already opens.
 *
 * This file pins that coexistence: one connection, both DDLs, interleaved writes and reads from
 * both planes, plus the concurrency posture (WAL + busy timeout) two Store handles on one file
 * actually get.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../../src/store/store.js';
import {
  NATIVE_OPERATOR_STATE_SCHEMA_VERSION,
  NativeOperatorStateRepository,
} from '../../src/daemon/native-operator-state.js';
import { engagementId } from '../../src/daemon/native-operation-identity.js';
import { TaskRunPersistence } from '../../src/store/task-run-persistence.js';

const SOURCE = {
  cardId: 1,
  agent: 'urn:jinn:requester:one',
  name: 'native-requester',
  sequence: '0000000000000001',
  entryDigest: `sha256:${'1'.repeat(64)}` as const,
  announcementId: 'announcement-1',
};

const ADMISSION = {
  chainId: 84532,
  coordinator: '0x8a34793e10595c89B7e41Cc7Ff0F76850F44AD98',
  taskId: 7n,
  operatorAgent: 'urn:jinn:operator:solver-a',
  taskDigest: `sha256:${'2'.repeat(64)}` as const,
  submissionUri: 'urn:uuid:33333333-3333-4333-8333-333333333333' as const,
  submissionDigest: `sha256:${'4'.repeat(64)}` as const,
  source: SOURCE,
  decision: { ok: true as const, capability: { ok: true as const }, policy: { ok: true as const } },
};

/** Every table the native planes own inside the shared database. */
const NATIVE_TABLES = [
  'native_operator_state_metadata',
  'native_engagements',
  'native_operations',
  'native_publication_outbox',
  'native_audit_events',
  'native_worker_leases',
  'native_source_processing',
  'native_source_deferrals',
  'native_solution_executions',
  'native_solution_artifacts',
  'native_solution_retries',
  'native_discovery_cards',
] as const;

/** Legacy tables that must be untouched by the native DDL landing beside them. */
const LEGACY_TABLES = ['task_runs', 'activity_events', 'engagement_ledger'] as const;

let root: string;
let dbPath: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'jinn-native-coexistence-'));
  dbPath = join(root, 'jinn.db');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function tableNames(store: Store): Set<string> {
  const rows = store.db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`)
    .all() as { name: string }[];
  return new Set(rows.map(({ name }) => name));
}

function seedDiscoveryCard(store: Store): void {
  store.db.prepare(
    `INSERT INTO native_discovery_cards
       (id, source_agent, source_name, sequence, entry_digest, announcement_id, card_json, accepted_at)
     VALUES (?, ?, ?, ?, ?, ?, '{}', ?)`,
  ).run(
    SOURCE.cardId,
    SOURCE.agent,
    SOURCE.name,
    SOURCE.sequence,
    SOURCE.entryDigest,
    SOURCE.announcementId,
    '2026-08-06T00:00:00.000Z',
  );
}

describe('native repositories over the shared daemon Store', () => {
  it('lands the native tables in the same database file the legacy readers open', () => {
    const store = new Store(dbPath);
    try {
      // The shared Store's own constructor already runs NATIVE_OPERATOR_STATE_SCHEMA and
      // NATIVE_DISCOVERY_SCHEMA (store.ts) -- the fleet path inherits the native tables from
      // the very first open, before any native repository is constructed.
      const beforeRepository = tableNames(store);
      for (const table of NATIVE_TABLES) expect(beforeRepository).toContain(table);
      for (const table of LEGACY_TABLES) expect(beforeRepository).toContain(table);

      const state = new NativeOperatorStateRepository(store, {
        now: () => new Date('2026-08-06T00:00:00Z'),
      });
      expect(state.schemaVersion()).toBe(NATIVE_OPERATOR_STATE_SCHEMA_VERSION);
      // Constructing the repository is additive: it adds no table the shared schema lacked.
      expect([...tableNames(store)].sort()).toEqual([...beforeRepository].sort());
    } finally {
      store.close();
    }
  });

  it('does NOT carry native-solver-production\'s ad hoc corrections table onto the fleet path', () => {
    // `native_solution_discovery_corrections` is created by an inline `store.db.exec` inside
    // `native-solver-production.ts`'s host build, NOT by NATIVE_OPERATOR_STATE_SCHEMA. It is
    // therefore absent from the shared Store, and any fleet-path code that reads it would fail
    // closed rather than read a stale table. Pinned so the reorg-correction reconciliation is
    // ported deliberately (with its DDL) rather than assumed present when M3 wires the loops.
    const store = new Store(dbPath);
    try {
      expect(tableNames(store)).not.toContain('native_solution_discovery_corrections');
    } finally {
      store.close();
    }
  });

  it('interleaves native writes with legacy task_runs and activity reads on one connection', () => {
    const store = new Store(dbPath);
    try {
      const state = new NativeOperatorStateRepository(store, {
        now: () => new Date('2026-08-06T00:00:00Z'),
      });
      const taskRuns = new TaskRunPersistence(store.db);
      seedDiscoveryCard(store);

      // legacy write -> native write -> legacy read -> native read, all on the one handle.
      taskRuns.insertDiscovered({
        requestId: '0xrequest-1',
        taskCid: 'bafyLegacy',
        onchainCreationTx: '0xtx',
        onchainCreationBlock: 1,
        windowStartTs: 0,
        windowEndTs: 0,
      });
      store.recordActivityEvent({ ts: '2026-08-06T00:00:00.000Z', kind: 'legacy_claimed' });

      const admitted = state.recordDecision(ADMISSION);
      expect(admitted.kind).toBe('admitted');

      expect(taskRuns.getByRequestId('0xrequest-1')?.state).toBe('DISCOVERED');
      expect(store.getRecentActivityEvents(10).map(({ kind }) => kind)).toContain('legacy_claimed');
      expect(store.getActivityCountsByKind()['legacy_claimed']).toBe(1);

      expect(state.listEngagements().map(({ engagementId: id }) => id)).toEqual([
        engagementId(ADMISSION),
      ]);

      // Neither plane's row count moved as a side effect of the other's write.
      expect(store.db.prepare(`SELECT COUNT(*) AS n FROM task_runs`).get()).toEqual({ n: 1 });
      expect(store.db.prepare(`SELECT COUNT(*) AS n FROM native_engagements`).get()).toEqual({ n: 1 });
    } finally {
      store.close();
    }
  });

  it('gives both planes WAL and the inherited 5s busy timeout, not a chosen one', () => {
    const store = new Store(dbPath);
    try {
      // WAL is set explicitly by the Store constructor -- readers do not block the native writer.
      expect(String(store.db.pragma('journal_mode', { simple: true })).toLowerCase()).toBe('wal');
      // The busy timeout is better-sqlite3's DEFAULT (`timeout: 5000`), not a value this codebase
      // picked for the shared native/legacy database. Pinned deliberately: if a future change
      // needs a different bound for the native writer, this expectation goes red and forces the
      // choice to be made explicitly rather than inherited.
      expect(store.db.pragma('busy_timeout', { simple: true })).toBe(5000);
    } finally {
      store.close();
    }
  });

  it('lets a second Store handle on the same file read the native rows the first wrote', () => {
    const writer = new Store(dbPath);
    const reader = new Store(dbPath);
    try {
      const state = new NativeOperatorStateRepository(writer, {
        now: () => new Date('2026-08-06T00:00:00Z'),
      });
      seedDiscoveryCard(writer);
      expect(state.recordDecision(ADMISSION).kind).toBe('admitted');

      // WAL: the second connection sees the committed native row without the writer closing.
      expect(reader.db.prepare(`SELECT COUNT(*) AS n FROM native_engagements`).get()).toEqual({ n: 1 });

      // ... and a legacy write on the reader handle commits while the native writer stays open.
      reader.recordActivityEvent({ ts: '2026-08-06T00:01:00.000Z', kind: 'legacy_delivered' });
      expect(writer.getActivityCountsByKind()['legacy_delivered']).toBe(1);
    } finally {
      reader.close();
      writer.close();
    }
  });
});
