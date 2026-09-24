import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  missingPortalManifestCopies,
  missingWatchPatterns,
  reachablePortalEdges,
} from '../../../test-support/dockerfile-portals/portal-closure.mjs';

// The image's build context root is packages/ (the Dockerfile COPYs the indexer
// tree and its portal siblings, matching CI's `docker build -f
// indexer/deploy/Dockerfile .` run from packages/), so every path this file
// compares against the Dockerfile is context-relative.
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const contextRoot = resolve(packageRoot, '..');
const dockerfile = readFileSync(resolve(packageRoot, 'deploy/Dockerfile'), 'utf8');
const railwayConfig = readFileSync(resolve(packageRoot, 'deploy/railway.toml'), 'utf8');

describe('indexer deploy image portal completeness', () => {
  const edges = reachablePortalEdges(packageRoot, contextRoot);

  it('walks a non-empty portal closure', () => {
    expect(edges.length).toBeGreaterThan(0);
  });

  it('copies every reachable portal manifest before the install that resolves it', () => {
    expect(missingPortalManifestCopies(dockerfile, edges)).toEqual([]);
  });

  it('watches every reachable portal package and the image package itself', () => {
    const watched = ['indexer', ...edges.map(({ target }) => target)];
    expect(missingWatchPatterns(railwayConfig, watched, 'packages/')).toEqual([]);
  });
});
