import { describe, expect, it } from 'vitest';
import { KnowledgeHitSchema } from '../../src/schemas/knowledge-hit.js';

describe('KnowledgeHitSchema', () => {
  it('parses a minimal hit (ref + kind only)', () => {
    const parsed = KnowledgeHitSchema.parse({ ref: 'ipfs://abc', kind: 'seed' });
    expect(parsed.ref).toBe('ipfs://abc');
  });

  it('parses a full hit', () => {
    const parsed = KnowledgeHitSchema.parse({
      ref: 'ipfs://abc',
      kind: 'trace',
      title: 'Fix flaky test',
      snippet: 'Use vi.useFakeTimers()',
      score: 0.87,
    });
    expect(parsed.score).toBe(0.87);
  });

  it('rejects an unknown kind', () => {
    expect(() => KnowledgeHitSchema.parse({ ref: 'x', kind: 'bogus' })).toThrow();
  });

  it('rejects an unknown field (strict)', () => {
    expect(() => KnowledgeHitSchema.parse({ ref: 'x', kind: 'seed', extra: 1 })).toThrow();
  });
});
