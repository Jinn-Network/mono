import { describe, it, expect } from 'vitest';
import { runCoordinator } from '../src/coordinator.js';
import { createMockHarness } from '../src/mock-harness.js';
import type {
  ExternalRestorerEnv,
  RestorationContext,
} from '@jinn-network/restorer-sdk';
import type { HarnessAdapter, HarnessPromptArgs } from '../src/harness.js';

const env: ExternalRestorerEnv = {
  implName: '@jinn-examples/alternative-harness',
  implVersion: '0.1.0',
  network: 'base-sepolia',
  implStateDir: '/tmp/x',
  secrets: Object.freeze({}),
  log: () => {},
  stub: false,
};

const ctx: RestorationContext = {
  intent: { id: 'phase-order-1', spec: { kind: 'prediction.v0' } },
  intentCid: undefined,
  implStateDir: '/tmp/x',
  workingDir: '/tmp/x-work',
  log: () => {},
  abort: new AbortController().signal,
  msUntilEndTs: () => 60_000,
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

  it('passes harness.name into RestorationOutput.venueRef', async () => {
    const harness = createMockHarness(env);
    const out = await runCoordinator({ ctx, harness });
    expect(out.venueRef.name).toBe('mock-harness');
  });
});
