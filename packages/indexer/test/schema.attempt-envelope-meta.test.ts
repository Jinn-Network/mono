import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { attemptEnvelopeMeta } from '../ponder.schema.js';

const ponderSchemaSource = readFileSync(
  fileURLToPath(new URL('../ponder.schema.ts', import.meta.url)),
  'utf8',
);

describe('attemptEnvelopeMeta schema (#763)', () => {
  it('is exported from ponder.schema.ts', () => {
    expect(attemptEnvelopeMeta).toBeDefined();
  });

  it('declares an index on codeDigest for per-digest aggregations', () => {
    const start = ponderSchemaSource.indexOf('export const attemptEnvelopeMeta');
    const end = ponderSchemaSource.indexOf('export const verdictEnvelopeMeta', start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(ponderSchemaSource.slice(start, end)).toContain(
      'codeDigestIdx: index().on(table.codeDigest)',
    );
  });
});

/**
 * In-memory stand-in for DR-2026-05-27 §4.2 per-(operator, codeDigest) aggregation.
 * Production filters `attempt_envelope_meta` by `code_digest` so Postgres can use
 * `codeDigestIdx` (see explorer.ts `eq(schema.attemptEnvelopeMeta.codeDigest, digest)`).
 */
type PerCodeDigestJoinRow = {
  operator: string;
  implName: string;
  codeDigest: string;
  mode: string;
  actualPassed: boolean;
  actualScore: string;
};

function aggregatePerCodeDigestByOperator(
  rows: PerCodeDigestJoinRow[],
  operator: string,
): {
  implName: string;
  codeDigest: string;
  mode: string;
  attempts: number;
  passRate: number | null;
  avgScore: number | null;
}[] {
  const filtered = rows.filter((r) => r.operator === operator);
  const groups = new Map<
    string,
    { implName: string; codeDigest: string; mode: string; passes: number; scores: number[]; attempts: number }
  >();

  for (const row of filtered) {
    const key = `${row.implName}\0${row.codeDigest}\0${row.mode}`;
    let g = groups.get(key);
    if (!g) {
      g = {
        implName: row.implName,
        codeDigest: row.codeDigest,
        mode: row.mode,
        passes: 0,
        scores: [],
        attempts: 0,
      };
      groups.set(key, g);
    }
    g.attempts += 1;
    if (row.actualPassed) g.passes += 1;
    if (row.actualScore !== '') g.scores.push(Number(row.actualScore));
  }

  return [...groups.values()]
    .map((g) => ({
      implName: g.implName,
      codeDigest: g.codeDigest,
      mode: g.mode,
      attempts: g.attempts,
      passRate: g.passes / g.attempts,
      avgScore: g.scores.length === 0 ? null : g.scores.reduce((a, b) => a + b, 0) / g.scores.length,
    }))
    .sort((a, b) => {
      const byDigest = a.codeDigest.localeCompare(b.codeDigest);
      if (byDigest !== 0) return byDigest;
      return a.mode.localeCompare(b.mode);
    });
}

describe('per-codeDigest aggregation query shape (#763)', () => {
  const fixture: PerCodeDigestJoinRow[] = [
    {
      operator: '0xOp',
      implName: 'learner',
      codeDigest: 'sha256:aaa',
      mode: 'train',
      actualPassed: true,
      actualScore: '1.0',
    },
    {
      operator: '0xOp',
      implName: 'learner',
      codeDigest: 'sha256:aaa',
      mode: 'train',
      actualPassed: false,
      actualScore: '0.0',
    },
    {
      operator: '0xOp',
      implName: 'learner',
      codeDigest: 'sha256:bbb',
      mode: 'frozen',
      actualPassed: true,
      actualScore: '1.0',
    },
    {
      operator: '0xOther',
      implName: 'learner',
      codeDigest: 'sha256:aaa',
      mode: 'train',
      actualPassed: true,
      actualScore: '1.0',
    },
  ];

  it('groups by implName, codeDigest, and mode for one operator', () => {
    expect(aggregatePerCodeDigestByOperator(fixture, '0xOp')).toEqual([
      {
        implName: 'learner',
        codeDigest: 'sha256:aaa',
        mode: 'train',
        attempts: 2,
        passRate: 0.5,
        avgScore: 0.5,
      },
      {
        implName: 'learner',
        codeDigest: 'sha256:bbb',
        mode: 'frozen',
        attempts: 1,
        passRate: 1,
        avgScore: 1,
      },
    ]);
    expect(aggregatePerCodeDigestByOperator(fixture, '0xOther')).toHaveLength(1);
  });
});
