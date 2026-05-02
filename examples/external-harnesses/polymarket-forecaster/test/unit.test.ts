import { describe, it, expect } from 'vitest';
import createHarness from '../src/index.js';
import type {
  ExternalHarnessEnv,
  HarnessContext,
} from '@jinn-network/sdk/harness';

const env: ExternalHarnessEnv = {
  implName: '@jinn-examples/polymarket-forecaster',
  implVersion: '0.1.0',
  network: 'base-sepolia',
  implStateDir: '/tmp/polymarket',
  secrets: Object.freeze({}),
  log: () => {},
  stub: false,
};

function makeCtx(marketId: string): HarnessContext {
  return {
    task: {
      id: 'i-1',
      description: 'forecast market',
      solverType: 'prediction.v0',
      spec: { marketId },
    },
    taskCid: undefined,
    implStateDir: '/tmp/polymarket',
    workingDir: '/tmp/polymarket-work',
    log: () => {},
    abort: new AbortController().signal,
    msUntilEndTs: () => 60_000,
    trajectory: { addSpan: () => ({}) },
  };
}

describe('@jinn-examples/polymarket-forecaster', () => {
  it('supports prediction.v0 restoration only (not evaluation)', () => {
    const impl = createHarness(env);
    expect(impl.supports({ solverType: 'prediction.v0', role: 'restoration' })).toBe(
      true,
    );
    expect(impl.supports({ solverType: 'prediction.v0', role: 'evaluation' })).toBe(
      false,
    );
    expect(impl.supports({ solverType: '' })).toBe(false);
  });

  it('produces a probability in [0.01, 0.99] for any deterministic market id', async () => {
    const impl = createHarness(env);
    for (const marketId of ['m-a', 'm-b', 'm-c', 'm-deadbeef']) {
      const out = await impl.run(makeCtx(marketId));
      const p = out.gating.probability as number;
      expect(p).toBeGreaterThanOrEqual(0.01);
      expect(p).toBeLessThanOrEqual(0.99);
      expect(out.gating.marketId).toBe(marketId);
      expect(out.venueRef.name).toBe('polymarket');
    }
  });

  it('reports stub readiness when env.stub=true', async () => {
    const impl = createHarness({ ...env, stub: true });
    const ready = await impl.isReady?.();
    expect(ready?.ready).toBe(false);
    expect(ready?.reason).toBe('stub mode');
  });

  it('reports ready when env.stub=false', async () => {
    const impl = createHarness({ ...env, stub: false });
    const ready = await impl.isReady?.();
    expect(ready?.ready).toBe(true);
  });

  it('falls back to task.id when spec.marketId is absent', async () => {
    const impl = createHarness(env);
    const out = await impl.run({
      task: {
        id: 'fallback-id',
        description: 'forecast fallback market',
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
    });
    expect(out.gating.marketId).toBe('fallback-id');
  });

  it('emits a rationale entry with the source price', async () => {
    const impl = createHarness(env);
    const out = await impl.run(makeCtx('m-test'));
    expect(out.rationale).toBeDefined();
    expect(out.rationale?.[0]?.message).toMatch(/market price/i);
  });
});
