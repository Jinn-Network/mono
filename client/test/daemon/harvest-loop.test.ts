import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runHarvestTick } from '../../src/daemon/harvest-loop.js';
import { repoSlugFromRemoteUrl } from '../../src/solver-types/_swe-rebench-v2-commit-echo-git.js';

describe('runHarvestTick', () => {
  it('skips when validated pool is empty', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'harvest-skip-'));
    try {
      const result = await runHarvestTick({
        intervalMs: 60_000,
        stateDir: dir,
        repos: [{ path: '/tmp/repo', repo: 'acme/widget' }],
        limitPerRepo: 1,
        publish: false,
        isDockerAvailable: () => true,
        mintDeps: {
          stateDir: dir,
          ipfsRegistryUrl: 'https://registry.example',
          ipfsGatewayUrl: 'https://gateway.example',
          validatedStore: new (await import('../../src/solver-types/_swe-rebench-v2-validated-pool.js')).ValidatedPoolStore({ stateDir: dir }),
          mintedStore: new (await import('../../src/solver-types/_swe-rebench-v2-minted-pool.js')).MintedPoolStore({ stateDir: dir }),
          hfFetcher: { fetchTaskRow: async () => { throw new Error('unused'); } },
          runner: { runEval: async () => { throw new Error('unused'); } },
          upstreamRepoDir: dir,
          publicRepoChecker: { isPublic: async () => true },
        },
      });
      expect(result.skipped).toContain('no-validated-pool');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('repoSlugFromRemoteUrl', () => {
  it('parses ssh and https remotes', () => {
    expect(repoSlugFromRemoteUrl('git@github.com:acme/widget.git')).toBe('acme/widget');
    expect(repoSlugFromRemoteUrl('https://github.com/acme/widget')).toBe('acme/widget');
  });
});
