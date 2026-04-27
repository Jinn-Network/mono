/**
 * Tests for per-kind implStateDir partitioning.
 *
 * Spec: implStateDirRoot/<impl.name>/<kind> where kind has . and : replaced by _.
 * Two intents with the same kind share a state dir; different kinds get separate dirs.
 */
import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import {
  RestorationEngine,
  type RestorationEngineOptions,
} from '../../../src/restorer/engine/engine.js';
import { IntentPersistence } from '../../../src/restorer/engine/persistence.js';
import { IntentState } from '../../../src/restorer/engine/state.js';
import type { RestorerImpl, RestorationContext, RestorationOutput } from '../../../src/restorer/types.js';
import { withTempStore } from '@test/store.js';
import { makeIntentInput } from '@test/engine.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

const ROOT = mkdtempSync(join(tmpdir(), 'jinn-impls-'));
const NOOP_REGISTRY = { resolveImplName: () => null };

function makeOpts(
  store: Parameters<RestorationEngineOptions['store']['db']['prepare']>[0] extends never ? never : any,
  implRegistry: RestorationEngineOptions['implRegistry'],
): RestorationEngineOptions {
  return {
    store,
    registry: NOOP_REGISTRY,
    paths: { workingDirRoot: join(ROOT, 'work'), implStateDirRoot: join(ROOT, 'impl') },
    implRegistry,
  };
}

function makeRecordingImpl(name: string, supportedKind: string) {
  const received: RestorationContext[] = [];
  const impl: RestorerImpl = {
    name,
    version: '0.0.1',
    supports: (s) => s.kind === supportedKind || supportedKind === '*',
    async run(ctx): Promise<RestorationOutput> {
      received.push(ctx);
      return {
        venueRef: { name },
        gating: { ok: true },
        preSnapshot: { capturedAt: Date.now(), hlTime: 0 },
        postSnapshot: { capturedAt: Date.now(), hlTime: 0 },
        fills: [],
      };
    },
  };
  return { impl, received };
}

async function runToPostPreSnapshot(
  store: any,
  implRegistry: RestorationEngineOptions['implRegistry'],
  requestId: string,
  specKind: string,
): Promise<string | null> {
  const engine = new RestorationEngine(makeOpts(store, implRegistry));
  const persistence = new IntentPersistence(store.db);

  // windowStartTs in the past so dataDrivenAdvance fires immediately.
  const now = Date.now();
  await engine.observe(
    makeIntentInput({ requestId, specKind, windowStartTs: now - 1000, windowEndTs: now + 86_400_000 }),
  );
  persistence.transition(requestId, IntentState.CLAIMED);
  persistence.transition(requestId, IntentState.WAITING);
  await engine.process(requestId);

  const persisted = persistence.getByRequestId(requestId);
  return persisted?.implStateDir ?? null;
}

describe('engine per-kind implStateDir partitioning', () => {
  it('two intents of the same kind share the same implStateDir', async () => {
    await withTempStore(async (store) => {
      const { impl } = makeRecordingImpl('test-impl', 'prediction.v0');
      const registry = { findFor: (s: { kind: string }) => (impl.supports(s) ? impl : undefined) };

      const dir1 = await runToPostPreSnapshot(store, registry, 'same-kind-1', 'prediction.v0');
      const dir2 = await runToPostPreSnapshot(store, registry, 'same-kind-2', 'prediction.v0');

      expect(dir1).not.toBeNull();
      expect(dir2).not.toBeNull();
      expect(dir1).toBe(dir2);
    });
  });

  it('two intents of different kinds get separate implStateDirs', async () => {
    await withTempStore(async (store) => {
      const implA = makeRecordingImpl('test-impl', 'prediction.v0').impl;
      const implB = makeRecordingImpl('test-impl', 'portfolio.v0').impl;
      const catchAll: RestorerImpl = {
        name: 'test-impl',
        version: '0.0.1',
        supports: (s) => ['prediction.v0', 'portfolio.v0'].includes(s.kind),
        run: async (ctx): Promise<RestorationOutput> => {
          void implA; void implB;
          return {
            venueRef: { name: 'test-impl' },
            gating: { ok: true },
            preSnapshot: { capturedAt: Date.now(), hlTime: 0 },
            postSnapshot: { capturedAt: Date.now(), hlTime: 0 },
            fills: [],
          };
        },
      };
      const registry = { findFor: (s: { kind: string }) => (catchAll.supports(s) ? catchAll : undefined) };

      const dirPred = await runToPostPreSnapshot(store, registry, 'diff-kind-1', 'prediction.v0');
      const dirPort = await runToPostPreSnapshot(store, registry, 'diff-kind-2', 'portfolio.v0');

      expect(dirPred).not.toBeNull();
      expect(dirPort).not.toBeNull();
      expect(dirPred).not.toBe(dirPort);

      // Both must contain the impl name, then end with the sanitized kind.
      expect(dirPred).toContain('/test-impl/');
      expect(dirPred!.endsWith('/prediction_v0')).toBe(true);
      expect(dirPort).toContain('/test-impl/');
      expect(dirPort!.endsWith('/portfolio_v0')).toBe(true);
    });
  });

  it('sanitizes . and : in kind name', async () => {
    await withTempStore(async (store) => {
      // Use a kind with both . and : to confirm sanitization.
      const { impl } = makeRecordingImpl('test-impl', 'foo:bar.v1');
      const registry = { findFor: (s: { kind: string }) => (impl.supports(s) ? impl : undefined) };

      const dir = await runToPostPreSnapshot(store, registry, 'sanitize-1', 'foo:bar.v1');

      expect(dir).not.toBeNull();
      expect(dir!.endsWith('/foo_bar_v1')).toBe(true);
      expect(dir).toContain('/test-impl/');
    });
  });

  it('legacy intent with no specKind adds no kind segment (backward-compatible path)', async () => {
    await withTempStore(async (store) => {
      // An impl that matches the empty-kind fallback.
      const { impl } = makeRecordingImpl('fallback-impl', '');
      const registry = { findFor: (s: { kind: string }) => (s.kind === '' ? impl : undefined) };

      const engine = new RestorationEngine(makeOpts(store, registry));
      const persistence = new IntentPersistence(store.db);

      const now = Date.now();
      // specKind undefined → stored as null → implStateName falls back to 'default'
      await engine.observe(makeIntentInput({
        requestId: 'legacy-1',
        specKind: undefined as unknown as string,
        windowStartTs: now - 1000,
        windowEndTs: now + 86_400_000,
      }));
      persistence.transition('legacy-1', IntentState.CLAIMED);
      persistence.transition('legacy-1', IntentState.WAITING);
      await engine.process('legacy-1');

      const persisted = persistence.getByRequestId('legacy-1');
      // No kind segment — path is <root>/default (specKind was null → fallback name)
      expect(persisted?.implStateDir?.endsWith('/default')).toBe(true);
      // Must NOT have a trailing kind directory.
      expect(persisted?.implStateDir).not.toMatch(/\/default\/.+$/);
    });
  });
});
