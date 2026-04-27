import { describe, it, expect } from 'vitest';

import { IntentState } from '../../../src/restorer/engine/state.js';
import type { RestorerImpl, RestorationOutput, ReadyStatus } from '../../../src/restorer/types.js';
import type { ClaimRegistryClient } from '../../../src/adapters/claim-registry/client.js';
import type { MarketplaceClaimer } from '../../../src/restorer/engine/claim.js';
import { withTempStore } from '@test/store.js';
import { makeIntentInput, createStateMachineSpy } from '@test/engine.js';

function stubImpl(overrides: Partial<RestorerImpl> & { isReady?: () => Promise<ReadyStatus> } = {}): RestorerImpl {
  return {
    name: 'stub-impl',
    version: '1.0.0',
    supports: () => true,
    run: async (): Promise<RestorationOutput> => ({ venueRef: { name: 'stub' }, gating: {} }),
    ...overrides,
  };
}

function makeClaimDeps() {
  const registryClient: ClaimRegistryClient = {
    weAlreadyClaimed: async () => false,
    claimJob: async () => ({ claimed: true, txHash: '0xabc' as `0x${string}` }),
    releaseClaim: async () => ({ released: true }),
  } as unknown as ClaimRegistryClient;
  const marketplaceClaimer: MarketplaceClaimer = {
    claimRequest: async () => {},
  } as unknown as MarketplaceClaimer;
  return { registryClient, marketplaceClaimer };
}

describe('RestorationEngine.claim — impl gate', () => {
  it('refuses to claim when no impl is registered for the intent\'s kind', async () => {
    await withTempStore(async (store) => {
      const { engine } = createStateMachineSpy({
        store,
        claimDeps: makeClaimDeps(),
        implRegistry: { findFor: () => undefined },
      });
      engine.testPersistence.insertDiscovered(makeIntentInput({ requestId: 'req-gate', specKind: 'portfolio.v0' }));

      await expect(engine.process('req-gate')).rejects.toThrow(/no impl registered or enabled/);
      const after = engine.testPersistence.getByRequestId('req-gate')!;
      expect(after.state).toBe(IntentState.FAILED);
      expect(after.failureReason).toMatch(/jinn intents enable portfolio.v0/);
    });
  });

  it('refuses to claim when impl reports not-ready', async () => {
    await withTempStore(async (store) => {
      const notReadyImpl = stubImpl({
        isReady: async () => ({ ready: false, reason: 'api-wallet not approved', nextStep: { description: 'do the thing', cli: 'jinn intents enable portfolio.v0 --confirm-approved' } }),
      });
      const { engine } = createStateMachineSpy({
        store,
        claimDeps: makeClaimDeps(),
        implRegistry: { findFor: () => notReadyImpl },
      });
      engine.testPersistence.insertDiscovered(makeIntentInput({ requestId: 'req-gate', specKind: 'portfolio.v0' }));

      await expect(engine.process('req-gate')).rejects.toThrow(/not ready/);
      const after = engine.testPersistence.getByRequestId('req-gate')!;
      expect(after.state).toBe(IntentState.FAILED);
      expect(after.failureReason).toMatch(/api-wallet not approved/);
      expect(after.failureReason).toMatch(/jinn intents enable portfolio.v0 --confirm-approved/);
    });
  });

  it('proceeds with claim when impl is registered and ready', async () => {
    await withTempStore(async (store) => {
      const readyImpl = stubImpl({ isReady: async () => ({ ready: true }) });
      const { engine } = createStateMachineSpy({
        store,
        claimDeps: makeClaimDeps(),
        implRegistry: { findFor: () => readyImpl },
      });
      engine.testPersistence.insertDiscovered(makeIntentInput({ requestId: 'req-gate', specKind: 'portfolio.v0' }));

      await engine.process('req-gate');
      const after = engine.testPersistence.getByRequestId('req-gate')!;
      expect(after.state).toBe(IntentState.CLAIMED);
    });
  });

  it('does not gate when implRegistry is absent (legacy test-mode path)', async () => {
    await withTempStore(async (store) => {
      const { engine } = createStateMachineSpy({
        store,
        claimDeps: makeClaimDeps(),
        // No implRegistry — gate must no-op so raw claim path works.
      });
      engine.testPersistence.insertDiscovered(makeIntentInput({ requestId: 'req-gate', specKind: 'portfolio.v0' }));

      await engine.process('req-gate');
      const after = engine.testPersistence.getByRequestId('req-gate')!;
      expect(after.state).toBe(IntentState.CLAIMED);
    });
  });
});
