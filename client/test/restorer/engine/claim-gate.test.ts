import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Store } from '../../../src/store/store.js';
import {
  RestorationEngine,
  type RestorerImplRegistry as EngineRegistry,
} from '../../../src/restorer/engine/engine.js';
import type { PersistedIntent, PersistedIntentInput } from '../../../src/restorer/engine/persistence.js';
import { IntentState } from '../../../src/restorer/engine/state.js';
import type { RestorerImpl, RestorationOutput, ReadyStatus } from '../../../src/restorer/types.js';
import type { ClaimRegistryClient } from '../../../src/adapters/claim-registry/client.js';
import type { MarketplaceClaimer } from '../../../src/restorer/engine/claim.js';

const noopResolver: EngineRegistry = { resolveImplName: () => null };

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

function makeInput(id = 'req-gate'): PersistedIntentInput {
  const now = Date.now();
  return {
    requestId: id,
    intentCid: 'bafy',
    onchainCreationTx: '0xtx' as `0x${string}`,
    onchainCreationBlock: 1,
    specKind: 'portfolio.v0',
    windowStartTs: now + 1000,
    windowEndTs: now + 60_000,
    desiredState: { id, description: 'test' },
  };
}

class TestEngine extends RestorationEngine {
  async callClaim(intent: PersistedIntent): Promise<void> {
    return this.claim(intent);
  }
  get db(): import('../../../src/restorer/engine/persistence.js').IntentPersistence {
    return this.persistence;
  }
}

describe('RestorationEngine.claim — impl gate', () => {
  let dir: string;
  let store: Store;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'jinn-claim-gate-'));
    store = new Store(join(dir, 'jinn.db'));
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('refuses to claim when no impl is registered for the intent\'s kind', async () => {
    const engine = new TestEngine({
      store,
      registry: noopResolver,
      paths: { workingDirRoot: '/tmp', implStateDirRoot: '/tmp' },
      claimDeps: makeClaimDeps(),
      implRegistry: { findFor: () => undefined },
    });
    const input = makeInput();
    engine.db.insertDiscovered(input);

    const persisted = engine.db.getByRequestId(input.requestId)!;
    await expect(engine.callClaim(persisted)).rejects.toThrow(/no impl registered or enabled/);
    const after = engine.db.getByRequestId(input.requestId)!;
    expect(after.state).toBe(IntentState.FAILED);
    expect(after.failureReason).toMatch(/jinn intents enable portfolio.v0/);
  });

  it('refuses to claim when impl reports not-ready', async () => {
    const notReadyImpl = stubImpl({
      isReady: async () => ({ ready: false, reason: 'api-wallet not approved', nextStep: { description: 'do the thing', cli: 'jinn intents enable portfolio.v0 --confirm-approved' } }),
    });
    const engine = new TestEngine({
      store,
      registry: noopResolver,
      paths: { workingDirRoot: '/tmp', implStateDirRoot: '/tmp' },
      claimDeps: makeClaimDeps(),
      implRegistry: { findFor: () => notReadyImpl },
    });
    const input = makeInput();
    engine.db.insertDiscovered(input);

    const persisted = engine.db.getByRequestId(input.requestId)!;
    await expect(engine.callClaim(persisted)).rejects.toThrow(/not ready/);
    const after = engine.db.getByRequestId(input.requestId)!;
    expect(after.state).toBe(IntentState.FAILED);
    expect(after.failureReason).toMatch(/api-wallet not approved/);
    expect(after.failureReason).toMatch(/jinn intents enable portfolio.v0 --confirm-approved/);
  });

  it('proceeds with claim when impl is registered and ready', async () => {
    const readyImpl = stubImpl({ isReady: async () => ({ ready: true }) });
    const engine = new TestEngine({
      store,
      registry: noopResolver,
      paths: { workingDirRoot: '/tmp', implStateDirRoot: '/tmp' },
      claimDeps: makeClaimDeps(),
      implRegistry: { findFor: () => readyImpl },
    });
    const input = makeInput();
    engine.db.insertDiscovered(input);

    const persisted = engine.db.getByRequestId(input.requestId)!;
    await engine.callClaim(persisted);
    const after = engine.db.getByRequestId(input.requestId)!;
    expect(after.state).toBe(IntentState.CLAIMED);
  });

  it('does not gate when implRegistry is absent (legacy test-mode path)', async () => {
    const engine = new TestEngine({
      store,
      registry: noopResolver,
      paths: { workingDirRoot: '/tmp', implStateDirRoot: '/tmp' },
      claimDeps: makeClaimDeps(),
      // No implRegistry — gate must no-op so raw claim path works.
    });
    const input = makeInput();
    engine.db.insertDiscovered(input);

    const persisted = engine.db.getByRequestId(input.requestId)!;
    await engine.callClaim(persisted);
    const after = engine.db.getByRequestId(input.requestId)!;
    expect(after.state).toBe(IntentState.CLAIMED);
  });
});
