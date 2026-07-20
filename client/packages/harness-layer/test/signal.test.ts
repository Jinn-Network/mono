/**
 * Distribution-signal tests (plan Task 7, issue #1314).
 *
 * The critical net is seed exclusion: `provenance: 'imported'` entries appear
 * in NO count — not envelope counts, not contributor counts, not tag
 * frequencies. Clustering is the v0 tag rollup (primary tag = cluster),
 * explicitly replaceable by an upstream clustering endpoint later.
 */

import { describe, it, expect } from 'vitest';
import { computeSignal, type SignalInput } from '../src/signal.js';

function entry(overrides: Partial<SignalInput> = {}): SignalInput {
  return {
    tags: ['typescript', 'testing'],
    provenance: 'contributed',
    contributor: '0x1111111111111111111111111111111111111111',
    ...overrides,
  };
}

describe('computeSignal', () => {
  it('groups by primary tag, sorted by volume', () => {
    const rows = computeSignal([
      entry(),
      entry({ contributor: '0x2222222222222222222222222222222222222222' }),
      entry({ tags: ['research'], contributor: '0x2222222222222222222222222222222222222222' }),
    ]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ cluster: 'typescript', envelopeCount: 2, contributorCount: 2 });
    expect(rows[1]).toMatchObject({ cluster: 'research', envelopeCount: 1, contributorCount: 1 });
  });

  it('topTags carries the cluster tag frequencies beyond the primary', () => {
    const rows = computeSignal([
      entry({ tags: ['typescript', 'testing'] }),
      entry({ tags: ['typescript', 'zod'] }),
      entry({ tags: ['typescript', 'testing'] }),
    ]);
    expect(rows[0]!.cluster).toBe('typescript');
    expect(rows[0]!.topTags[0]).toBe('testing');
    expect(rows[0]!.topTags).toContain('zod');
  });

  it('seed exclusion: imported entries appear in no count', () => {
    const rows = computeSignal([
      entry(),
      entry({ provenance: 'imported', tags: ['typescript', 'seeded'] }),
      entry({ provenance: 'imported', tags: ['seeds-only'], contributor: '0x3333333333333333333333333333333333333333' }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ cluster: 'typescript', envelopeCount: 1, contributorCount: 1 });
    expect(rows[0]!.topTags).not.toContain('seeded');
    expect(rows.map((r) => r.cluster)).not.toContain('seeds-only');
  });

  it('includeSeeds folds imported entries back in (the demonstrate-it-live toggle)', () => {
    const input = [entry(), entry({ provenance: 'imported', tags: ['typescript'] })];
    expect(computeSignal(input)[0]!.envelopeCount).toBe(1);
    expect(computeSignal(input, { includeSeeds: true })[0]!.envelopeCount).toBe(2);
  });

  it('keeps derived history distinct and counts it as non-seed evidence', () => {
    const rows = computeSignal([
      entry({ provenance: 'derived-from-history', tags: ['historical', 'verified'] }),
    ]);

    expect(rows).toEqual([
      {
        cluster: 'historical',
        envelopeCount: 1,
        contributorCount: 1,
        topTags: ['verified'],
      },
    ]);
  });

  it('empty corpus yields an empty signal (the caller renders the empty state)', () => {
    expect(computeSignal([])).toEqual([]);
  });

  it('ties break deterministically (alphabetical cluster) so the view is stable', () => {
    const rows = computeSignal([entry({ tags: ['zeta'] }), entry({ tags: ['alpha'] })]);
    expect(rows.map((r) => r.cluster)).toEqual(['alpha', 'zeta']);
  });
});
