import { describe, it, expect } from 'vitest';
import { Store } from '../../../src/store/store.js';
import { RestorationEngine, type RestorationEngineOptions } from '../../../src/restorer/engine/engine.js';
import { IntentState } from '../../../src/restorer/engine/state.js';
import type { RestorerImpl } from '../../../src/restorer/types.js';

class ExposedEngine extends RestorationEngine {
  async invokeRunImpl(requestId: string): Promise<void> {
    const intent = this.persistence.getOrThrow(requestId);
    await this.runImpl(intent);
  }
}

async function buildEngineWith(run: RestorerImpl['run'], implName = 'legacy-claude') {
  const store = new Store(':memory:');
  const impl: RestorerImpl = {
    name: implName,
    version: '1.0.0',
    supports: () => true,
    run,
  };
  const registry = {
    resolveImplName: () => implName,
    findFor: () => impl,
  };
  const engine = new ExposedEngine({
    store,
    registry,
    implRegistry: registry,
    paths: { workingDirRoot: '/tmp/work', implStateDirRoot: '/tmp/impl' },
  });
  const now = Date.now();
  await engine.observe({
    requestId: 'req-1',
    intentCid: 'bafy',
    onchainCreationTx: '0xabc',
    onchainCreationBlock: 1,
    windowStartTs: now - 10_000,
    windowEndTs: now + 600_000,
    desiredState: { id: 'health-check', description: 'legacy intent' },
  });
  const persistence = (engine as any).persistence;
  persistence.transition('req-1', IntentState.CLAIMED);
  persistence.transition('req-1', IntentState.WAITING);
  persistence.transition('req-1', IntentState.PRE_SNAPSHOT, {
    preSnapshotCapturedAt: now - 1_000,
    preSnapshotPayload: { provisioned: true },
  });
  persistence.transition('req-1', IntentState.RUNNING);
  return { engine, persistence, store };
}

describe('legacy-claude skip handling', () => {
  it('treats claude quota/auth errors as a skipped output instead of hard failure', async () => {
    const store = new Store(':memory:');
    try {
      const legacyClaude: RestorerImpl = {
        name: 'legacy-claude',
        version: '1.0.0',
        supports: () => true,
        run: async () => {
          throw new Error('Claude quota exhausted. Please login again.');
        },
      };
      const registry = {
        resolveImplName: () => 'legacy-claude',
        findFor: () => legacyClaude,
      };
      const opts: RestorationEngineOptions = {
        store,
        registry,
        implRegistry: registry,
        paths: {
          workingDirRoot: '/tmp/work',
          implStateDirRoot: '/tmp/impl',
        },
      };
      const engine = new ExposedEngine(opts);

      const now = Date.now();
      await engine.observe({
        requestId: 'req-skip-1',
        intentCid: 'bafy-skip',
        onchainCreationTx: '0xabc',
        onchainCreationBlock: 1,
        windowStartTs: now - 10_000,
        windowEndTs: now + 600_000,
        desiredState: {
          id: 'health-check',
          description: 'legacy intent',
        },
      });
      const persistence = (engine as any).persistence;
      persistence.transition('req-skip-1', IntentState.CLAIMED);
      persistence.transition('req-skip-1', IntentState.WAITING);
      persistence.transition('req-skip-1', IntentState.PRE_SNAPSHOT, {
        preSnapshotCapturedAt: now - 1_000,
        preSnapshotPayload: { provisioned: true },
      });
      persistence.transition('req-skip-1', IntentState.RUNNING);

      await engine.invokeRunImpl('req-skip-1');

      const intent = persistence.getOrThrow('req-skip-1');
      expect(intent.state).toBe(IntentState.POST_SNAPSHOT);
      expect(intent.gatingClaim).toMatchObject({
        skipped: true,
        reason: 'claude_unavailable',
      });
      expect(intent.informationalClaim).toMatchObject({
        status: 'skipped',
      });
    } finally {
      store.close();
    }
  });

  it('does NOT skip when the error is a generic rate-limit surfaced through legacy-claude', async () => {
    const { engine, persistence, store } = await buildEngineWith(async () => {
      throw new Error('upstream RPC rate limit exceeded: 429 from base.org');
    });
    try {
      await expect(engine.invokeRunImpl('req-1')).rejects.toThrow(/rate limit exceeded/);
      const intent = persistence.getOrThrow('req-1');
      // Stayed in RUNNING — no silent skip, no POST_SNAPSHOT transition.
      expect(intent.state).toBe(IntentState.RUNNING);
    } finally {
      store.close();
    }
  });

  it('does NOT skip when a non-legacy-claude impl throws a claude-sounding error', async () => {
    const { engine, persistence, store } = await buildEngineWith(
      async () => {
        throw new Error('Claude quota exhausted (but we are not legacy-claude).');
      },
      'prediction-v0-baseline',
    );
    try {
      await expect(engine.invokeRunImpl('req-1')).rejects.toThrow(/Claude quota exhausted/);
      const intent = persistence.getOrThrow('req-1');
      expect(intent.state).toBe(IntentState.RUNNING);
    } finally {
      store.close();
    }
  });
});
