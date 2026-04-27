import { describe, it, expect } from 'vitest';
import { makeIntentInput, createStateMachineSpy } from '@test/engine.js';
import { withTempStore } from '@test/store.js';
import { IntentState } from '@/restorer/engine/state.js';

describe('makeIntentInput', () => {
  it('returns a valid PersistedIntentInput with sensible defaults', () => {
    const input = makeIntentInput();
    expect(input.requestId).toMatch(/^req-/);
    expect(input.intentCid).toMatch(/^bafy/);
    expect(input.specKind).toBe('portfolio.v0');
    expect(input.windowStartTs).toBeGreaterThan(0);
    expect(input.windowEndTs).toBeGreaterThan(input.windowStartTs);
  });

  it('applies overrides', () => {
    const input = makeIntentInput({ requestId: 'req-custom', specKind: 'prediction.v0' });
    expect(input.requestId).toBe('req-custom');
    expect(input.specKind).toBe('prediction.v0');
  });
});

describe('createStateMachineSpy', () => {
  it('records which lifecycle methods were called', async () => {
    await withTempStore(async (store) => {
      const { engine, calls } = createStateMachineSpy({ store });
      const persisted = engine.testPersistence.insertDiscovered(makeIntentInput({ requestId: 'r1' }));
      expect(persisted.state).toBe(IntentState.DISCOVERED);
      await expect(engine.claim(persisted)).rejects.toThrow();
      expect(calls).toContain('claim');
    });
  });
});
