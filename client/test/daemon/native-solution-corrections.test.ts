/**
 * Signed reorg corrections and the projector log-source tee (one-swap M3, umbrella #2461).
 *
 * The reconciler was previously unreachable from any test — it lived inline in
 * `native-solver-production.ts`, which nothing constructs. Extracting it for the fleet path is
 * what makes it testable, so it is tested here: the withdraw-on-orphan and re-announce-on-return
 * legs, their idempotence, and the tee that feeds it without a second chain cursor.
 */
import { createHash, generateKeyPairSync, sign as cryptoSign, verify as cryptoVerify } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeAbiParameters, encodeEventTopics } from 'viem';
import { JINN_ROUTER_V3_ABI } from '@jinn-network/marketplace-binding';
import { archivePagePath } from '@jinn-network/record-discovery-protocol';
import { Store } from '../../src/store/store.js';
import { NativeMarketplaceEventRepository } from '../../src/daemon/native-canonical-observations.js';
import {
  NATIVE_MARKETPLACE_TEE_FAILURE_KIND,
  buildNativeSolutionCorrections,
  teeNativeMarketplaceEvents,
} from '../../src/daemon/native-solution-corrections.js';
import { openNativeSolutionPublisher } from '../../src/daemon/native-solution-publisher.js';

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
function seedPublishedDelivery(overrides: {
  readonly engagement?: `sha256:${string}`;
  readonly taskId?: string;
  readonly deliveryDigest?: `sha256:${string}`;
  readonly deliveryBytes?: Buffer;
  readonly publicationKey?: `sha256:${string}`;
} = {}): void {
  const engagement = overrides.engagement ?? ENGAGEMENT;
  const taskId = overrides.taskId ?? '7';
  const deliveryDigest = overrides.deliveryDigest ?? DELIVERY_DIGEST;
  const deliveryBytes = overrides.deliveryBytes ?? Buffer.from('{"ok":true}');
  const publicationKey = overrides.publicationKey ?? (`sha256:${'5'.repeat(64)}` as const);
  store.db.prepare(
    `INSERT INTO native_engagements
       (engagement_id, chain_id, coordinator, task_id, role, operator_agent, task_digest,
        submission_uri, submission_digest, state, attempt_index, policy_json, capability_json,
        created_at, updated_at)
     VALUES (?, '84532', ?, ?, 'solver', 'urn:jinn:operator:a', ?, ?, ?, 'delivered', 0,
             '{}', '{}', ?, ?)`,
  ).run(
    engagement, CHAIN.taskCoordinator, taskId, `sha256:${'3'.repeat(64)}`,
    'urn:uuid:33333333-3333-4333-8333-333333333333', `sha256:${'4'.repeat(64)}`,
    '2026-08-06T00:00:00.000Z', '2026-08-06T00:00:00.000Z',
  );
  store.db.prepare(
    `INSERT INTO native_solution_artifacts
       (engagement_id, role, family, media_type, name, record_digest, exact_bytes, created_at)
     VALUES (?, 'delivery', 'delivery', 'application/json', 'delivery', ?, ?, ?)`,
  ).run(engagement, deliveryDigest, deliveryBytes, '2026-08-06T00:00:00.000Z');
  store.db.prepare(
    `INSERT INTO native_publication_outbox
       (publication_key, engagement_id, source_id, role, record_digest, availability, status,
        detail_json, created_at, updated_at)
     VALUES (?, ?, 'urn:jinn:operator:a/solver-records', 'delivery', ?, 'available', 'published',
             '{}', ?, ?)`,
  ).run(
    publicationKey, engagement, deliveryDigest,
    '2026-08-06T00:00:00.000Z', '2026-08-06T00:00:00.000Z',
  );
}

function settlementEvent(blockHash = BLOCK_HASH, overrides: {
  readonly taskId?: bigint;
  readonly logIndex?: number;
} = {}) {
  return {
    event: 'SolutionDeliveryClaimed' as const,
    facts: { taskId: overrides.taskId ?? 7n, attemptIndex: 0 },
    derivation: {
      chainId: 84532,
      contract: CHAIN.jinnRouter,
      blockHash,
      blockNumber: 100n,
      txHash: TX_HASH,
      logIndex: overrides.logIndex ?? 0,
      finalityTier: 'observed-safe',
    },
  };
}

/** A real router log the tee's `decodeMarketplaceLogs` actually decodes, at a chosen tier. */
function solutionClaimLog(
  blockHash: `0x${string}`,
  txHash: `0x${string}`,
  blockNumber: bigint,
  finalityTier: 'safe' | 'finalized',
) {
  return {
    chainId: CHAIN.chainId,
    address: CHAIN.jinnRouter,
    blockNumber,
    blockHash,
    transactionHash: txHash,
    logIndex: 0,
    finalityTier,
    topics: encodeEventTopics({
      abi: JINN_ROUTER_V3_ABI,
      eventName: 'SolutionDeliveryClaimed',
      args: {
        operator: `0x${'1'.repeat(40)}`,
        requestId: `0x${'2'.repeat(64)}`,
        taskId: 7n,
      },
    }),
    data: encodeAbiParameters([{ name: 'attemptIndex', type: 'uint32' }], [0]),
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

// TWO published deliveries settled in ONE block that is then orphaned. A reorg stamps every event
// of the orphaned block with ONE `orphaned_at` (`NativeMarketplaceEventRepository.apply` computes a
// single `now` per batch), and each withdrawal is announced into ONE append-only signed source
// whose head must strictly advance per announcement
// (packages/discovery/serve/src/source-writer.ts). Regression for the corrections-side sibling of
// solver defect #24 (#2560) and evaluator defect #46 (#2634): withdrawing both deliveries at the
// shared `orphaned_at` instant commits the first and wedges the second on
// `SourceWriterIntegrityError` forever, because the retry re-reads the same fixed base.
describe('buildNativeSolutionCorrections on the real signed source', () => {
  const ENGAGEMENT_B = `sha256:${'9'.repeat(64)}` as const;
  const PUBLICATION_KEY_A = `sha256:${'5'.repeat(64)}` as const;
  const PUBLICATION_KEY_B = `sha256:${'8'.repeat(64)}` as const;
  const closers: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await Promise.all(closers.splice(0).map((close) => close().catch(() => undefined)));
  });

  function digestOf(bytes: Uint8Array): `sha256:${string}` {
    return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  }

  async function realPublisher() {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const opened = await openNativeSolutionPublisher({
      rootDir: mkdtempSync(join(root, 'source-')),
      publicBaseUrl: 'https://operator.example/native',
      source: { agent: 'urn:jinn:operator:a', name: 'solver-records' },
      signer: {
        keyId: 'did:key:z6MkCorrectionsRegression',
        sign: (payload: Uint8Array) => new Uint8Array(cryptoSign(null, payload, privateKey)),
        verify: (payload: Uint8Array, signature: Uint8Array) =>
          cryptoVerify(null, payload, publicKey, signature),
      },
      settlementDeclarationKey: 'did:key:z6MkSolverSettlement',
    });
    closers.push(() => opened.close());
    return opened;
  }

  async function announcementTimestamps(
    opened: Awaited<ReturnType<typeof realPublisher>>,
    count: number,
  ): Promise<string[]> {
    const timestamps: string[] = [];
    for (let sequence = 1; sequence <= count; sequence += 1) {
      const page = String(sequence).padStart(16, '0');
      const response = await opened.handler(new Request(
        `https://operator.example/native${archivePagePath('solver-records', page)}`,
      ));
      expect(response.status).toBe(200);
      const parsed = JSON.parse(await response.text()) as {
        entries: Array<{ entry: { timestamp: string } }>;
      };
      timestamps.push(parsed.entries[0]!.entry.timestamp);
    }
    return timestamps;
  }

  /** Seed one delivery end-to-end: DB rows plus its available announcement on the signed source. */
  async function seedAnnouncedDelivery(
    opened: Awaited<ReturnType<typeof realPublisher>>,
    input: {
      readonly engagement: `sha256:${string}`;
      readonly taskId: string;
      readonly bytes: Uint8Array;
      readonly publicationKey: `sha256:${string}`;
      readonly createdAt: string;
    },
  ): Promise<void> {
    const digest = digestOf(input.bytes);
    seedPublishedDelivery({
      engagement: input.engagement,
      taskId: input.taskId,
      deliveryDigest: digest,
      deliveryBytes: Buffer.from(input.bytes),
      publicationKey: input.publicationKey,
    });
    await opened.publish({
      publication: {
        publicationKey: input.publicationKey,
        engagementId: input.engagement,
        sourceId: opened.sourceId,
        role: 'delivery',
        recordDigest: digest,
        availability: 'available',
        status: 'intent',
        detail: {},
        createdAt: input.createdAt,
        updatedAt: input.createdAt,
      },
      artifact: {
        engagementId: input.engagement,
        role: 'delivery',
        family: 'delivery',
        mediaType: 'application/json',
        name: 'delivery',
        digest,
        bytes: input.bytes,
        createdAt: input.createdAt,
      },
      bytes: input.bytes,
    });
  }

  async function seedTwoOrphanedDeliveries(opened: Awaited<ReturnType<typeof realPublisher>>) {
    await seedAnnouncedDelivery(opened, {
      engagement: ENGAGEMENT,
      taskId: '7',
      bytes: new TextEncoder().encode('{"ok":"a"}'),
      publicationKey: PUBLICATION_KEY_A,
      createdAt: '2026-08-06T00:00:00.000Z',
    });
    await seedAnnouncedDelivery(opened, {
      engagement: ENGAGEMENT_B,
      taskId: '8',
      bytes: new TextEncoder().encode('{"ok":"b"}'),
      publicationKey: PUBLICATION_KEY_B,
      createdAt: '2026-08-06T00:00:00.001Z',
    });
    const events = new NativeMarketplaceEventRepository(store);
    events.apply({
      events: [
        settlementEvent(BLOCK_HASH),
        settlementEvent(BLOCK_HASH, { taskId: 8n, logIndex: 1 }),
      ] as never,
    });
    events.apply({ events: [], orphanedBlockHashes: [BLOCK_HASH] });
    // The precondition that makes naive timestamps collide: one shared base for the whole block.
    expect(store.db.prepare(
      `SELECT DISTINCT orphaned_at FROM native_marketplace_events WHERE orphaned_at IS NOT NULL`,
    ).all()).toHaveLength(1);
    return events;
  }

  it('withdraws every published delivery of one reorged block with strictly-advancing timestamps', async () => {
    const opened = await realPublisher();
    const events = await seedTwoOrphanedDeliveries(opened);

    await buildNativeSolutionCorrections({ store, publisher: opened, marketplaceEvents: events })
      .reconcile();

    expect(store.db.prepare(
      `SELECT action FROM native_solution_discovery_corrections ORDER BY rowid`,
    ).all()).toEqual([{ action: 'withdrawn' }, { action: 'withdrawn' }]);
    // Both withdrawals committed to the one signed source (sequences 3 and 4), which the
    // source-writer would have refused had any two announcements shared a timestamp.
    const timestamps = await announcementTimestamps(opened, 4);
    for (let index = 1; index < timestamps.length; index += 1) {
      expect(Date.parse(timestamps[index]!)).toBeGreaterThan(Date.parse(timestamps[index - 1]!));
    }
  });

  it('re-announces every returned delivery in one pass with strictly-advancing timestamps', async () => {
    const opened = await realPublisher();
    const events = await seedTwoOrphanedDeliveries(opened);
    const corrections = buildNativeSolutionCorrections({
      store, publisher: opened, marketplaceEvents: events,
    });
    await corrections.reconcile();

    // Both deliveries return in one new canonical block. The signed head now sits 1ms past the
    // shared `orphaned_at`; give the re-announce pass's wall-clock base room to advance past it.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const returned = `0x${'f'.repeat(64)}` as const;
    events.apply({
      events: [
        settlementEvent(returned),
        settlementEvent(returned, { taskId: 8n, logIndex: 1 }),
      ] as never,
    });
    await corrections.reconcile();

    expect(store.db.prepare(
      `SELECT action FROM native_solution_discovery_corrections ORDER BY rowid`,
    ).all()).toEqual([
      { action: 'withdrawn' }, { action: 'withdrawn' },
      { action: 'available' }, { action: 'available' },
    ]);
    const timestamps = await announcementTimestamps(opened, 6);
    for (let index = 1; index < timestamps.length; index += 1) {
      expect(Date.parse(timestamps[index]!)).toBeGreaterThan(Date.parse(timestamps[index - 1]!));
    }
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

  // Defect #47 review. The tee is the FIRST writer a `rewindChainLogCursor` replay reaches -- it
  // writes inside `poll()`, before the projector sees a log -- and a replayed range comes back
  // re-tiered `safe` -> `finalized` because the catch-up fast path refetches it below the finalized
  // head. That used to throw out of `apply`, and since `apply` is ONE transaction the throw
  // discarded the whole batch: the new post-cursor blocks with it, which are never re-listed. So
  // the recovery step silently holed the read model it was meant to repair. Real repository, real
  // decode, two real polls.
  it('ingests a replayed batch re-tiered safe -> finalized instead of dropping it', async () => {
    const repository = new NativeMarketplaceEventRepository(store);
    const warn = vi.fn();
    let tier: 'safe' | 'finalized' = 'safe';
    const teed = teeNativeMarketplaceEvents({
      source: {
        poll: async () => ({
          logs: [solutionClaimLog(BLOCK_HASH, TX_HASH, 100n, tier)],
          cursor: { blockNumber: 100n, blockHash: BLOCK_HASH },
          finalizedCheckpoint: { blockNumber: 100n, blockHash: BLOCK_HASH },
        }),
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

    await teed.poll();
    expect(repository.solutionCandidates()).toHaveLength(1);
    expect(repository.solutionCandidates()[0]?.derivation.finalityTier).toBe('safe');

    // The replay: the same log, refetched below the finalized head.
    tier = 'finalized';
    await teed.poll();

    expect(warn).not.toHaveBeenCalled();
    expect(repository.solutionCandidates()).toHaveLength(1);
    expect(repository.solutionCandidates()[0]?.derivation.finalityTier).toBe('finalized');
  });

  it('never fails the projector\'s delivery when the read model rejects a batch', async () => {
    // `poll()` advances the durable cursor INSIDE itself, before returning. If this decorator
    // rethrew, the projector would never see a batch whose cursor is already committed and those
    // events would be permanently invisible to the signed-announcement chain. `apply` can throw
    // for real -- its `changed bytes` guard fires on a genuine byte divergence for an already
    // journalled event key, and SQLITE_BUSY past the timeout throws too. (The re-tier case above
    // is deliberately NOT one of them any more.)
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
