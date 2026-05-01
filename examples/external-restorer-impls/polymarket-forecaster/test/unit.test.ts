import { describe, it, expect } from 'vitest';
import createRestorer from '../src/index.js';
import type {
  ExternalRestorerEnv,
  RestorationContext,
} from '@jinn-network/restorer-sdk';

const env: ExternalRestorerEnv = {
  implName: '@jinn-examples/polymarket-forecaster',
  implVersion: '0.1.0',
  network: 'base-sepolia',
  implStateDir: '/tmp/polymarket',
  secrets: Object.freeze({}),
  log: () => {},
  stub: false,
};

function makeCtx(marketId: string): RestorationContext {
  return {
    intent: { id: 'i-1', spec: { kind: 'prediction.v0', marketId } },
    intentCid: undefined,
    implStateDir: '/tmp/polymarket',
    workingDir: '/tmp/polymarket-work',
    log: () => {},
    abort: new AbortController().signal,
    msUntilEndTs: () => 60_000,
  };
}

describe('@jinn-examples/polymarket-forecaster', () => {
  it('supports prediction.v0 restoration only (not evaluation)', () => {
    const impl = createRestorer(env);
    expect(impl.supports({ kind: 'prediction.v0', type: 'restoration' })).toBe(
      true,
    );
    expect(impl.supports({ kind: 'prediction.v0', type: 'evaluation' })).toBe(
      false,
    );
    expect(impl.supports({ kind: 'portfolio.v0' })).toBe(false);
  });

  it('produces a probability in [0.01, 0.99] for any deterministic market id', async () => {
    const impl = createRestorer(env);
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
    const impl = createRestorer({ ...env, stub: true });
    const ready = await impl.isReady?.();
    expect(ready?.ready).toBe(false);
    expect(ready?.reason).toBe('stub mode');
  });

  it('reports ready when env.stub=false', async () => {
    const impl = createRestorer({ ...env, stub: false });
    const ready = await impl.isReady?.();
    expect(ready?.ready).toBe(true);
  });

  it('falls back to intent.id when spec.marketId is absent', async () => {
    const impl = createRestorer(env);
    const out = await impl.run({
      intent: { id: 'fallback-id', spec: { kind: 'prediction.v0' } },
      intentCid: undefined,
      implStateDir: '/tmp/x',
      workingDir: '/tmp/x-work',
      log: () => {},
      abort: new AbortController().signal,
      msUntilEndTs: () => 60_000,
    });
    expect(out.gating.marketId).toBe('fallback-id');
  });

  it('emits a rationale entry with the source price', async () => {
    const impl = createRestorer(env);
    const out = await impl.run(makeCtx('m-test'));
    expect(out.rationale).toBeDefined();
    expect(out.rationale?.[0]?.message).toMatch(/market price/i);
  });
});
