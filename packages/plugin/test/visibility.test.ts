import { describe, expect, it } from 'vitest';
import { RETRIEVAL_VISIBLE_TAG, hasRetrievalMark } from '../src/visibility.js';

describe('retrieval-visibility mark (issue #1824, corpus-supply-design §5 W2)', () => {
  it('RETRIEVAL_VISIBLE_TAG is the reserved literal', () => {
    expect(RETRIEVAL_VISIBLE_TAG).toBe('retrieval:visible.v1');
  });

  it('hasRetrievalMark is true iff the exact tag is present', () => {
    expect(hasRetrievalMark([RETRIEVAL_VISIBLE_TAG])).toBe(true);
    expect(hasRetrievalMark(['other', RETRIEVAL_VISIBLE_TAG, 'more'])).toBe(true);
  });

  it('is false for an empty tag list', () => {
    expect(hasRetrievalMark([])).toBe(false);
  });

  it('does not fuzzy-match similar or differently-cased tags', () => {
    expect(hasRetrievalMark(['retrieval:visible.v2'])).toBe(false);
    expect(hasRetrievalMark(['RETRIEVAL:VISIBLE.V1'])).toBe(false);
    expect(hasRetrievalMark(['retrieval:visible'])).toBe(false);
    expect(hasRetrievalMark(['xretrieval:visible.v1x'])).toBe(false);
  });
});
