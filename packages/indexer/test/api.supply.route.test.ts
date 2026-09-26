/**
 * Route-level integration test for GET /supply's status-code split (#4238
 * follow-up).
 *
 * Why this exists
 * ───────────────
 * `src/api/index.ts`'s `/supply` handler wraps two different failure modes in
 * two different `catch` blocks: a query/transport failure (db reads throw)
 * and a pure-assembler failure (`assembleCurrentSupply` throws on already-
 * fetched rows). `test/supply.test.ts` only exercises `assembleCurrentSupply`
 * and `buildCurrentSupply` directly — those are pure functions and never see
 * the route's own status-code mapping, so a regression that collapses the two
 * catch blocks back onto the same status is invisible there. This file mocks
 * just enough of Ponder's virtual modules to drive the real route through
 * Hono's `app.request(...)` and read the actual HTTP status, the same
 * approach `api.slice.route.test.ts` uses for the sibling `/explorer/slice`
 * route for the identical reason (a route-handler bug pure-function tests
 * cannot see).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Hono } from 'hono';
import { completedSupplyWindow } from '../src/api/supply.js';
import { BASE_SEPOLIA_CHAIN_ID } from '../src/chain-config.js';

// ── Hoisted mock state ────────────────────────────────────────────────────────
// vi.mock factories run before this file's top-level consts (Vitest hoists
// them), so any state they close over must live inside vi.hoisted(...).
const mockState = vi.hoisted(() => {
  let queue: unknown[][] = [];
  let callIndex = 0;
  let failQuery = false;

  // A single stateless chain: `.from/.where/.limit` return itself, and
  // `.then` resolves to the next queued row set (in db.select() call order).
  // `Promise.all` and `await` both resolve a thenable via a microtask that
  // calls `.then()` once per array element, in the order the elements were
  // constructed — so a positional queue lines up with the route's real query
  // order (manifests, in-window attempts, in-window verdicts, then
  // conditionally prior-attempts and tasks).
  const chain: PromiseLike<unknown[]> & Record<string, unknown> = {
    from: () => {
      if (failQuery) throw new Error('indexer database unavailable');
      return chain;
    },
    where: () => chain,
    limit: () => chain,
    then: <TResult1 = unknown[], TResult2 = never>(
      onFulfilled?: ((v: unknown[]) => TResult1 | PromiseLike<TResult1>) | null,
      onRejected?: ((e: unknown) => TResult2 | PromiseLike<TResult2>) | null,
    ) => {
      const rows = queue[callIndex] ?? [];
      callIndex += 1;
      return Promise.resolve(rows).then(onFulfilled, onRejected);
    },
  };

  return {
    db: { select: () => chain },
    schema: new Proxy({}, { get: () => ({}) }),
    setQueue: (rows: unknown[][]) => {
      queue = rows;
      callIndex = 0;
    },
    setFailQuery: (fail: boolean) => {
      failQuery = fail;
    },
  };
});

// Both `ponder:api` and `ponder:schema` are vitest-aliased to the same stub
// file (see vitest.config.ts), so both specifiers resolve to the same
// underlying module id — each vi.mock factory must supply the full export
// set (db + default schema + named tables) or the other's mock is treated as
// incomplete. Mirrors the pattern in api.slice.route.test.ts. vi.mock
// factories are hoisted above local consts, so the object literal is
// duplicated rather than shared via a helper.
vi.mock('ponder:api', () => ({
  db: mockState.db,
  default: mockState.schema,
  attempt: {},
  pluginPublication: {},
  solverNetManifest: {},
  task: {},
  verdict: {},
}));
vi.mock('ponder:schema', () => ({
  db: mockState.db,
  default: mockState.schema,
  attempt: {},
  pluginPublication: {},
  solverNetManifest: {},
  task: {},
  verdict: {},
}));
// graphql() refuses to initialise outside a Ponder project; the /graphql
// mount is not under test here. eq/and/inArray/sql are replaced too because
// the fake column objects above are plain proxies, not real drizzle Column
// instances — the mock `db` never inspects what these build, it only cares
// how many times `.select()` is chained and awaited.
vi.mock('ponder', () => ({
  graphql: () => async (_c: unknown, next: () => Promise<void>) => next(),
  and: (...args: unknown[]) => args,
  eq: (...args: unknown[]) => args,
  inArray: (...args: unknown[]) => args,
  sql: (strings: TemplateStringsArray, ...exprs: unknown[]) => ({ strings, exprs }),
}));

const { default: app } = await import('../src/api/index.js') as { default: Hono };

const CID_KECCAK = `0x${'11'.repeat(32)}`;
const manifestRow = {
  id: 'bafy-prediction',
  cidKeccak: CID_KECCAK,
  status: 'launched',
  chainId: BASE_SEPOLIA_CHAIN_ID,
  openRoles: ['solver'],
  contractId: 'prediction',
  contractVersion: 'v1',
  manifestEnrichmentStatus: 'ok',
};
const taskRow = { id: '7', manifestDigest: CID_KECCAK, chainId: BASE_SEPOLIA_CHAIN_ID };

describe('GET /supply route status codes (#4238)', () => {
  beforeEach(() => {
    mockState.setFailQuery(false);
    mockState.setQueue([]);
  });

  it('answers 503 when the evidence queries fail', async () => {
    mockState.setFailQuery(true);
    const res = await app.request(`/supply?chainId=${BASE_SEPOLIA_CHAIN_ID}`);
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toBe('supply unavailable');
  });

  it('answers 200 with a short cache header on a clean assembly', async () => {
    // manifests, in-window attempts, in-window verdicts — all empty, so
    // neither prior-attempts nor tasks gets queried.
    mockState.setQueue([[], [], []]);
    const res = await app.request(`/supply?chainId=${BASE_SEPOLIA_CHAIN_ID}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('public, max-age=30, must-revalidate');
    const body = await res.json();
    expect(body.status).toBe('zero_supply');
  });

  it('answers 500, not 503, when the pure assembler throws on already-fetched rows', async () => {
    // A row shaped so the DB read itself succeeds, but the assembler's own
    // aggregation throws once it reaches this row — here, a non-string
    // `operator` blows up `row.operator.toLowerCase()`. This is exactly the
    // "deterministic bug in buildCurrentSupply" #4238 describes: it must
    // render as a 500 defect, not a 503 transient outage, because
    // `fetchWithRetry` (operator/src/discovery-client/http.ts) transparently
    // retries 502/503 — retrying a deterministic bug never succeeds.
    const window = completedSupplyWindow(Date.now());
    const inWindowTimestamp = BigInt(Date.parse(window.end) / 1_000) - 60n;
    const malformedAttempt = {
      taskId: '7',
      attemptIndex: 0,
      operator: 12345, // not a string — the assembler calls .toLowerCase() on it
      chainId: BASE_SEPOLIA_CHAIN_ID,
      createdAtTimestamp: inWindowTimestamp,
    };
    // Query order: manifests, in-window attempts, in-window verdicts (Promise.all),
    // then tasks (attempts is non-empty so taskIds is non-empty; verdicts is
    // empty so prior-attempts is never queried).
    mockState.setQueue([[manifestRow], [malformedAttempt], [], [taskRow]]);

    const res = await app.request(`/supply?chainId=${BASE_SEPOLIA_CHAIN_ID}`);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toMatchObject({ error: 'supply unavailable', detail: 'assembler failed' });
  });
});
