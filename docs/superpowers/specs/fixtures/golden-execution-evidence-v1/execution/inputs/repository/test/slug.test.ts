import { describe, expect, it } from 'vitest';

import { normalizeSlug } from '../src/slug.js';

describe('normalizeSlug', () => {
  it('normalizes simple spaces', () => {
    expect(normalizeSlug('Hello World')).toBe('hello-world');
  });
});
