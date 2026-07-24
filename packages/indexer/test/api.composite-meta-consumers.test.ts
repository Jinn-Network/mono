import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(
  new URL('../src/api/explorer.ts', import.meta.url),
  'utf8',
);

function section(start: string, end: string): string {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  expect(from, `missing start marker: ${start}`).toBeGreaterThanOrEqual(0);
  expect(to, `missing end marker: ${end}`).toBeGreaterThan(from);
  return source.slice(from, to);
}

describe('composite metadata consumers', () => {
  it('network verdict aggregation uses the authoritative exact-one join', () => {
    const network = section(
      "app.get('/network'",
      '// ── GET /explorer/solvernets',
    );
    expect(network).toContain('verdictEnvelopeJoinCondition()');
  });

  it('batched SolverNet verdict aggregation uses the authoritative exact-one join', () => {
    const batch = section(
      'async function getSolverNetStatsBatch',
      'async function getVerdictsForAttempts',
    );
    expect(batch).toContain('verdictEnvelopeJoinCondition()');
  });

  it('fails closed instead of treating an exact-one verdict projection as authenticated', () => {
    const join = section(
      'function verdictEnvelopeJoinCondition()',
      '/**\n * Canonical attempt-envelope join.',
    );
    expect(join).toContain('return sql`false`');
    expect(join).toContain('exact-one join is');
    expect(join).toContain('not authentication');
  });

  it('fails closed instead of treating a unique attempt projection as authenticated', () => {
    const join = section(
      'function attemptEnvelopeJoinCondition()',
      '/**\n * Computes the "truth" of a verdict row.',
    );
    expect(join).toContain('return sql`false`');
  });
});
