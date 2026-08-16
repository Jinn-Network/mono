import { describe, expect, it } from 'vitest';
import { buildHarnessReadinessRegistry } from '../../src/main.js';
import type { Harness } from '../../src/harnesses/types.js';

describe('buildHarnessReadinessRegistry', () => {
  it('composes the registry from buildHarnesses() output + config.executionWiring', async () => {
    const harnesses: Harness[] = [
      {
        name: 'claude-code-learner',
        version: '0.0.0',
        supports: () => true,
        run: async () => { throw new Error('not used'); },
        isReady: async () => ({ ready: true }),
      },
    ];
    const config = {
      executionWiring: [{
        workKind: 'bafkrei.x',
        harness: 'claude-code-learner',
        model: 'claude-haiku-4-5-20251001',
        plugins: [],
        credentialRef: 'claude-code-learner-default',
        isolationPolicy: 'process',
        legacyManifestDigest: 'bafkrei.x',
      }],
    };
    const registry = buildHarnessReadinessRegistry({ harnesses, config });
    await registry.refreshNow();
    const entry = registry.getSnapshot().harnesses.find((h) => h.harnessName === 'claude-code-learner');
    expect(entry?.ready).toBe(true);
    expect(entry?.manifestCids).toContain('bafkrei.x');
  });
});
