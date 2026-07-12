/**
 * Regression test for automated DATABASE_SCHEMA derivation (issue #1429).
 *
 * A `ponder.schema.ts` change to an `onchainTable` used to require a manual
 * Railway `DATABASE_SCHEMA` bump (`jinn_indexer_vN`); merging a schema PR
 * without the bump crash-loops the new container
 * (`MigrationError: Schema "..." was previously used by a different Ponder app`)
 * while the stale one keeps serving — a silent failure.
 *
 * The fix derives `DATABASE_SCHEMA` at container boot from a content hash of
 * `ponder.schema.ts`, so an identical schema resumes in place (stable name)
 * and any change lands in a fresh namespace automatically. This pins the pure
 * derivation used by both the indexer and enrichment entrypoints.
 */

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { resolveDatabaseSchema } from '../deploy/derive-schema.mjs';

const SAMPLE = 'export const task = onchainTable("task", (t) => ({ id: t.text() }));\n';

describe('resolveDatabaseSchema (issue #1429)', () => {
  it('(a) is stable: identical schemaSource → identical name across calls', () => {
    const a = resolveDatabaseSchema({ schemaSource: SAMPLE, env: {} });
    const b = resolveDatabaseSchema({ schemaSource: SAMPLE, env: {} });
    expect(a).toBe(b);
  });

  it('(b) is change-sensitive: different schemaSource → different names', () => {
    const a = resolveDatabaseSchema({ schemaSource: SAMPLE, env: {} });
    const b = resolveDatabaseSchema({
      schemaSource: SAMPLE + '// added a column\n',
      env: {},
    });
    expect(a).not.toBe(b);
  });

  it('(c) matches the pinned sha256[:8] algorithm', () => {
    const expected =
      'jinn_indexer_' +
      createHash('sha256').update(SAMPLE).digest('hex').slice(0, 8);
    expect(resolveDatabaseSchema({ schemaSource: SAMPLE, env: {} })).toBe(expected);
  });

  it('(d) honors a manual override when auto is disabled', () => {
    const name = resolveDatabaseSchema({
      schemaSource: SAMPLE,
      env: { JINN_INDEXER_SCHEMA_AUTO: 'false', DATABASE_SCHEMA: 'jinn_indexer_v9' },
    });
    expect(name).toBe('jinn_indexer_v9');
  });

  it('(e) rejects an invalid manual override', () => {
    expect(() =>
      resolveDatabaseSchema({
        schemaSource: SAMPLE,
        env: { JINN_INDEXER_SCHEMA_AUTO: 'false', DATABASE_SCHEMA: '9bad-name' },
      }),
    ).toThrow();
  });

  it('(f) fails loud when auto is disabled but no DATABASE_SCHEMA is set', () => {
    expect(() =>
      resolveDatabaseSchema({
        schemaSource: SAMPLE,
        env: { JINN_INDEXER_SCHEMA_AUTO: 'false' },
      }),
    ).toThrow();
  });

  it('(g) derives a safe Postgres identifier ≤ 63 chars', () => {
    // Conformance to indexer-enrichment/src/config.ts:39
    // (`/^[A-Za-z_][A-Za-z0-9_]*$/`); Postgres identifiers cap at 63 chars.
    const name = resolveDatabaseSchema({ schemaSource: SAMPLE, env: {} });
    expect(name).toMatch(/^[A-Za-z_][A-Za-z0-9_]*$/);
    expect(name.length).toBeLessThanOrEqual(63);
  });

  it('(h) auto-derives by default and treats explicit true identically', () => {
    const def = resolveDatabaseSchema({ schemaSource: SAMPLE, env: {} });
    const explicit = resolveDatabaseSchema({
      schemaSource: SAMPLE,
      env: { JINN_INDEXER_SCHEMA_AUTO: 'true' },
    });
    const expected =
      'jinn_indexer_' +
      createHash('sha256').update(SAMPLE).digest('hex').slice(0, 8);
    expect(def).toBe(expected);
    expect(explicit).toBe(expected);
  });
});
