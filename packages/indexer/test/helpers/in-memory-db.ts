/**
 * An in-memory stand-in for Ponder's `context.db`, just rich enough to exercise
 * the pure handler functions in `src/handlers.ts`.
 *
 * Ponder 0.16.x has no first-class unit-test util for indexing functions, and
 * `ponder:registry` / `ponder:schema` are virtual modules the Ponder build
 * resolves — not importable from Vitest. So instead of booting the Ponder
 * runtime + a PGlite database, the handlers are extracted into exported pure
 * functions (see `src/handlers.ts`) and tested against this stub, which mirrors
 * the `find / insert / update / onConflictDoNothing / onConflictDoUpdate`
 * surface those handlers use.
 *
 * The stub keys rows by an opaque table identity (the `===`-identical table
 * object passed in) plus a primary key tuple. Primary keys are declared
 * explicitly per table (matching ponder.schema.ts) so the stub does not have to
 * introspect Drizzle's table metadata.
 *
 * Conflict semantics, matching Drizzle/Ponder:
 *   - `.values(v)` then `.onConflictDoNothing()` — insert iff no PK collision.
 *   - `.values(v)` then `.onConflictDoUpdate(fnOrObj)` — insert iff no collision;
 *     on collision, the resulting row is the *merge* of the existing row with the
 *     object returned by `fnOrObj` (a function is called with the existing row).
 *     This mirrors Drizzle's `ON CONFLICT DO UPDATE SET <returned cols>`.
 *   - awaiting `.values(v)` directly (no conflict handler) throws on collision.
 *   - `.update(table, key).set(fnOrObj)` throws if the row is missing; otherwise
 *     merges the update into the existing row (a function is called with it).
 */
import type { HandlerDb } from '../../src/handlers.js';

type Row = Record<string, unknown>;

/** Map of table-object → primary-key column names, in column order. */
export type PkMap = Map<unknown, string[]>;

export interface InMemoryDb extends HandlerDb {
  /** Return all rows for a table (insertion order). For test assertions. */
  rows(table: unknown): Row[];
  /** Return the single row for a table matching `key`, or undefined. */
  get(table: unknown, key: Row): Row | undefined;
  /** Count of rows for a table. */
  count(table: unknown): number;
}

function pkOf(pks: PkMap, table: unknown): string[] {
  const cols = pks.get(table);
  if (!cols) throw new Error('in-memory-db: table not registered with a primary key');
  return cols;
}

function pkKey(cols: string[], row: Row): string {
  return cols
    .map((c) => {
      const v = row[c];
      // JSON.stringify does not handle BigInt; serialize explicitly.
      if (typeof v === 'bigint') return `bigint:${v}`;
      return JSON.stringify(v);
    })
    .join('|');
}

export function createInMemoryDb(pks: PkMap): InMemoryDb {
  // table-object → (pkKey → Row). Insertion order preserved by Map.
  const store = new Map<unknown, Map<string, Row>>();

  const tableMap = (table: unknown): Map<string, Row> => {
    let m = store.get(table);
    if (!m) {
      m = new Map();
      store.set(table, m);
    }
    return m;
  };

  const applyUpdate = (existing: Row, update: Row | ((row: Row) => Row)): Row => {
    const patch = typeof update === 'function' ? update({ ...existing }) : update;
    return { ...existing, ...patch };
  };

  const db: InMemoryDb = {
    async find(table, key) {
      const cols = pkOf(pks, table);
      const m = tableMap(table);
      const row = m.get(pkKey(cols, key as Row));
      return row ? { ...row } : null;
    },

    insert(table) {
      const cols = pkOf(pks, table);
      const m = tableMap(table);
      return {
        values(values) {
          const v = values as Row;
          const k = pkKey(cols, v);
          const doInsert = (): Row => {
            const stored = { ...v };
            m.set(k, stored);
            return { ...stored };
          };
          // A lazy thenable, NOT an eager promise: `.then` is only invoked when
          // something `await`s the `.values(...)` result directly (the handlers
          // never do — they always chain `.onConflictDoNothing()` /
          // `.onConflictDoUpdate()`, whose returned promises ARE awaited). An
          // eager `Promise.resolve().then(...)` here would reject on conflict
          // with no catcher, producing spurious unhandled-rejection noise.
          const result: any = {
            then(
              onFulfilled?: (value: Row) => unknown,
              onRejected?: (reason: unknown) => unknown,
            ) {
              try {
                if (m.has(k)) {
                  throw new Error('in-memory-db: unique constraint violation (no conflict handler)');
                }
                return Promise.resolve(doInsert()).then(onFulfilled, onRejected);
              } catch (err) {
                return onRejected ? Promise.resolve(onRejected(err)) : Promise.reject(err);
              }
            },
            async onConflictDoNothing() {
              if (m.has(k)) return { ...(m.get(k) as Row) };
              return doInsert();
            },
            async onConflictDoUpdate(update: Row | ((row: Row) => Row)) {
              const existing = m.get(k);
              if (!existing) return doInsert();
              const merged = applyUpdate(existing, update);
              m.set(k, merged);
              return { ...merged };
            },
          };
          return result;
        },
      };
    },

    update(table, key) {
      const cols = pkOf(pks, table);
      const m = tableMap(table);
      return {
        async set(values) {
          const k = pkKey(cols, key as Row);
          const existing = m.get(k);
          if (!existing) {
            throw new Error('in-memory-db: cannot update a row that does not exist');
          }
          const merged = applyUpdate(existing, values as Row | ((row: Row) => Row));
          m.set(k, merged);
          return { ...merged };
        },
      };
    },

    rows(table) {
      return [...tableMap(table).values()].map((r) => ({ ...r }));
    },

    get(table, key) {
      const cols = pkOf(pks, table);
      const row = tableMap(table).get(pkKey(cols, key));
      return row ? { ...row } : undefined;
    },

    count(table) {
      return tableMap(table).size;
    },

    async countVerdicts(table, scope) {
      const { taskId, attemptIndex, chainId } = scope;
      return [...tableMap(table).values()].filter(
        (r) =>
          r['taskId'] === taskId &&
          r['attemptIndex'] === attemptIndex &&
          r['chainId'] === chainId,
      ).length;
    },
  };

  return db;
}
