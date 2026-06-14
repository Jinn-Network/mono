/**
 * PGlite test harness for the enrichment worker's DB contract surface
 * (handbook rule 6 — a real Postgres engine for the migration/contract surface,
 * not a hand-rolled mock).
 *
 * Creates an in-memory PGlite instance, a schema, and the two tables the worker
 * touches (`envelope` read-only + `verdict_envelope_meta` read/write). The DDL
 * is GENERATED from the real Drizzle schema via getTableConfig so it cannot
 * drift from ponder.schema.ts — if the indexer adds/renames a column the worker
 * relies on, these tables change with it.
 */
import { PGlite } from '@electric-sql/pglite';
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite';
import { sql } from 'drizzle-orm';
import { getTableConfig, type PgTable } from 'drizzle-orm/pg-core';
import { envelope, verdictEnvelopeMeta } from '@jinn-network/indexer/schema';

export interface PgliteHarness {
  db: PgliteDatabase;
  client: PGlite;
  schema: string;
  close: () => Promise<void>;
}

/** Map a Drizzle column's SQL type name to a Postgres column type for the DDL. */
function columnSqlType(col: ReturnType<typeof getTableConfig>['columns'][number]): string {
  const t = col.getSQLType();
  return t;
}

function createTableDDL(schema: string, table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const parts = [`"${c.name}"`, columnSqlType(c)];
    if (c.notNull) parts.push('NOT NULL');
    if (c.hasDefault && c.default !== undefined) {
      const d = c.default;
      const lit =
        typeof d === 'string' ? `'${d.replace(/'/g, "''")}'` : typeof d === 'boolean' ? String(d) : String(d);
      parts.push(`DEFAULT ${lit}`);
    }
    return parts.join(' ');
  });
  const pkCols = cfg.primaryKeys.flatMap((pk) => pk.columns.map((c) => `"${c.name}"`));
  if (pkCols.length > 0) {
    cols.push(`PRIMARY KEY (${pkCols.join(', ')})`);
  }
  return `CREATE TABLE "${schema}"."${cfg.name}" (\n  ${cols.join(',\n  ')}\n)`;
}

let counter = 0;

export async function createPgliteHarness(): Promise<PgliteHarness> {
  const client = new PGlite();
  const db = drizzle(client);
  const schema = `jinn_test_${process.pid}_${counter++}`;
  await db.execute(sql.raw(`CREATE SCHEMA "${schema}"`));
  await db.execute(sql.raw(createTableDDL(schema, envelope)));
  await db.execute(sql.raw(createTableDDL(schema, verdictEnvelopeMeta)));
  return {
    db,
    client,
    schema,
    close: async () => {
      await client.close();
    },
  };
}

/** Column names of a Drizzle table, in declaration order — for parity assertions. */
export function tableColumnNames(table: PgTable): string[] {
  return getTableConfig(table).columns.map((c) => c.name);
}
