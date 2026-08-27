/**
 * #2044 AC4: the lifecycle read introduces NO benchmark-specific indexer table
 * and no bespoke lifecycle type. Every GraphQL root field it queries, and every
 * column it selects, must already exist in `packages/indexer/ponder.schema.ts`.
 *
 * This is also the field-name gate: the reader's five query documents are
 * checked against the schema the Ponder GraphQL mount
 * (`app.use('/graphql', graphql({ db, schema }))`) is generated from, so a
 * typo'd or renamed column fails here instead of at runtime against a live
 * indexer.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const readerSource = readFileSync(
  fileURLToPath(new URL('../../src/discovery-client/task-lifecycle-http.ts', import.meta.url)),
  'utf-8',
);
const schemaSource = readFileSync(
  fileURLToPath(new URL('../../../packages/indexer/ponder.schema.ts', import.meta.url)),
  'utf-8',
);

/** Ponder pluralizes the exported table variable into the GraphQL root field. */
const ROOT_FIELD_TO_TABLE: Record<string, string> = {
  tasks: 'task',
  attempts: 'attempt',
  verdicts: 'verdict',
  attemptEnvelopeMetas: 'attemptEnvelopeMeta',
  verdictEnvelopeMetas: 'verdictEnvelopeMeta',
};

/** Column names declared on `export const <name> = onchainTable(...)`. */
function columnsOf(table: string): Set<string> {
  const start = schemaSource.indexOf(`export const ${table} = onchainTable(`);
  expect(start, `table ${table} not declared in ponder.schema.ts`).toBeGreaterThan(-1);
  const next = schemaSource.indexOf('\nexport const ', start + 1);
  const block = schemaSource.slice(start, next === -1 ? schemaSource.length : next);
  return new Set([...block.matchAll(/^\s*(\w+):\s*t\.\w+\(/gmu)].map((m) => m[1]!));
}

/**
 * Every `LIFECYCLE_*_QUERY` in the reader, as
 * `{ rootField, selected: string[] }`. `selected` is the inner `items { ... }`
 * selection set only — never the pageInfo or argument names.
 */
function lifecycleQueries(): Array<{ rootField: string; selected: string[] }> {
  const documents = [...readerSource.matchAll(
    /const LIFECYCLE_\w+_QUERY = `([\s\S]*?)`;/gu,
  )].map((m) => m[1]!);
  expect(documents).toHaveLength(5);
  return documents.map((document) => {
    const rootField = /\n\s{2}(\w+)\(/u.exec(document)![1]!;
    const items = /items\s*\{([\s\S]*?)\n\s*\}/u.exec(document)![1]!;
    return {
      rootField,
      selected: items.split('\n').map((line) => line.trim()).filter(Boolean),
    };
  });
}

describe('lifecycle read stays on the existing indexer schema (#2044 AC4)', () => {
  it('every GraphQL root field maps to a table already declared in ponder.schema.ts (AC4)', () => {
    const roots = lifecycleQueries().map((q) => q.rootField).sort();
    expect(roots).toEqual([
      'attemptEnvelopeMetas', 'attempts', 'tasks', 'verdictEnvelopeMetas', 'verdicts',
    ]);
    for (const root of roots) {
      const table = ROOT_FIELD_TO_TABLE[root];
      expect(table, `unmapped root field ${root} — a new indexer table?`).toBeDefined();
      expect(schemaSource).toContain(`export const ${table} = onchainTable(`);
    }
  });

  it('every selected field is a declared column on that table', () => {
    for (const { rootField, selected } of lifecycleQueries()) {
      const columns = columnsOf(ROOT_FIELD_TO_TABLE[rootField]!);
      // `task.id` is `t.text().primaryKey()`; the regex above already catches it.
      const unknown = selected.filter((field) => !columns.has(field));
      expect(unknown, `${rootField} selects non-columns`).toEqual([]);
    }
  });

  it('the parser is non-vacuous', () => {
    // Guard the guard: the column extractor must find real columns, and must
    // reject a name that is not declared.
    const taskColumns = columnsOf('task');
    expect(taskColumns.has('createdAtTx')).toBe(true);
    expect(taskColumns.has('taskCidDigest')).toBe(true);
    expect(taskColumns.has('benchmarkScore')).toBe(false);
    expect(lifecycleQueries().find((q) => q.rootField === 'tasks')!.selected)
      .toContain('manifestDigest');
  });

  it('introduces no lifecycle table or column under packages/indexer', () => {
    // AC4, stated as a boundary: the reader owns query text only. It must not
    // reach into the indexer package at all.
    expect(readerSource).not.toContain('packages/indexer');
    expect(readerSource).not.toContain('onchainTable');
  });
});
