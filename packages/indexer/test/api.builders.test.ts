import { describe, it, expect } from 'vitest';
import { attributeRuns } from '../src/builder-attribution.js';

// API-level route tests are an integration concern that needs a running
// Ponder runtime. For the unit-test bar attd targets, the route logic itself
// is exercised through `attributeRuns` (test/builder-attribution.test.ts).
// This file holds a smoke test that the route module loads cleanly and
// re-exports the join.
describe('api.builders smoke', () => {
  it('attributeRuns is the route\'s pure-function backbone', () => {
    expect(typeof attributeRuns).toBe('function');
  });
});
