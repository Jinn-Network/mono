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

  it('the shared verdict join binds chain linkage and rejects competing linked candidates', () => {
    const join = section(
      'function verdictEnvelopeJoinCondition()',
      '/**\n * Canonical attempt-envelope join.',
    );
    expect(join).toContain('schema.verdictEnvelopeMeta.evaluator');
    expect(join).toContain('schema.verdictEnvelopeMeta.taskId');
    expect(join).toContain('schema.verdictEnvelopeMeta.attemptIndex');
    expect(join).toContain('SELECT count(*)');
    expect(join).toContain(') = 1');
  });
});
