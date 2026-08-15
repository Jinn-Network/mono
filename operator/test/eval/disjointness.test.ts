import { describe, it, expect } from 'vitest';
import { buildCorpusIndex, type CorpusRecord } from '../../src/eval/corpus-index.js';
import {
  checkCorpusDisjoint, assertCorpusDisjoint, CorpusContaminationError,
  type SlateTaskForDisjointness,
} from '../../src/eval/disjointness.js';

const corpus: CorpusRecord[] = [
  { id: 'skill:generic', repos: ['django'], instanceIdsReferenced: [], text: 'general debugging with pdb and breakpoints' },
];

const cleanTask: SlateTaskForDisjointness = {
  instance_id: 'astropy__astropy-19438', repo: 'astropy', goldPatchTokens: ['wcs', 'modeling', 'core'],
};

describe('corpus disjointness', () => {
  it('passes when the slate shares no instance, repo, or tokens with the corpus', () => {
    const r = checkCorpusDisjoint([cleanTask], buildCorpusIndex(corpus));
    expect(r.instance.verdict).toBe('pass');
    expect(r.repo.verdict).toBe('pass');
    expect(r.lexical.verdict).toBe('pass');
  });

  it('flags a repo-axis overlap', () => {
    const task = { ...cleanTask, repo: 'django' };
    const r = checkCorpusDisjoint([task], buildCorpusIndex(corpus));
    expect(r.repo.verdict).toBe('fail');
    expect(r.repo.flaggedPairs).toContainEqual([task.instance_id, 'skill:generic']);
  });

  it('flags an instance-axis overlap', () => {
    const withRef: CorpusRecord[] = [{ ...corpus[0]!, instanceIdsReferenced: ['astropy__astropy-19438'] }];
    const r = checkCorpusDisjoint([cleanTask], buildCorpusIndex(withRef));
    expect(r.instance.verdict).toBe('fail');
  });

  it('flags a lexical overlap when gold tokens are dense in a corpus record', () => {
    const leaky: CorpusRecord[] = [{ id: 'skill:leak', repos: ['x'], instanceIdsReferenced: [], text: 'wcs modeling core transform fix' }];
    const r = checkCorpusDisjoint([cleanTask], buildCorpusIndex(leaky), { lexicalJaccardThreshold: 0.2 });
    expect(r.lexical.verdict).toBe('fail');
  });

  it('assertCorpusDisjoint throws on any failing axis', () => {
    const task = { ...cleanTask, repo: 'django' };
    expect(() => assertCorpusDisjoint([task], buildCorpusIndex(corpus))).toThrow(CorpusContaminationError);
  });

  it('does not false-positive when gold tokens or corpus text are empty (all-zero sketches)', () => {
    const emptyGold: SlateTaskForDisjointness = { instance_id: 'x__y-1', repo: 'x', goldPatchTokens: [] };
    const emptyCorpus: CorpusRecord[] = [{ id: 'skill:empty', repos: ['zzz'], instanceIdsReferenced: [], text: '' }];
    const r = checkCorpusDisjoint([emptyGold], buildCorpusIndex(emptyCorpus));
    expect(r.lexical.verdict).toBe('pass');
    expect(() => assertCorpusDisjoint([emptyGold], buildCorpusIndex(emptyCorpus))).not.toThrow();
  });

  it('assertCorpusDisjoint throws on an instance-only overlap (fail-loud on a non-repo axis)', () => {
    const withRef: CorpusRecord[] = [{ id: 'skill:ref', repos: ['zzz'], instanceIdsReferenced: ['astropy__astropy-19438'], text: 'unrelated text' }];
    expect(() => assertCorpusDisjoint([cleanTask], buildCorpusIndex(withRef))).toThrow(CorpusContaminationError);
  });
});
