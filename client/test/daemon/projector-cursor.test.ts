import { describe, expect, it } from 'vitest';
import {
  createMarketplaceProjectionState,
  type MarketplaceProjectionState,
} from '@jinn-network/marketplace-projector';
import { Store } from '../../src/store/store.js';
import {
  ProjectorCursorStore,
  deserializeProjectionState,
  serializeProjectionState,
} from '../../src/daemon/projector-cursor.js';

const CURSOR = {
  liveBlockNumber: 120n,
  liveBlockHash: `0x${'1'.repeat(64)}` as const,
  finalizedBlockNumber: 100n,
  finalizedBlockHash: `0x${'2'.repeat(64)}` as const,
  sequence: '0000000000000005',
  entryDigest: `sha256:${'a'.repeat(64)}` as const,
  headJson: '{"sequence":"0000000000000005"}',
  stateJson: '{"tasks":{}}',
};

describe('projector cursor store', () => {
  it('round-trips a cursor', () => {
    const cursors = new ProjectorCursorStore(new Store(':memory:'), 'marketplace');
    expect(cursors.read()).toBeUndefined();
    cursors.write(CURSOR);
    expect(cursors.read()).toEqual(CURSOR);
  });

  it('rolls back to the durable finalized checkpoint on a reorg', () => {
    const cursors = new ProjectorCursorStore(new Store(':memory:'), 'marketplace');
    cursors.write(CURSOR);
    const rolled = cursors.rollbackToFinalized()!;
    expect(rolled.liveBlockNumber).toBe(100n);
    expect(rolled.liveBlockHash).toBe(`0x${'2'.repeat(64)}`);
    // The announcement chain is append-only: sequence and entry digest never rewind.
    expect(rolled.sequence).toBe('0000000000000005');
    expect(rolled.entryDigest).toBe(`sha256:${'a'.repeat(64)}`);
  });

  it('keeps two projectors on distinct keys independent', () => {
    const store = new Store(':memory:');
    new ProjectorCursorStore(store, 'marketplace').write(CURSOR);
    expect(new ProjectorCursorStore(store, 'other').read()).toBeUndefined();
  });
});

// `MarketplaceProjectionState` carries `bigint` on every claim/delivery-derived record —
// `requestIdBindings[].taskId` / `.nonce` / `.deliveryRate`, `attemptEngagements[].taskId`,
// `evaluationEngagements`, `pendingMechDeliveries`. Plain `JSON.stringify` throws
// `TypeError: Do not know how to serialize a BigInt` on all of them, so the projector would run
// fine over `TaskCreated` traffic (no bigints in a task projection) and then crash the first
// time this operator — or anyone — claimed an attempt. The state codec is what keeps the cursor
// and the projection state advancing in one durable step.
describe('projection state codec', () => {
  function stateWithBigints(): MarketplaceProjectionState {
    const state = createMarketplaceProjectionState();
    state.requestIdBindings['84532:0xabc'] = {
      taskId: 42n,
      attemptIndex: 0,
      role: 'task-attempt',
      deliveryRate: 1_000_000_000_000n,
      nonce: 7n,
    } as MarketplaceProjectionState['requestIdBindings'][string];
    return state;
  }

  it('round-trips a state carrying bigints', () => {
    const state = stateWithBigints();
    const restored = deserializeProjectionState(serializeProjectionState(state));
    expect(restored).toEqual(state);
    const binding = restored.requestIdBindings['84532:0xabc']!;
    expect(binding.taskId).toBe(42n);
    expect(typeof binding.taskId).toBe('bigint');
    expect(binding.deliveryRate).toBe(1_000_000_000_000n);
    expect(binding.nonce).toBe(7n);
  });

  it('leaves a decimal string that merely looks numeric as a string', () => {
    const state = createMarketplaceProjectionState();
    state.sequenceBySourceSubject['source:subject'] = '0000000000000005';
    const restored = deserializeProjectionState(serializeProjectionState(state));
    expect(restored.sequenceBySourceSubject['source:subject']).toBe('0000000000000005');
    expect(typeof restored.sequenceBySourceSubject['source:subject']).toBe('string');
  });

  it('round-trips an empty state unchanged', () => {
    const state = createMarketplaceProjectionState();
    expect(deserializeProjectionState(serializeProjectionState(state))).toEqual(state);
  });
});
