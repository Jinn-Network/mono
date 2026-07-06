import { describe, it, expect } from 'vitest';
import {
  tokenize, minhashSketch, buildCorpusIndex, corpusSnapshotCid, type CorpusRecord,
} from '../../src/eval/corpus-index.js';

const records: CorpusRecord[] = [
  { id: 'skill:a', repos: ['django'], instanceIdsReferenced: [], text: 'use select_related to fix N+1 queries' },
  { id: 'trace:b', repos: ['astropy'], instanceIdsReferenced: ['astropy__astropy-19438'], text: 'wcs bug fix in modeling core' },
];

describe('corpus derived index', () => {
  it('tokenizes to lowercased alphanumeric words', () => {
    expect(tokenize('Fix  N+1, select_related!')).toEqual(['fix', 'n', '1', 'select_related']);
  });

  it('minhash sketch is deterministic and fixed length', () => {
    const s1 = minhashSketch(tokenize(records[0]!.text));
    const s2 = minhashSketch(tokenize(records[0]!.text));
    expect(s1).toEqual(s2);
    expect(s1).toHaveLength(64);
  });

  it('index sorts repos + instance ids and carries a sketch per record', () => {
    const idx = buildCorpusIndex(records);
    expect(idx.repos).toEqual(['astropy', 'django']);
    expect(idx.instanceIds).toEqual(['astropy__astropy-19438']);
    expect(idx.records.map((r) => r.id)).toEqual(['skill:a', 'trace:b']);
    expect(idx.records[0]!.sketch).toHaveLength(64);
  });

  it('snapshot cid is stable under record reordering', () => {
    const a = corpusSnapshotCid(buildCorpusIndex(records));
    const b = corpusSnapshotCid(buildCorpusIndex([records[1]!, records[0]!]));
    expect(a).toBe(b);
    expect(a).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('cid is stable under reordering even when two records share an id', () => {
    const dup: CorpusRecord[] = [
      { id: 'x', repos: ['a'], instanceIdsReferenced: [], text: 'alpha text one' },
      { id: 'x', repos: ['b'], instanceIdsReferenced: [], text: 'beta text two' },
    ];
    const a = corpusSnapshotCid(buildCorpusIndex(dup));
    const b = corpusSnapshotCid(buildCorpusIndex([dup[1]!, dup[0]!]));
    expect(a).toBe(b);
  });
});
