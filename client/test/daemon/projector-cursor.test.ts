import { describe, expect, it } from 'vitest';
import {
  createMarketplaceProjectionState,
  type MarketplaceProjectionState,
  type MarketplaceProtocolObservation,
} from '@jinn-network/marketplace-projector';
import { Store } from '../../src/store/store.js';
import {
  ProjectorCursorStore,
  deserializeObservation,
  deserializeProjectionState,
  serializeObservation,
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

// A real `MarketplaceProtocolObservation`, shaped exactly as `reduceMarketplaceProjection`'s
// `emit()` constructs one (`packages/marketplace/projector/src/observe.ts`). Every field is a
// string/number already — `event.facts.taskId` etc. are `.toString()`'d before they reach
// `data`/`annotations`, and `derivation` (`DerivationAnnotation`) types `blockNumber` as `number`,
// not `bigint`. This fixture is deliberately bigint-free to match production shape; see finding
// below for a fixture that is NOT production-shaped, used only to exercise the codec's coverage.
function realObservation(overrides: Partial<MarketplaceProtocolObservation> = {}): MarketplaceProtocolObservation {
  return {
    specversion: '1.0',
    id: `0x${'2'.repeat(64)}:0:network.jinn.task-execution.submission-accepted.v1`,
    source: 'urn:jinn:marketplace-projector:eip155:84532:0xrouter',
    subject: 'urn:uuid:11111111-1111-4111-8111-111111111111',
    time: '2026-07-31T00:00:00Z',
    datacontenttype: 'application/json',
    sequence: '0000000000000001',
    taskdigest: `sha256:${'a'.repeat(64)}`,
    derivation: {
      chainId: 84532,
      contract: '0xrouter' as `0x${string}`,
      event: 'TaskCreated',
      blockNumber: 120,
      blockHash: `0x${'1'.repeat(64)}`,
      txHash: `0x${'2'.repeat(64)}`,
      logIndex: 0,
      finalityTier: 'safe',
      contractGeneration: 'today',
    },
    type: 'network.jinn.task-execution.submission-accepted.v1',
    data: { submission: 'urn:uuid:11111111-1111-4111-8111-111111111111', task: `sha256:${'a'.repeat(64)}` },
    ...overrides,
  } as MarketplaceProtocolObservation;
}

describe('observation codec', () => {
  it('round-trips a production-shaped observation through plain JSON.stringify, unchanged — observations carry no bigints', () => {
    // This is the "verify, do not assume" check finding E20's close-out plan §C5 calls for: unlike
    // `MarketplaceProjectionState` (bigint on every claim/delivery-derived record), the frozen TEP
    // `ProtocolObservation` schema (`packages/task-execution/protocol/src/schemas/observation.ts`)
    // types every field as string/number/enum — no `z.bigint()` anywhere — and every `emit()` call
    // site in `reduceMarketplaceProjection` already stringifies bigints (e.g.
    // `event.facts.taskId.toString()`) before they reach `data`. `finality.test.ts:287` already
    // relies on this: `JSON.stringify(observation)` directly, no custom replacer. Plain
    // `JSON.stringify`/`JSON.parse` must therefore round-trip a real observation losslessly.
    const observation = realObservation();
    const plainRoundTrip = JSON.parse(JSON.stringify(observation)) as MarketplaceProtocolObservation;
    expect(plainRoundTrip).toEqual(observation);
  });

  it('round-trips the same production-shaped observation through the shared bigint-aware codec, unchanged', () => {
    const observation = realObservation();
    const restored = deserializeObservation(serializeObservation(observation));
    expect(restored).toEqual(observation);
  });

  it('round-trips a bigint nested in an open data/annotations field losslessly (defensive: the codec is reused because `data`/`annotations` are typed `Record<string, unknown>`, not statically bigint-free)', () => {
    const observation = realObservation({
      data: { submission: 'urn:uuid:11111111-1111-4111-8111-111111111111', task: `sha256:${'a'.repeat(64)}`, exampleFutureBigint: 42n as unknown },
    } as Partial<MarketplaceProtocolObservation>);
    // A raw bigint in `data` would throw under plain JSON.stringify -- the whole reason the shared
    // codec exists.
    expect(() => JSON.stringify(observation)).toThrow(/BigInt/);
    const restored = deserializeObservation(serializeObservation(observation));
    expect((restored.data as { exampleFutureBigint: unknown }).exampleFutureBigint).toBe(42n);
    expect(typeof (restored.data as { exampleFutureBigint: unknown }).exampleFutureBigint).toBe('bigint');
  });
});

describe('projector observations table', () => {
  function observation(sequence: string, id: string): MarketplaceProtocolObservation {
    return realObservation({ sequence, id });
  }

  it('persists observations appended atomically alongside a cursor write', () => {
    const cursors = new ProjectorCursorStore(new Store(':memory:'), 'marketplace');
    const obs1 = observation('0000000000000001', 'obs-1');
    cursors.write(CURSOR, [obs1]);
    expect(cursors.readObservations()).toEqual([obs1]);
  });

  it('is append-only: successive write() calls accumulate observations rather than replace them', () => {
    const cursors = new ProjectorCursorStore(new Store(':memory:'), 'marketplace');
    const obs1 = observation('0000000000000001', 'obs-1');
    const obs2 = observation('0000000000000002', 'obs-2');
    cursors.write(CURSOR, [obs1]);
    cursors.write({ ...CURSOR, sequence: '0000000000000002' }, [obs2]);
    expect(cursors.readObservations()).toEqual([obs1, obs2]);
  });

  it('returns observations in projection (insertion) order', () => {
    const cursors = new ProjectorCursorStore(new Store(':memory:'), 'marketplace');
    const obs = ['a', 'b', 'c'].map((suffix, index) =>
      observation(String(index + 1).padStart(16, '0'), `obs-${suffix}`),
    );
    cursors.write(CURSOR, obs);
    expect(cursors.readObservations().map((entry) => entry.id)).toEqual(['obs-a', 'obs-b', 'obs-c']);
  });

  it('a write() with no observations appends nothing (cursor-only ticks stay silent)', () => {
    const cursors = new ProjectorCursorStore(new Store(':memory:'), 'marketplace');
    cursors.write(CURSOR, [observation('0000000000000001', 'obs-1')]);
    cursors.write({ ...CURSOR, sequence: '0000000000000002' });
    expect(cursors.readObservations()).toHaveLength(1);
  });

  it('scopes observations by cursor key, independent of other projector streams', () => {
    const store = new Store(':memory:');
    const marketplace = new ProjectorCursorStore(store, 'marketplace');
    const other = new ProjectorCursorStore(store, 'other');
    marketplace.write(CURSOR, [observation('0000000000000001', 'obs-marketplace')]);
    expect(other.readObservations()).toEqual([]);
  });

  it('the three-way write (cursor + state + observations) is atomic: a failure mid-transaction commits none of it', () => {
    const store = new Store(':memory:');
    const cursors = new ProjectorCursorStore(store, 'marketplace');
    const originalPrepare = store.db.prepare.bind(store.db);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (store.db as any).prepare = (sql: string) => {
      if (sql.includes('INSERT INTO projector_observations')) {
        throw new Error('simulated failure writing an observation');
      }
      return originalPrepare(sql);
    };
    expect(() => cursors.write(CURSOR, [observation('0000000000000001', 'obs-1')])).toThrow(
      'simulated failure writing an observation',
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (store.db as any).prepare = originalPrepare;
    // The cursor row must NOT have been committed either -- same transaction, all-or-nothing.
    expect(cursors.read()).toBeUndefined();
    expect(cursors.readObservations()).toEqual([]);
  });

  it('rollbackToFinalized() never deletes already-persisted observations (append-only correction model)', () => {
    const cursors = new ProjectorCursorStore(new Store(':memory:'), 'marketplace');
    const obs1 = observation('0000000000000001', 'obs-1');
    cursors.write(CURSOR, [obs1]);
    cursors.rollbackToFinalized();
    // Reorg corrections are signed retractions appended to the stream, never a delete of what was
    // already emitted (module comment, `MarketplaceProtocolObservation.correction`).
    expect(cursors.readObservations()).toEqual([obs1]);
  });
});
