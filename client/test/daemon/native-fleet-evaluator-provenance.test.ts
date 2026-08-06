/**
 * Provenance separation on the fleet path (one-swap M4a, umbrella #2461; M3 review N6).
 *
 * On the ONE fleet daemon the WorkLoop's requester discovery consumer (M3) and the evaluator's
 * opportunity-reader consumers both use `createNativeDiscoveryConsumer` over `native_discovery_*`.
 * `createNativeDiscoveryConsumer` stamps `discovery` on every card it queues regardless of decode,
 * so that stamp is NOT proof of a canonical-decode admission — the only thing that separates one
 * consumer's cards from another's is the source-identity `keys` filter in `takePending()`, and, on
 * the fleet path, the DISTINCT `discoveryStore` the evaluator opportunity reader keys against.
 *
 * These tests pin both mechanisms so a future change that lets solver cards and evaluator
 * opportunities cross-feed on the shared Store goes red.
 */
import { describe, expect, it } from 'vitest';
import { createHttpTransport } from '@jinn-network/record-discovery-transport-http';
import { Store } from '../../src/store/store.js';
import {
  createNativeDiscoveryConsumer,
  type NativeDiscoverySource,
} from '../../src/daemon/native-discovery.js';

const transport = createHttpTransport('');

function fakeSource(agent: string, name: string): NativeDiscoverySource {
  return {
    endpoint: { agent, name, servingRoot: `https://${name}.example`, archiveRootUrl: `https://${name}.example/archive` },
    // Never reached by `takePending()` — this suite exercises the durable queue directly, not `sync()`.
    verify: async () => ({ status: 'ok' }),
    verifyHead: async () => ({ status: 'ok' }),
  };
}

/** Insert a durable queued card exactly as `createNativeDiscoveryConsumer.sync()` would. */
function queueCard(store: Store, source: { agent: string; name: string }, card: unknown, id: string): void {
  store.db.prepare(
    `INSERT INTO native_discovery_cards
       (source_agent, source_name, sequence, entry_digest, announcement_id, card_json, accepted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    source.agent,
    source.name,
    '1',
    `sha256:${'a'.repeat(64)}`,
    id,
    JSON.stringify(card),
    new Date().toISOString(),
  );
}

describe('N6: source-identity keys filter separates consumers on ONE shared Store', () => {
  it('a card queued under the requester source is invisible to a solver-keyed consumer, and vice versa', () => {
    const shared = new Store(':memory:');
    try {
      // The WorkLoop's requester consumer and the evaluator opportunity SOURCE (solver-keyed) over
      // the SAME shared Store, keyed to DISTINCT source identities.
      const workRequester = createNativeDiscoveryConsumer({
        store: shared,
        sources: [fakeSource('urn:jinn:requester', 'requester-records')],
        transport,
        decode: async () => undefined,
      });
      const evaluatorSolver = createNativeDiscoveryConsumer({
        store: shared,
        sources: [fakeSource('urn:jinn:solver', 'solver-records')],
        transport,
        decode: async () => undefined,
      });

      queueCard(shared, { agent: 'urn:jinn:requester', name: 'requester-records' }, { shape: 'submission-card' }, 'ann-req');
      queueCard(shared, { agent: 'urn:jinn:solver', name: 'solver-records' }, { shape: 'delivery-card' }, 'ann-sol');

      // No cross-feed: each consumer sees ONLY its own source's card.
      expect(workRequester.takePending().map((c) => (c.card as { shape: string }).shape)).toEqual(['submission-card']);
      expect(evaluatorSolver.takePending().map((c) => (c.card as { shape: string }).shape)).toEqual(['delivery-card']);
    } finally {
      shared.close();
    }
  });

  it('same-source consumers on ONE Store DO share the row — why the evaluator needs a distinct discoveryStore', () => {
    const shared = new Store(':memory:');
    try {
      // If the evaluator ran its requester consumer over the SAME shared Store as the WorkLoop's
      // requester consumer (same source identity), they would share the queued rows — and the
      // decode-that-wrote-first would win the `card_json`. This is exactly the collision the fleet
      // path avoids by keying the evaluator's discovery to a distinct store.
      const workRequester = createNativeDiscoveryConsumer({
        store: shared,
        sources: [fakeSource('urn:jinn:requester', 'requester-records')],
        transport,
        decode: async () => undefined,
      });
      const evaluatorRequesterShared = createNativeDiscoveryConsumer({
        store: shared,
        sources: [fakeSource('urn:jinn:requester', 'requester-records')],
        transport,
        decode: async () => undefined,
      });

      // The WorkLoop's decode wrote a submission-shaped card under the requester source.
      queueCard(shared, { agent: 'urn:jinn:requester', name: 'requester-records' }, { shape: 'submission-card' }, 'ann-req');

      // The evaluator's same-source consumer reads the WorkLoop's card (wrong shape for it): CROSS-FEED.
      expect(evaluatorRequesterShared.takePending().map((c) => (c.card as { shape: string }).shape)).toEqual(['submission-card']);
      // And once the WorkLoop acknowledges it, the evaluator would never see it again — starvation.
      const [queued] = workRequester.takePending();
      workRequester.acknowledge(queued!);
      expect(evaluatorRequesterShared.takePending()).toEqual([]);
    } finally {
      shared.close();
    }
  });

  it('a distinct discoveryStore fully isolates the evaluator consumer from the shared Store', () => {
    const shared = new Store(':memory:');
    const discoveryStore = new Store(':memory:');
    try {
      // The fleet evaluator opportunity reader keys its consumers to a DISTINCT store. A requester
      // card the WorkLoop queued in the SHARED store's `native_discovery_cards` is unreachable from
      // the evaluator's consumers, and vice versa — no cross-feed and no shared checkpoint.
      const evaluatorRequesterDistinct = createNativeDiscoveryConsumer({
        store: discoveryStore,
        sources: [fakeSource('urn:jinn:requester', 'requester-records')],
        transport,
        decode: async () => undefined,
      });
      queueCard(shared, { agent: 'urn:jinn:requester', name: 'requester-records' }, { shape: 'submission-card' }, 'ann-req');

      expect(evaluatorRequesterDistinct.takePending()).toEqual([]);

      // The evaluator's own store carries its own cards, invisible to any shared-store consumer.
      const sharedRequester = createNativeDiscoveryConsumer({
        store: shared,
        sources: [fakeSource('urn:jinn:requester', 'requester-records')],
        transport,
        decode: async () => undefined,
      });
      queueCard(discoveryStore, { agent: 'urn:jinn:requester', name: 'requester-records' }, { shape: 'association-card' }, 'ann-assoc');
      expect(sharedRequester.takePending().map((c) => (c.card as { shape: string }).shape)).toEqual(['submission-card']);
      expect(evaluatorRequesterDistinct.takePending().map((c) => (c.card as { shape: string }).shape)).toEqual(['association-card']);
    } finally {
      shared.close();
      discoveryStore.close();
    }
  });
});
