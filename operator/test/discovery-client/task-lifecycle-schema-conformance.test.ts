/**
 * #2044 AC4: the lifecycle read introduces NO benchmark-specific indexer table
 * and no bespoke lifecycle type. Every GraphQL root field it queries, and every
 * column it selects, filters on, or orders by, must already exist in
 * `packages/indexer/ponder.schema.ts`.
 *
 * This is also the field-name gate: the reader's five query documents are
 * checked against the schema the Ponder GraphQL mount
 * (`app.use('/graphql', graphql({ db, schema }))`) is generated from, so a
 * typo'd or renamed column fails here instead of at runtime against a live
 * indexer. `where:` and `orderBy` are covered alongside the selection set —
 * a bad name in either is equally fatal at runtime.
 *
 * WHAT THIS DOES NOT COVER, stated so nobody reads it as a full contract test:
 *
 * 1. Column NAMES only, never TYPES. A column renamed from `t.integer()` to
 *    `t.bigint()` passes here and breaks at runtime; the reader's own parse
 *    guards (`parseExactBlock`, `isCount`, `isBytes32`) are what catch that.
 * 2. `ROOT_FIELD_TO_TABLE` is hand-maintained. Ponder's pluralization is not
 *    derived here, so a table whose root field pluralizes unexpectedly is only
 *    caught by the "unmapped root field" assertion below — which fails loudly,
 *    but needs a human to supply the right mapping.
 * 3. The PAGINATION ARGUMENT SURFACE — `limit` / `after` / `orderDirection` and
 *    the `items` + `pageInfo { hasNextPage endCursor }` connection shape — is
 *    not checked against anything, because it is Ponder's GraphQL API rather
 *    than the project's schema file. It is independently corroborated by a
 *    working client against a live Ponder mount:
 *    `legacy/jinn-cli-agents-reference/frontend/explorer/src/lib/subgraph.ts`
 *    (~L190-240) queries with exactly `limit` / `after` / `before` / `orderBy` /
 *    `orderDirection` and reads back `items` + `pageInfo { hasNextPage,
 *    endCursor }`.
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
 * Text between the brace at `open` and its match. Depth-counted, not
 * regex-matched: a `/\{([\s\S]*?)\n\s*\}/` stops at the first line-leading `}`,
 * which truncates the moment a selection set nests and leaves the
 * unknown-column assertion below passing over a fragment.
 */
function braceBlock(document: string, open: number): string {
  expect(document[open], 'expected a brace at the given offset').toBe('{');
  let depth = 0;
  for (let i = open; i < document.length; i += 1) {
    if (document[i] === '{') depth += 1;
    else if (document[i] === '}') {
      depth -= 1;
      if (depth === 0) return document.slice(open + 1, i);
    }
  }
  throw new Error('unbalanced braces in query document');
}

/** Ponder filter suffixes: `taskId_in` filters the `taskId` column. */
const FILTER_SUFFIXES = [
  '_not_in', '_in', '_not_contains', '_contains', '_not_starts_with', '_starts_with',
  '_not_ends_with', '_ends_with', '_gte', '_lte', '_gt', '_lt', '_not',
];

/** The column a `where:` argument name filters on. */
function filterColumn(name: string): string {
  const suffix = FILTER_SUFFIXES.find((s) => name.endsWith(s));
  return suffix ? name.slice(0, -suffix.length) : name;
}

interface ParsedQuery {
  rootField: string;
  /** The inner `items { ... }` selection set only — never pageInfo or args. */
  selected: string[];
  /** Columns the `where:` argument filters on, suffixes stripped. */
  filters: string[];
  orderBy: string | undefined;
  /** True when the items selection set is not flat. */
  nested: boolean;
}

function parseQueryDocument(document: string): ParsedQuery {
  const rootField = /\n\s{2}(\w+)\(/u.exec(document)![1]!;
  const items = braceBlock(document, document.indexOf('{', document.indexOf('items')));
  const whereAt = document.indexOf('where:');
  const where = whereAt === -1 ? '' : braceBlock(document, document.indexOf('{', whereAt));
  return {
    rootField,
    selected: items.split('\n').map((line) => line.trim()).filter(Boolean),
    filters: [...where.matchAll(/(\w+)\s*:/gu)].map((m) => filterColumn(m[1]!)),
    orderBy: /orderBy:\s*"(\w+)"/u.exec(document)?.[1],
    nested: items.includes('{'),
  };
}

/** Every `LIFECYCLE_*_QUERY` in the reader, parsed. */
function lifecycleQueries(): ParsedQuery[] {
  const documents = [...readerSource.matchAll(
    /const LIFECYCLE_\w+_QUERY = `([\s\S]*?)`;/gu,
  )].map((m) => m[1]!);
  expect(documents).toHaveLength(5);
  return documents.map(parseQueryDocument);
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

  it('every selection set is flat, so the parse can never truncate', () => {
    // The column assertion above reads the items block as one field per line.
    // A nested selection would break that reading, so it fails loudly here
    // rather than passing vacuously there.
    for (const { rootField, nested } of lifecycleQueries()) {
      expect(nested, `${rootField} selects a nested field — extend the parser`).toBe(false);
    }
  });

  it('every where filter and orderBy names a declared column', () => {
    for (const { rootField, filters, orderBy } of lifecycleQueries()) {
      const columns = columnsOf(ROOT_FIELD_TO_TABLE[rootField]!);
      expect(filters.length, `${rootField} has no where filter`).toBeGreaterThan(0);
      const unknownFilters = filters.filter((field) => !columns.has(field));
      expect(unknownFilters, `${rootField} filters on non-columns`).toEqual([]);
      expect(orderBy, `${rootField} has no orderBy`).toBeDefined();
      expect(columns.has(orderBy!), `${rootField} orders by non-column ${orderBy}`).toBe(true);
    }
  });

  it('the parser is non-vacuous', () => {
    // Guard the guard: the column extractor must find real columns, and must
    // reject a name that is not declared.
    const taskColumns = columnsOf('task');
    expect(taskColumns.has('createdAtTx')).toBe(true);
    expect(taskColumns.has('taskCidDigest')).toBe(true);
    expect(taskColumns.has('benchmarkScore')).toBe(false);
    const tasksQuery = lifecycleQueries().find((q) => q.rootField === 'tasks')!;
    expect(tasksQuery.selected).toContain('manifestDigest');
    expect(tasksQuery.filters).toEqual(['id']);
    expect(tasksQuery.orderBy).toBe('id');
    expect(filterColumn('taskId_in')).toBe('taskId');
    expect(filterColumn('chainId')).toBe('chainId');
  });

  it('reads a nested selection set whole instead of truncating at the first brace', () => {
    // The failure this guard is here to prevent: a `\\n\\s*\\}`-terminated regex
    // stops at the inner block's closing brace and never sees `tail`, so an
    // unknown column after a nested field passes unchecked.
    const nestedDocument = `
query Synthetic($ids: [String!]!) {
  things(
    where: { taskId_in: $ids, chainId: $chainId },
    orderBy: "attemptIndex"
  ) {
    items {
      id
      inner {
        deep
      }
      tail
    }
    pageInfo {
      hasNextPage
    }
  }
}
`;
    const parsed = parseQueryDocument(nestedDocument);
    expect(parsed.rootField).toBe('things');
    expect(parsed.nested).toBe(true);
    expect(parsed.selected).toContain('tail');
    expect(parsed.filters).toEqual(['taskId', 'chainId']);
    expect(parsed.orderBy).toBe('attemptIndex');
  });

  it('introduces no lifecycle table or column under packages/indexer', () => {
    // AC4, stated as a boundary: the reader owns query text only. It must not
    // reach into the indexer package at all.
    expect(readerSource).not.toContain('packages/indexer');
    expect(readerSource).not.toContain('onchainTable');
  });
});
