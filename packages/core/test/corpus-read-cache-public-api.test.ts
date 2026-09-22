/**
 * Pins #4500 option (b): unverified cache helpers are not on the public
 * corpus-read surface. Live readers digest-check through acquire /
 * artifact-retrieval; these helpers had no consumers and reopened the
 * byte-admission gap #4359 closed.
 */
import { describe, expect, it } from 'vitest';
import * as corpusRead from '../src/corpus-read/index.js';

describe('corpus-read public cache surface', () => {
  it('does not export getCachedArtifact or hasCachedArtifact', () => {
    expect(corpusRead).not.toHaveProperty('getCachedArtifact');
    expect(corpusRead).not.toHaveProperty('hasCachedArtifact');
  });
});
