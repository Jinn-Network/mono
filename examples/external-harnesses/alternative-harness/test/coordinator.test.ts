import { describe, it, expect } from 'vitest';
import { runCoordinator } from '../src/coordinator.js';
import { createMockHarness } from '../src/mock-harness.js';
import type {
  ExternalHarnessEnv,
  HarnessContext,
} from '@jinn-network/sdk/harness';
import type { HarnessAdapter, HarnessPromptArgs } from '../src/harness.js';

const env: ExternalHarnessEnv = {
  implName: '@jinn-examples/alternative-harness',
  implVersion: '0.1.0',
  network: 'base-sepolia',
  implStateDir: '/tmp/x',
  secrets: Object.freeze({}),
  log: () => {},
  stub: false,
};

const ctx: HarnessContext = {
  task: {
    id: 'phase-order-1',
    description: 'phase order test',
    solverType: 'prediction.v0',
    spec: {},
  },
  taskCid: undefined,
  implStateDir: '/tmp/x',
  workingDir: '/tmp/x-work',
  log: () => {},
  abort: new AbortController().signal,
  msUntilEndTs: () => 60_000,
    trajectory: { addSpan: () => ({}) },
};

describe('runCoordinator', () => {
  it('invokes phases in order: orient -> strategize -> plan -> execute -> debrief -> improve -> memory', async () => {
    const calls: string[] = [];
    const inner = createMockHarness(env);
    const wrapped: HarnessAdapter = {
      name: inner.name,
      async promptForJson<T>(args: HarnessPromptArgs): Promise<T> {
        calls.push(args.promptId);
        return inner.promptForJson<T>(args);
      },
    };
    await runCoordinator({ ctx, harness: wrapped });
    expect(calls).toEqual([
      'orient',
      'strategize',
      'plan',
      'execute',
      'debrief',
      'improve',
      'memory',
    ]);
  });

  it('passes harness.name into Solution.venueRef', async () => {
    const harness = createMockHarness(env);
    const out = await runCoordinator({ ctx, harness });
    expect(out.venueRef.name).toBe('mock-harness');
  });
});
