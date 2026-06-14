import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { verdictEnvelopeMeta } from '../ponder.schema.js';

const ponderSchemaSource = readFileSync(
  fileURLToPath(new URL('../ponder.schema.ts', import.meta.url)),
  'utf8',
);

function verdictEnvelopeMetaBlock(): string {
  const start = ponderSchemaSource.indexOf('export const verdictEnvelopeMeta');
  expect(start).toBeGreaterThanOrEqual(0);
  // The block ends at the `relations` section that follows the table defs.
  const end = ponderSchemaSource.indexOf('// ── Relations', start);
  expect(end).toBeGreaterThan(start);
  return ponderSchemaSource.slice(start, end);
}

describe('verdictEnvelopeMeta schema (#779 retry columns)', () => {
  it('is exported from ponder.schema.ts', () => {
    expect(verdictEnvelopeMeta).toBeDefined();
  });

  it('declares a retryCount integer column defaulting to 0', () => {
    expect(verdictEnvelopeMetaBlock()).toContain(
      'retryCount: t.integer().notNull().default(0)',
    );
  });

  it('declares a nullable nextAttemptAt bigint column (epoch-ms, NULL = eligible now)', () => {
    expect(verdictEnvelopeMetaBlock()).toContain('nextAttemptAt: t.bigint()');
  });

  it('documents the retry transient status in the enrichmentStatus comment', () => {
    const block = verdictEnvelopeMetaBlock();
    // The enrichmentStatus enum must now include the transient `retry` state
    // the worker uses for the partially-enriched backoff path.
    expect(block).toContain("'pending' | 'retry' | 'ok' | 'failed'");
  });

  it('declares an index supporting the worker discovery status/due scan', () => {
    expect(verdictEnvelopeMetaBlock()).toContain(
      'dueIdx: index().on(table.enrichmentStatus, table.nextAttemptAt)',
    );
  });
});
