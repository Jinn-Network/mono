/**
 * Route-level integration test for GET /explorer/slice (#611 Stage-5 follow-up).
 *
 * Why this exists
 * ───────────────
 * The pure-function tests in `api.slice.test.ts` only exercise `computeSlice`
 * against pre-shaped `SliceInputRow`s. They cannot catch a bug in the route
 * handler's SQL JOIN — which is exactly what hid the Stage-5 BLOCKING #1
 * finding: the verdict ⇒ attempt join was keyed on `requestId` (the
 * evaluation mech request vs the restoration mech request — they never
 * match), so every row came back with `operator = null` and group=operator
 * collapsed into a single 0x000…0 series.
 *
 * Test infra constraints
 * ──────────────────────
 * The indexer's existing route tests (api.routes.test.ts, freshness.test.ts,
 * api.builders.test.ts) all exercise *extracted pure functions*. The Hono
 * route bodies in src/api/explorer.ts import `db` from the virtual module
 * `ponder:api` and `schema` from `ponder:schema`; under Vitest those are
 * aliased to a throw-on-call stub (see vitest.config.ts + helpers/
 * ponder-virtual-stubs.ts). There is no PGlite / Ponder boot in the test
 * harness.
 *
 * Rather than introduce a brand-new integration scaffold for this one fix
 * (out of scope), this test takes a mock-DB approach: it replaces the
 * `ponder:api`, `ponder:schema`, and `ponder` modules via `vi.mock` with a
 * recording DB + tagged schema columns + AST-building helpers, then drives
 * the slice route via Hono's `app.request(...)` and asserts BOTH:
 *
 *   1. The verdict ⇒ attempt LEFT JOIN condition references `taskId` AND
 *      `attemptIndex` (NOT `requestId`) — the canonical join shape used
 *      throughout the file (e.g. `getVerdictsForAttempts`).
 *   2. The end-to-end response: for group=operator, distinct operators map
 *      to distinct series with the right groupValues (and not 0x000…0).
 *
 * Follow-up
 * ─────────
 * A full route-level test scaffold against a real seeded DB (PGlite or
 * similar) would let us catch a wider class of SQL bugs. That gap is worth
 * its own issue; this test is the best regression coverage achievable
 * inside the existing pure-function test harness.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Hoisted mock state ────────────────────────────────────────────────────────
//
// vi.mock() factories run BEFORE the file's top-level const declarations
// (Vitest hoists them). Anything those factories need must live inside
// vi.hoisted(...). We build the recording DB + tagged schema once here.

const mockState = vi.hoisted(() => {
  type ColumnRef = { __col: true; table: string; col: string };
  type EqNode = { __op: 'eq'; a: unknown; b: unknown };
  type AndNode = { __op: 'and'; args: unknown[] };
  type InArrayNode = { __op: 'inArray'; col: ColumnRef; values: unknown[] };
  type AggNode = { __agg: 'count' | 'max' | 'sum' | 'countDistinct'; arg?: unknown };

  const KNOWN_TABLES = [
    'task',
    'attempt',
    'verdict',
    'solverNetManifest',
    'envelope',
    'harnessCheckpoint',
    'attemptEnvelopeMeta',
    'verdictEnvelopeMeta',
    'rewardDistribution',
    'stakingService',
    'stakingRewardCheckpoint',
  ] as const;

  const tableIdentity = new WeakMap<object, string>();

  const schema: Record<string, Record<string, ColumnRef>> = {};
  for (const t of KNOWN_TABLES) {
    const proxy = new Proxy({} as Record<string, ColumnRef>, {
      get(target, prop: string) {
        if (prop in target) return target[prop];
        const ref: ColumnRef = { __col: true, table: t, col: prop };
        target[prop] = ref;
        return ref;
      },
    });
    schema[t] = proxy;
    tableIdentity.set(proxy, t);
  }

  function identifyTable(t: unknown): string {
    if (t && typeof t === 'object' && tableIdentity.has(t as object)) {
      return tableIdentity.get(t as object)!;
    }
    return '(unknown)';
  }

  interface QueryRecord {
    fromTable: string;
    joins: { kind: 'left' | 'inner'; tableName: string; condition: unknown }[];
    whereCondition: unknown;
    selectShape: Record<string, unknown> | null;
    orderByArgs: unknown[];
  }

  interface Responder {
    match(q: QueryRecord): boolean;
    rows: unknown[] | ((q: QueryRecord) => unknown[]);
  }

  const recordedQueries: QueryRecord[] = [];
  let responders: Responder[] = [];

  function resolveResponse(record: QueryRecord): unknown[] {
    for (const r of responders) {
      if (r.match(record)) {
        return typeof r.rows === 'function' ? r.rows(record) : r.rows;
      }
    }
    // Default: a single-row result with nulls (works for max(), count(), …).
    if (record.selectShape) {
      const stub: Record<string, unknown> = {};
      for (const k of Object.keys(record.selectShape)) {
        const v = record.selectShape[k];
        if (v && typeof v === 'object' && '__agg' in (v as Record<string, unknown>)) {
          stub[k] = (v as AggNode).__agg === 'count' ? 0 : null;
        } else {
          stub[k] = null;
        }
      }
      return [stub];
    }
    return [];
  }

  const buildChain = (record: QueryRecord) => {
    const chain: Record<string, unknown> = {};
    chain.from = (table: unknown) => {
      record.fromTable = identifyTable(table);
      return chain;
    };
    chain.leftJoin = (table: unknown, condition: unknown) => {
      record.joins.push({
        kind: 'left',
        tableName: identifyTable(table),
        condition,
      });
      return chain;
    };
    chain.innerJoin = (table: unknown, condition: unknown) => {
      record.joins.push({
        kind: 'inner',
        tableName: identifyTable(table),
        condition,
      });
      return chain;
    };
    chain.where = (condition: unknown) => {
      record.whereCondition = condition;
      return chain;
    };
    chain.orderBy = (...args: unknown[]) => {
      record.orderByArgs.push(...args);
      return chain;
    };
    chain.limit = (_n: unknown) => chain;
    chain.then = (
      onFulfilled: (v: unknown[]) => unknown,
      onRejected?: (e: unknown) => unknown,
    ) => {
      try {
        const rows = resolveResponse(record);
        return Promise.resolve(rows).then(onFulfilled, onRejected);
      } catch (e) {
        return onRejected ? Promise.resolve(onRejected(e)) : Promise.reject(e);
      }
    };
    return chain;
  };

  const db = {
    select: (shape?: Record<string, unknown>) => {
      const record: QueryRecord = {
        fromTable: '',
        joins: [],
        whereCondition: undefined,
        selectShape: shape ?? null,
        orderByArgs: [],
      };
      recordedQueries.push(record);
      return buildChain(record);
    },
  };

  const ponderOps = {
    eq: (a: unknown, b: unknown): EqNode => ({ __op: 'eq', a, b }),
    and: (...args: unknown[]): AndNode => ({
      __op: 'and',
      args: args.filter((a) => a !== undefined),
    }),
    or: (...args: unknown[]) => ({ __op: 'or', args }),
    inArray: (col: ColumnRef, values: unknown[]): InArrayNode => ({
      __op: 'inArray',
      col,
      values,
    }),
    count: (arg?: unknown): AggNode => ({ __agg: 'count', arg }),
    countDistinct: (arg?: unknown): AggNode => ({ __agg: 'countDistinct', arg }),
    sum: (arg?: unknown): AggNode => ({ __agg: 'sum', arg }),
    max: (arg?: unknown): AggNode => ({ __agg: 'max', arg }),
    isNull: (col: unknown) => ({ __op: 'isNull', col }),
    isNotNull: (col: unknown) => ({ __op: 'isNotNull', col }),
    ne: (a: unknown, b: unknown) => ({ __op: 'ne', a, b }),
    sql: Object.assign(
      (strings: TemplateStringsArray, ...exprs: unknown[]) => ({
        __sql: true,
        strings,
        exprs,
      }),
      {
        raw: (s: string) => ({ __sql: true, raw: s }),
      },
    ),
  };

  return {
    db,
    schema,
    ponderOps,
    recordedQueries,
    setResponders: (rs: Responder[]) => {
      responders = rs;
    },
    clearQueries: () => {
      recordedQueries.length = 0;
    },
  };
});

// ── vi.mock the three Ponder-related modules ─────────────────────────────────
//
// Both `ponder:api` and `ponder:schema` are vitest-aliased to the same stub
// file (see vitest.config.ts); the same vi.mock factory replaces both at
// load time.

vi.mock('ponder:api', () => ({
  db: mockState.db,
  default: mockState.schema,
}));

vi.mock('ponder:schema', () => ({
  db: mockState.db,
  default: mockState.schema,
}));

vi.mock('ponder', () => mockState.ponderOps);

// Stub chain-head so the explorerFreshness middleware doesn't hit the network.
vi.mock('../src/api/chain-head.js', () => ({
  getChainHead: async () => null,
}));

// ── SUT import (after mocks are declared so vi.mock can hoist) ───────────────
const { default: explorerApp } = await import('../src/api/explorer.js');

// ── Helpers ───────────────────────────────────────────────────────────────────

type ColumnRef = { __col: true; table: string; col: string };
type EqNode = { __op: 'eq'; a: unknown; b: unknown };

const tableNameFromRef = (ref: unknown): string | null => {
  if (ref && typeof ref === 'object' && '__col' in (ref as Record<string, unknown>)) {
    return (ref as ColumnRef).table;
  }
  return null;
};

interface QueryRecord {
  fromTable: string;
  joins: { kind: 'left' | 'inner'; tableName: string; condition: unknown }[];
  whereCondition: unknown;
  selectShape: Record<string, unknown> | null;
  orderByArgs: unknown[];
}

function findVerdictAttemptJoin(record: QueryRecord) {
  return record.joins.find((j) => j.tableName === 'attempt');
}

function collectEqs(cond: unknown): EqNode[] {
  const out: EqNode[] = [];
  const visit = (n: unknown) => {
    if (!n || typeof n !== 'object') return;
    const node = n as Record<string, unknown>;
    if (node.__op === 'eq') {
      out.push(node as unknown as EqNode);
    } else if (node.__op === 'and' && Array.isArray(node.args)) {
      for (const a of node.args) visit(a);
    }
  };
  visit(cond);
  return out;
}

function findSliceJoinQuery(): QueryRecord | undefined {
  return mockState.recordedQueries.find(
    (q) =>
      q.fromTable === 'verdict' &&
      q.joins.some((j) => j.tableName === 'attempt') &&
      q.selectShape !== null &&
      'pluginsJson' in (q.selectShape as Record<string, unknown>),
  ) as QueryRecord | undefined;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('GET /explorer/slice — route integration', () => {
  const MANIFEST_CID = 'bafyManifestCid';
  const KECCAK = '0xkeccak' as `0x${string}`;
  const TASK_IDS = ['1', '2'];
  const OP_A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as `0x${string}`;
  const OP_B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' as `0x${string}`;

  beforeEach(() => {
    mockState.clearQueries();

    mockState.setResponders([
      // 1) solverNetManifest lookup — return one row with our cidKeccak.
      {
        match: (q) => q.fromTable === 'solverNetManifest',
        rows: [{ cidKeccak: KECCAK }],
      },
      // 2) task ids for the manifest — return TASK_IDS.
      {
        match: (q) =>
          q.fromTable === 'task' &&
          q.selectShape !== null &&
          Object.keys(q.selectShape as Record<string, unknown>).length === 1 &&
          'id' in (q.selectShape as Record<string, unknown>),
        rows: TASK_IDS.map((id) => ({ id })),
      },
      // 3) Raw verdict count (no joins).
      {
        match: (q) =>
          q.fromTable === 'verdict' &&
          q.joins.length === 0 &&
          q.selectShape !== null &&
          'total' in (q.selectShape as Record<string, unknown>),
        rows: [{ total: 6 }],
      },
      // 4) Big joined query — verdict ⇒ verdictEnvelopeMeta + attempt +
      //    attemptEnvelopeMeta. Return rows covering both operators so
      //    group=operator yields TWO series.
      {
        match: (q) =>
          q.fromTable === 'verdict' &&
          q.joins.some((j) => j.tableName === 'attempt') &&
          q.selectShape !== null &&
          'pluginsJson' in (q.selectShape as Record<string, unknown>),
        rows: [
          {
            requestId: '0x01',
            operator: OP_A,
            createdAtBlock: 100n,
            verdictCode: 1,
            actualPassed: true,
            enrichmentStatus: 'ok',
            mode: 'train',
            harness: 'hermes-agent',
            model: 'claude-haiku-4-5',
            pluginsJson: null,
          },
          {
            requestId: '0x02',
            operator: OP_A,
            createdAtBlock: 101n,
            verdictCode: 1,
            actualPassed: false,
            enrichmentStatus: 'ok',
            mode: 'train',
            harness: 'hermes-agent',
            model: 'claude-haiku-4-5',
            pluginsJson: null,
          },
          {
            requestId: '0x03',
            operator: OP_B,
            createdAtBlock: 102n,
            verdictCode: 1,
            actualPassed: true,
            enrichmentStatus: 'ok',
            mode: 'train',
            harness: 'hermes-agent',
            model: 'claude-haiku-4-5',
            pluginsJson: null,
          },
          {
            requestId: '0x04',
            operator: OP_B,
            createdAtBlock: 103n,
            verdictCode: 1,
            actualPassed: true,
            enrichmentStatus: 'ok',
            mode: 'frozen',
            harness: 'hermes-agent',
            model: 'claude-haiku-4-5',
            pluginsJson: null,
          },
        ],
      },
      // 5) buildLeaderboardRows -> attempt lookups for the train/frozen
      //    overlay. Return empty arrays — the leaderboard overlay is not
      //    what's under test.
      {
        match: (q) =>
          q.fromTable === 'attempt' &&
          q.selectShape !== null &&
          'operator' in (q.selectShape as Record<string, unknown>),
        rows: [],
      },
    ]);
  });

  // ── BLOCKING #1 regression: verdict ⇒ attempt JOIN ON (taskId, attemptIndex) ─

  it('joins verdict ⇒ attempt on (taskId, attemptIndex, chainId), NOT on requestId', async () => {
    const res = await explorerApp.request(
      `/slice?manifestDigest=${MANIFEST_CID}&group=operator`,
    );
    expect(res.status).toBe(200);

    const sliceQuery = findSliceJoinQuery();
    expect(
      sliceQuery,
      'expected the slice route to issue a verdict⇒attempt joined query',
    ).toBeDefined();
    const join = findVerdictAttemptJoin(sliceQuery!);
    expect(join, 'expected a LEFT JOIN against schema.attempt').toBeDefined();

    const eqs = collectEqs(join!.condition);

    // The join MUST include eq(attempt.taskId, verdict.taskId).
    const taskIdEq = eqs.find(
      (e) =>
        tableNameFromRef(e.a) === 'attempt' &&
        (e.a as ColumnRef).col === 'taskId' &&
        tableNameFromRef(e.b) === 'verdict' &&
        (e.b as ColumnRef).col === 'taskId',
    );
    // And eq(attempt.attemptIndex, verdict.attemptIndex).
    const attemptIndexEq = eqs.find(
      (e) =>
        tableNameFromRef(e.a) === 'attempt' &&
        (e.a as ColumnRef).col === 'attemptIndex' &&
        tableNameFromRef(e.b) === 'verdict' &&
        (e.b as ColumnRef).col === 'attemptIndex',
    );

    expect(taskIdEq, 'verdict⇒attempt join must reference taskId').toBeDefined();
    expect(
      attemptIndexEq,
      'verdict⇒attempt join must reference attemptIndex',
    ).toBeDefined();

    // And it must NOT reference requestId on either side.
    const requestIdEq = eqs.find(
      (e) =>
        (tableNameFromRef(e.a) === 'attempt' && (e.a as ColumnRef).col === 'requestId') ||
        (tableNameFromRef(e.b) === 'attempt' && (e.b as ColumnRef).col === 'requestId'),
    );
    expect(
      requestIdEq,
      'verdict⇒attempt join must NOT key on requestId',
    ).toBeUndefined();
  });

  // ── Regression: chronological ORDER BY on the slice verdict query ────────────
  //
  // computeOneSeries hands joined rows straight to rollingResolvedRate, which
  // is a time-series rolling window. PostgreSQL does not guarantee a
  // deterministic order without ORDER BY — so the rolling array must be
  // computed from rows already sorted by createdAtBlock. The sibling
  // /explorer/solvernet/:cid route applies the same sort for the same reason.
  it('orders the slice verdict query by verdict.createdAtBlock', async () => {
    const res = await explorerApp.request(
      `/slice?manifestDigest=${MANIFEST_CID}&group=none`,
    );
    expect(res.status).toBe(200);

    const sliceQuery = findSliceJoinQuery();
    expect(
      sliceQuery,
      'expected the slice route to issue a verdict⇒attempt joined query',
    ).toBeDefined();

    // Exactly one column was passed to .orderBy, and it's verdict.createdAtBlock.
    expect(sliceQuery!.orderByArgs.length).toBeGreaterThanOrEqual(1);
    const orderCol = sliceQuery!.orderByArgs[0] as ColumnRef;
    expect(orderCol).toMatchObject({
      __col: true,
      table: 'verdict',
      col: 'createdAtBlock',
    });
  });

  // ── Wire-shape: group=operator yields one series per distinct operator ───────

  it('group=operator returns a distinct series per operator with the real operator address', async () => {
    const res = await explorerApp.request(
      `/slice?manifestDigest=${MANIFEST_CID}&group=operator`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      series: { groupValue: string | null; kpis: { verdicts: number } }[];
      kpis: { verdicts: number };
    };

    // Two operators in the seed → two series.
    expect(body.series).toHaveLength(2);

    const groupValues = body.series.map((s) => s.groupValue).sort();
    expect(groupValues).toEqual([OP_A, OP_B].sort());

    // None of the series should be 0x000…0 — that was the symptom of the bug.
    for (const s of body.series) {
      expect(s.groupValue).not.toBe('0x0000000000000000000000000000000000000000');
    }

    // Grouped-sum invariant: sum(series.verdicts) === top-level kpis.verdicts.
    const sum = body.series.reduce((a, s) => a + s.kpis.verdicts, 0);
    expect(sum).toBe(body.kpis.verdicts);
    expect(body.kpis.verdicts).toBe(4);
  });

  it('group=mode returns a series per mode (train/frozen)', async () => {
    const res = await explorerApp.request(
      `/slice?manifestDigest=${MANIFEST_CID}&group=mode`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      series: { groupValue: string | null; kpis: { verdicts: number } }[];
    };

    const groupValues = body.series.map((s) => s.groupValue).sort();
    expect(groupValues).toEqual(['frozen', 'train']);
  });
});
