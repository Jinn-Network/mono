import { describe, expect, it } from 'vitest';
import { buildHarnessReadinessRegistry } from '../../src/main.js';
import type { Harness } from '../../src/harnesses/types.js';

describe('buildHarnessReadinessRegistry', () => {
  it('composes the registry from buildHarnesses() output + config.joinedSolverNets', async () => {
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
      joinedSolverNets: {
        'bafkrei.x': {
          manifestCid: 'bafkrei.x',
          roles: ['solver' as const],
          harness: 'claude-code-learner',
          plugins: [],
          disabledDefaultPlugins: [],
        },
      },
    };
    const registry = buildHarnessReadinessRegistry({ harnesses, config });
    await registry.refreshNow();
    const entry = registry.getSnapshot().harnesses.find((h) => h.harnessName === 'claude-code-learner');
    expect(entry?.ready).toBe(true);
    expect(entry?.manifestCids).toContain('bafkrei.x');
  });
});
