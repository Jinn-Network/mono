import { describe, it, expect } from 'vitest';
import type { PublishedArtifact, PluginPublication } from '../../src/discovery/types.js';

describe('PublishedArtifact base interface (attd)', () => {
  it('PluginPublication is assignable to PublishedArtifact with discriminator artifactType=plugin', () => {
    const sample: PluginPublication = {
      artifactType: 'plugin',
      builderAgentId: '42',
      cid: 'bafyplugincid',
      name: '@builder/swe-skill',
      version: '0.1.0',
      supports: ['swe-rebench-v2.v1'],
      publishedAt: 1_715_700_000,
      revoked: false,
      pluginSha256: `0x${'aa'.repeat(32)}`,
    };
    const widened: PublishedArtifact = sample;
    expect(widened.artifactType).toBe('plugin');
    // Type-narrowing test — the discriminator works.
    if (widened.artifactType === 'plugin') {
      const narrowed: PluginPublication = widened;
      expect(narrowed.pluginSha256).toMatch(/^0x[0-9a-f]+$/);
    }
  });
});
