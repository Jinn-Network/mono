/**
 * Signed reorg corrections and the projector log-source tee (one-swap M3, umbrella #2461).
 *
 * The reconciler was previously unreachable from any test — it lived inline in
 * `native-solver-production.ts`, which nothing constructs. Extracting it for the fleet path is
 * what makes it testable, so it is tested here: the withdraw-on-orphan and re-announce-on-return
 * legs, their idempotence, and the tee that feeds it without a second chain cursor.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Store } from '../../src/store/store.js';
import { NativeMarketplaceEventRepository } from '../../src/daemon/native-canonical-observations.js';
import {
  NATIVE_MARKETPLACE_TEE_FAILURE_KIND,
  buildNativeSolutionCorrections,
  teeNativeMarketplaceEvents,
} from '../../src/daemon/native-solution-corrections.js';

const CHAIN = {
  chainId: 84532,
  generation: 'today' as const,
  taskCoordinator: '0x8a34793e10595c89B7e41Cc7Ff0F76850F44AD98' as const,
  jinnRouter: '0x1111111111111111111111111111111111111111' as const,
  mechMarketplace: '0x2222222222222222222222222222222222222222' as const,
  activityChecker: '0x3333333333333333333333333333333333333333' as const,
};
const ENGAGEMENT = `sha256:${'1'.repeat(64)}` as const;
const DELIVERY_DIGEST = `sha256:${'2'.repeat(64)}` as const;
const BLOCK_HASH = `0x${'a'.repeat(64)}` as const;
const TX_HASH = `0x${'b'.repeat(64)}` as const;

let root: string;
let store: Store;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'jinn-native-corrections-'));
  store = new Store(join(root, 'jinn.db'));
});

afterEach(() => {
  store.close();
  rmSync(root, { recursive: true, force: true });
});

/** A published delivery the reconciler can find: engagement + artifact + published outbox row. */
function seedPublishedDelivery(): void {
  store.db.prepare(
    `INSERT INTO native_engagements
       (engagement_id, chain_id, coordinator, task_id, role, operator_agent, task_digest,
        submission_uri, submission_digest, state, attempt_index, policy_json, capability_json,
        created_at, updated_at)
     VALUES (?, '84532', ?, '7', 'solver', 'urn:jinn:operator:a', ?, ?, ?, 'delivered', 0,
             '{}', '{}', ?, ?)`,
  ).run(
    ENGAGEMENT, CHAIN.taskCoordinator, `sha256:${'3'.repeat(64)}`,
    'urn:uuid:33333333-3333-4333-8333-333333333333', `sha256:${'4'.repeat(64)}`,
    '2026-08-06T00:00:00.000Z', '2026-08-06T00:00:00.000Z',
  );
  store.db.prepare(
    `INSERT INTO native_solution_artifacts
       (engagement_id, role, family, media_type, name, record_digest, exact_bytes, created_at)
     VALUES (?, 'delivery', 'delivery', 'application/json', 'delivery', ?, ?, ?)`,
  ).run(ENGAGEMENT, DELIVERY_DIGEST, Buffer.from('{"ok":true}'), '2026-08-06T00:00:00.000Z');
  store.db.prepare(
    `INSERT INTO native_publication_outbox
       (publication_key, engagement_id, source_id, role, record_digest, availability, status,
        detail_json, created_at, updated_at)
     VALUES (?, ?, 'urn:jinn:operator:a/solver-records', 'delivery', ?, 'available', 'published',
             '{}', ?, ?)`,
  ).run(
    `sha256:${'5'.repeat(64)}`, ENGAGEMENT, DELIVERY_DIGEST,
    '2026-08-06T00:00:00.000Z', '2026-08-06T00:00:00.000Z',
  );
}

function settlementEvent(blockHash = BLOCK_HASH) {
  return {
    event: 'SolutionDeliveryClaimed' as const,
    facts: { taskId: 7n, attemptIndex: 0 },
    derivation: {
      chainId: 84532,
      contract: CHAIN.jinnRouter,
      blockHash,
      blockNumber: 100n,
      txHash: TX_HASH,
      logIndex: 0,
      finalityTier: 'observed-safe',
    },
  };
}

function publisher() {
  return {
    publish: vi.fn(async () => ({ sequence: '2', entryDigest: `sha256:${'7'.repeat(64)}` as const })),
    withdraw: vi.fn(async () => ({ sequence: '1', entryDigest: `sha256:${'6'.repeat(64)}` as const })),
  };
}

describe('buildNativeSolutionCorrections', () => {
  it('signs a withdrawal for a published delivery whose settlement block was orphaned', async () => {
    seedPublishedDelivery();
    const events = new NativeMarketplaceEventRepository(store);
    events.apply({ events: [settlementEvent()] as never });
    events.apply({ events: [], orphanedBlockHashes: [BLOCK_HASH] });
    const sink = publisher();

    await buildNativeSolutionCorrections({ store, publisher: sink, marketplaceEvents: events })
      .reconcile();

    expect(sink.withdraw).toHaveBeenCalledOnce();
    expect(sink.withdraw.mock.calls[0]![0]).toMatchObject({
      recordDigest: DELIVERY_DIGEST,
      reason: 'reorged',
    });
    expect(store.db.prepare(
      `SELECT action FROM native_solution_discovery_corrections`,
    ).all()).toEqual([{ action: 'withdrawn' }]);
  });

  it('is idempotent: a second pass over the same orphan withdraws nothing further', async () => {
    seedPublishedDelivery();
    const events = new NativeMarketplaceEventRepository(store);
    events.apply({ events: [settlementEvent()] as never });
    events.apply({ events: [], orphanedBlockHashes: [BLOCK_HASH] });
    const sink = publisher();
    const corrections = buildNativeSolutionCorrections({ store, publisher: sink, marketplaceEvents: events });

    await corrections.reconcile();
    await corrections.reconcile();

    expect(sink.withdraw).toHaveBeenCalledOnce();
  });

  it('re-announces availability only after a withdrawal, when the delivery returns canonical', async () => {
    seedPublishedDelivery();
    const events = new NativeMarketplaceEventRepository(store);
    events.apply({ events: [settlementEvent()] as never });
    events.apply({ events: [], orphanedBlockHashes: [BLOCK_HASH] });
    const sink = publisher();
    const corrections = buildNativeSolutionCorrections({ store, publisher: sink, marketplaceEvents: events });
    await corrections.reconcile();

    // Same delivery, new canonical block.
    const returned = `0x${'f'.repeat(64)}` as const;
    events.apply({ events: [settlementEvent(returned)] as never });
    await corrections.reconcile();

    expect(sink.publish).toHaveBeenCalledOnce();
    expect(sink.publish.mock.calls[0]![0]).toMatchObject({
      publication: { availability: 'available', detail: { canonicalBlockHash: returned } },
    });
    expect(store.db.prepare(
      `SELECT action FROM native_solution_discovery_corrections ORDER BY rowid`,
    ).all()).toEqual([{ action: 'withdrawn' }, { action: 'available' }]);
  });

  it('never announces for a delivery that was never withdrawn', async () => {
    seedPublishedDelivery();
    const events = new NativeMarketplaceEventRepository(store);
    events.apply({ events: [settlementEvent()] as never });
    const sink = publisher();

    await buildNativeSolutionCorrections({ store, publisher: sink, marketplaceEvents: events })
      .reconcile();

    expect(sink.publish).not.toHaveBeenCalled();
    expect(sink.withdraw).not.toHaveBeenCalled();
  });
});

describe('teeNativeMarketplaceEvents', () => {
  it('applies the projector\'s own batch to the read model without polling a second time', async () => {
    const events = new NativeMarketplaceEventRepository(store);
    const poll = vi.fn(async () => ({
      logs: [],
      cursor: { blockNumber: 10n, blockHash: BLOCK_HASH },
      finalizedCheckpoint: { blockNumber: 5n, blockHash: BLOCK_HASH },
      reorg: { orphanedBlockHashes: [BLOCK_HASH] },
    }));
    const source = {
      poll,
      cursor: () => undefined,
      finalizedCheckpoint: () => undefined,
      logsInRange: async () => [],
      orphanedBlockHashes: () => new Set<string>(),
      close: () => undefined,
    };
    const apply = vi.spyOn(events, 'apply');

    const teed = teeNativeMarketplaceEvents({
      source: source as never,
      repository: events,
      chain: CHAIN,
      isAuthorizedMechOrigin: () => true,
    });
    const batch = await teed.poll();

    // ONE poll of the underlying single-consumer cursor, and the caller still receives the batch
    // unchanged -- the projector loop's reorg decision is untouched.
    expect(poll).toHaveBeenCalledOnce();
    expect(batch.cursor).toEqual({ blockNumber: 10n, blockHash: BLOCK_HASH });
    expect(apply).toHaveBeenCalledWith({ events: [], orphanedBlockHashes: [BLOCK_HASH] });
  });

  it('never fails the projector\'s delivery when the read model rejects a batch', async () => {
    // `poll()` advances the durable cursor INSIDE itself, before returning. If this decorator
    // rethrew, the projector would never see a batch whose cursor is already committed and those
    // events would be permanently invisible to the signed-announcement chain. `apply` can throw
    // for real -- its `changed bytes` guard fires when a venue-state reset replays blocks re-tiered
    // observed-safe -> finalized, and SQLITE_BUSY past the timeout throws too.
    const repository = new NativeMarketplaceEventRepository(store);
    vi.spyOn(repository, 'apply').mockImplementation(() => {
      throw new Error('native marketplace event ...:0 changed bytes');
    });
    const batchValue = {
      logs: [],
      cursor: { blockNumber: 42n, blockHash: BLOCK_HASH },
      finalizedCheckpoint: { blockNumber: 40n, blockHash: BLOCK_HASH },
    };
    const warn = vi.fn();
    const teed = teeNativeMarketplaceEvents({
      source: {
        poll: async () => batchValue,
        cursor: () => undefined,
        finalizedCheckpoint: () => undefined,
        logsInRange: async () => [],
        orphanedBlockHashes: () => new Set<string>(),
        close: () => undefined,
      } as never,
      repository,
      chain: CHAIN,
      isAuthorizedMechOrigin: () => true,
      logger: { warn },
    });

    // The projector still receives its batch, unchanged.
    await expect(teed.poll()).resolves.toBe(batchValue);

    // ... and the read-model gap is LOUD, not swallowed: one structured line, named event kind.
    expect(warn).toHaveBeenCalledOnce();
    const logged = JSON.parse(warn.mock.calls[0]![0] as string) as Record<string, unknown>;
    expect(logged).toMatchObject({
      level: 'warn',
      kind: NATIVE_MARKETPLACE_TEE_FAILURE_KIND,
      cursor: '42',
      error: expect.stringContaining('changed bytes'),
    });
  });

  it('delegates every non-poll capability to the underlying source', () => {
    const close = vi.fn();
    const source = {
      poll: vi.fn(),
      cursor: () => ({ blockNumber: 3n, blockHash: BLOCK_HASH }),
      finalizedCheckpoint: () => ({ blockNumber: 2n, blockHash: BLOCK_HASH }),
      logsInRange: vi.fn(async () => []),
      orphanedBlockHashes: () => new Set(['0xdead']),
      close,
    };
    const teed = teeNativeMarketplaceEvents({
      source: source as never,
      repository: new NativeMarketplaceEventRepository(store),
      chain: CHAIN,
      isAuthorizedMechOrigin: () => true,
    });

    expect(teed.cursor()).toEqual({ blockNumber: 3n, blockHash: BLOCK_HASH });
    expect(teed.finalizedCheckpoint()).toEqual({ blockNumber: 2n, blockHash: BLOCK_HASH });
    expect([...teed.orphanedBlockHashes()]).toEqual(['0xdead']);
    teed.close();
    expect(close).toHaveBeenCalledOnce();
  });
});
