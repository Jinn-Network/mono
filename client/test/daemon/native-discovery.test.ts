import { describe, expect, it, vi } from 'vitest';
import {
  RECORD_DISCOVERY_VERSION,
  archivePagePath,
  headPath,
  sealJson,
  type AnnouncementEntry,
  type SourceHead,
} from '@jinn-network/record-discovery-protocol';
import type { SourceIdentity } from '@jinn-network/record-discovery-protocol';
import { Store } from '../../src/store/store.js';
import {
  NativeDiscoveryLocalAuthorityError,
  NativeDiscoverySyncError,
  createNativeDiscoveryConsumer,
  type NativeDiscoverySource,
} from '../../src/daemon/native-discovery.js';
import type { AnnouncedSubmissionCard } from '../../src/daemon/native-submission-facts.js';

const AGENT = 'did:key:zNativeRequester';
const SOURCE_NAME = 'requester';
const ROOT = 'https://requester.example';
const DIGEST_A = `sha256:${'a'.repeat(64)}` as const;
const DIGEST_B = `sha256:${'b'.repeat(64)}` as const;
const DIGEST_C = `sha256:${'c'.repeat(64)}` as const;
const FRESH_FIXTURE_TIME = new Date('2026-08-02T02:00:00.000Z');

function entry(sequence: string, previous: `sha256:${string}` | null, digest: `sha256:${string}`): AnnouncementEntry {
  return {
    protocol: RECORD_DISCOVERY_VERSION,
    source: { agent: AGENT, name: SOURCE_NAME },
    sequence,
    previous,
    timestamp: `2026-08-02T00:00:0${Number(sequence)}.000Z`,
    announcements: [{
      announcementId: `announcement-${sequence}`,
      action: 'available',
      record: { kind: 'https://spec.jinn.network/records/submission/v1', digest },
      facts: { taskDigest: digest, taskProfileUri: 'https://spec.jinn.network/task-profiles/prediction-forecast/1.0' },
    }],
  };
}

function withdrawnEntry(sequence: string, previous: `sha256:${string}`, retracts: string): AnnouncementEntry {
  return {
    protocol: RECORD_DISCOVERY_VERSION,
    source: { agent: AGENT, name: SOURCE_NAME },
    sequence,
    previous,
    timestamp: `2026-08-02T00:00:0${Number(sequence)}.000Z`,
    announcements: [{
      announcementId: `withdrawal-${sequence}`,
      action: 'withdrawn',
      retracts,
      reason: 'reorged',
    }],
  };
}

function signed(entryValue: AnnouncementEntry) {
  return {
    entry: entryValue,
    signature: {
      payloadType: 'application/vnd.jinn.record-discovery.entry.v1+json',
      payload: Buffer.from('signed-entry').toString('base64'),
      signatures: [{ keyid: 'requester-key', sig: Buffer.from('signature').toString('base64') }],
    },
  };
}

function head(entryValue: AnnouncementEntry, issuedAt = '2026-08-02T01:00:00.000Z'): SourceHead {
  return {
    protocol: RECORD_DISCOVERY_VERSION,
    origin: `${AGENT}/${SOURCE_NAME}`,
    sequence: entryValue.sequence,
    entry: sealJson(entryValue).digest,
    issuedAt,
    refreshBy: '2026-08-03T01:00:00.000Z',
  };
}

function wireHead(headValue: SourceHead) {
  return {
    payloadType: 'application/vnd.jinn.record-discovery.head.v1+json',
    payload: Buffer.from(JSON.stringify(headValue)).toString('base64'),
    signatures: [{ keyid: 'requester-key', sig: Buffer.from('signature').toString('base64') }],
  };
}

function page(page: string, prevArchive: string | null, entries: readonly ReturnType<typeof signed>[]) {
  return { protocol: RECORD_DISCOVERY_VERSION, source: SOURCE_NAME, page, prevArchive, entries };
}

function routesFor(entries: readonly AnnouncementEntry[]) {
  const routes = new Map<string, unknown>();
  const pages: Array<{ page: string; entries: readonly AnnouncementEntry[] }> = [];
  for (let index = 0; index < entries.length; index += 1) {
    pages.push({ page: String(index + 1).padStart(16, '0'), entries: [entries[index]!] });
  }
  for (let index = 0; index < pages.length; index += 1) {
    const current = pages[index]!;
    routes.set(
      `${ROOT}${archivePagePath(SOURCE_NAME, current.page)}`,
      page(current.page, index === 0 ? null : pages[index - 1]!.page, current.entries.map(signed)),
    );
  }
  const last = entries.at(-1)!;
  routes.set(`${ROOT}${headPath(SOURCE_NAME)}`, wireHead(head(last)));
  return routes;
}

function source(
  routes: Map<string, unknown>,
  verify: NativeDiscoverySource['verify'],
  verifyHead: NativeDiscoverySource['verifyHead'] = async () => ({ status: 'ok' }),
): NativeDiscoverySource {
  return {
    identity: { agent: AGENT, name: SOURCE_NAME },
    resolveEndpoint: async () => ({
      agent: AGENT,
      name: SOURCE_NAME,
      servingRoot: ROOT,
      archiveRootUrl: `${ROOT}${archivePagePath(SOURCE_NAME, String(routes.size - 1).padStart(16, '0'))}`,
    }),
    verify,
    verifyHead,
  };
}

function cardFor(sequence: string): AnnouncedSubmissionCard {
  return {
    record: { kind: 'https://spec.jinn.network/records/submission/v1', digest: DIGEST_A },
    facts: { taskDigest: DIGEST_A, taskProfileUri: 'https://spec.jinn.network/task-profiles/prediction-forecast/1.0' },
    chain: {
      taskId: BigInt(sequence),
      submission: 'urn:uuid:11111111-1111-4111-8111-111111111111',
      nonce: `nonce-${sequence}`,
      intendedSpendWei: 0n,
    },
  };
}

function consumer(input: {
  readonly store: Store;
  readonly routes: Map<string, unknown>;
  readonly verify: NativeDiscoverySource['verify'];
  readonly verifyHead?: NativeDiscoverySource['verifyHead'];
  readonly decode?: ReturnType<typeof createNativeDiscoveryConsumer>['decode'];
  readonly now?: () => Date;
}) {
  return createNativeDiscoveryConsumer({
    store: input.store,
    sources: [source(input.routes, input.verify, input.verifyHead)],
    transport: {
      'fetch': async (url) => {
        const value = input.routes.get(url);
        if (value === undefined) throw new Error(`missing route ${url}`);
        return { status: 200, contentType: 'application/json', bytes: new TextEncoder().encode(JSON.stringify(value)) };
      },
    },
    decode: input.decode ?? (async (input) => cardFor(input.entry.sequence)),
    now: input.now ?? (() => FRESH_FIXTURE_TIME),
  });
}

describe('native discovery consumer', () => {
  it('cold-syncs once, persists an exact signed high-water with queued cards, then returning-syncs only the exact next sequence after restart', async () => {
    const first = entry('0000000000000001', null, DIGEST_A);
    const second = entry('0000000000000002', sealJson(first).digest, DIGEST_B);
    const routes = routesFor([first, second]);
    const verified: Array<{ firstAdoption: boolean; sequences: string[] }> = [];
    const verify = vi.fn(async (input) => {
      const sequences: string[] = [];
      for await (const item of input.entries) sequences.push(item.entry.sequence);
      verified.push({ firstAdoption: input.firstAdoption, sequences });
      return { status: 'ok' as const };
    });
    const store = new Store(':memory:');

    const cold = consumer({ store, routes, verify });
    await expect(cold.sync()).resolves.toEqual({ accepted: 2, verifiedSources: 1, degraded: [] });
    expect(cold.takePending().map((item) => item.card.chain.taskId)).toEqual([1n, 2n]);
    for (const item of cold.takePending()) cold.acknowledge(item);
    expect(cold.checkpoint({ agent: AGENT, name: SOURCE_NAME })).toMatchObject({
      sequence: '0000000000000002',
      entryDigest: sealJson(second).digest,
      signedHighWater: { sequence: '0000000000000002', entry: sealJson(second).digest },
    });

    const third = entry('0000000000000003', sealJson(second).digest, DIGEST_C);
    const resumedRoutes = routesFor([first, second, third]);
    const restarted = consumer({ store, routes: resumedRoutes, verify });
    await expect(restarted.sync()).resolves.toEqual({ accepted: 1, verifiedSources: 1, degraded: [] });
    expect(restarted.takePending().map((item) => item.card.chain.taskId)).toEqual([3n]);
    expect(verified).toEqual([
      { firstAdoption: true, sequences: ['0000000000000001', '0000000000000002'] },
      { firstAdoption: false, sequences: ['0000000000000003'] },
    ]);
  });

  it('deduplicates a repeated archive page before source-chain verification and queue insertion', async () => {
    const first = entry('0000000000000001', null, DIGEST_A);
    const second = entry('0000000000000002', sealJson(first).digest, DIGEST_B);
    const routes = routesFor([first, second]);
    routes.set(`${ROOT}${archivePagePath(SOURCE_NAME, '0000000000000001')}`,
      page('0000000000000001', null, [signed(first), signed(first)]));
    const sequences: string[] = [];
    const verifier = async (input: Parameters<NativeDiscoverySource['verify']>[0]) => {
      for await (const item of input.entries) sequences.push(item.entry.sequence);
      return { status: 'ok' as const };
    };
    const synced = consumer({ store: new Store(':memory:'), routes, verify: verifier });

    await expect(synced.sync()).resolves.toEqual({ accepted: 2, verifiedSources: 1, degraded: [] });
    expect(sequences).toEqual(['0000000000000001', '0000000000000002']);
    expect(synced.takePending()).toHaveLength(2);
  });

  it.each(['stale', 'unauthorized-signer'] as const)('refuses a %s signed head without advancing checkpoint or releasing work', async (status) => {
    const first = entry('0000000000000001', null, DIGEST_A);
    const synced = consumer({
      store: new Store(':memory:'),
      routes: routesFor([first]),
      verify: async () => ({ status }),
    });

    await expect(synced.sync()).rejects.toEqual(expect.any(NativeDiscoverySyncError));
    expect(synced.checkpoint({ agent: AGENT, name: SOURCE_NAME })).toBeUndefined();
    expect(synced.takePending()).toEqual([]);
  });

  it('does no card work on a verified no-change poll', async () => {
    const first = entry('0000000000000001', null, DIGEST_A);
    const verify = vi.fn(async () => ({ status: 'ok' as const }));
    const decode = vi.fn(async (input: { entry: AnnouncementEntry }) => cardFor(input.entry.sequence));
    const synced = consumer({ store: new Store(':memory:'), routes: routesFor([first]), verify, decode });

    await synced.sync();
    for (const item of synced.takePending()) synced.acknowledge(item);
    await expect(synced.sync()).resolves.toEqual({ accepted: 0, verifiedSources: 1, degraded: [] });
    expect(decode).toHaveBeenCalledOnce();
    expect(verify).toHaveBeenCalledOnce();
    expect(synced.takePending()).toEqual([]);
  });

  it('revalidates a byte-identical head and refuses it once refreshBy has passed', async () => {
    const first = entry('0000000000000001', null, DIGEST_A);
    let now = new Date('2026-08-02T01:00:00.000Z');
    const store = new Store(':memory:');
    const initial = consumer({
      store,
      routes: routesFor([first]),
      verify: async () => ({ status: 'ok' }),
      verifyHead: async () => ({ status: 'ok' }),
      now: () => now,
    });
    await initial.sync();
    for (const item of initial.takePending()) initial.acknowledge(item);

    now = new Date('2026-08-04T01:00:00.000Z');
    const verifyHead = vi.fn(async () => ({ status: 'ok' as const }));
    const restarted = consumer({
      store,
      routes: routesFor([first]),
      verify: async () => ({ status: 'ok' }),
      verifyHead,
      now: () => now,
    });
    await expect(restarted.sync()).rejects.toMatchObject({ reason: 'stale' });
    expect(verifyHead).toHaveBeenCalledOnce();
    expect(restarted.takePending()).toEqual([]);
  });

  it('refuses an advertised head whose terminal entry is absent or has a different digest even when the injected verifier returns ok', async () => {
    const first = entry('0000000000000001', null, DIGEST_A);
    const second = entry('0000000000000002', sealJson(first).digest, DIGEST_B);
    const routes = routesFor([first, second]);
    routes.set(`${ROOT}${headPath(SOURCE_NAME)}`, wireHead({ ...head(second), entry: sealJson(first).digest }));
    const synced = consumer({
      store: new Store(':memory:'),
      routes,
      verify: async () => ({ status: 'ok' }),
    });

    await expect(synced.sync()).rejects.toMatchObject({ reason: 'advertised-head-entry-mismatch' });
    expect(synced.checkpoint({ agent: AGENT, name: SOURCE_NAME })).toBeUndefined();
  });

  it('replays an unacknowledged accepted card after restart but never redelivers an acknowledged card', async () => {
    const first = entry('0000000000000001', null, DIGEST_A);
    const second = entry('0000000000000002', sealJson(first).digest, DIGEST_B);
    const routes = routesFor([first, second]);
    const verify = async () => ({ status: 'ok' as const });
    const store = new Store(':memory:');
    const initial = consumer({ store, routes, verify });
    await initial.sync();
    const [acknowledged, unacknowledged] = initial.takePending();
    initial.acknowledge(acknowledged!);

    const restarted = consumer({ store, routes, verify });
    await restarted.sync();
    expect(restarted.takePending().map((queued) => queued.card.chain.taskId)).toEqual([
      unacknowledged!.card.chain.taskId,
    ]);
  });

  it('resumes SSE from the durable source high-water cursor', async () => {
    const first = entry('0000000000000001', null, DIGEST_A);
    const transport = {
      url: '',
      connect(url: string) {
        this.url = url;
        return { close: () => undefined };
      },
    };
    const synced = createNativeDiscoveryConsumer({
      store: new Store(':memory:'),
      sources: [{ ...source(routesFor([first]), async () => ({ status: 'ok' as const })), sseUrl: `${ROOT}/subscribe` }],
      transport: {
        'fetch': async (url) => {
          const value = routesFor([first]).get(url);
          if (value === undefined) throw new Error(`missing route ${url}`);
          return { status: 200, bytes: new TextEncoder().encode(JSON.stringify(value)) };
        },
      },
      decode: async (input) => cardFor(input.entry.sequence),
      streamTransport: transport,
    });
    await synced.sync();

    const subscription = synced.resumeSse();
    expect(transport.url).toBe(`${ROOT}/subscribe?cursor=${encodeURIComponent(sealJson(first).digest)}`);
    subscription.close();
  });

  it('durably queues a signed append-only withdrawal and acknowledges it independently of cards', async () => {
    const first = entry('0000000000000001', null, DIGEST_A);
    const second = withdrawnEntry(
      '0000000000000002',
      sealJson(first).digest,
      first.announcements[0]!.announcementId,
    );
    const store = new Store(':memory:');
    const synced = consumer({
      store,
      routes: routesFor([first, second]),
      verify: async () => ({ status: 'ok' as const }),
    });

    await expect(synced.sync()).resolves.toEqual({ accepted: 2, verifiedSources: 1, degraded: [] });
    expect(synced.takePending()).toHaveLength(1);
    expect(synced.takePendingWithdrawals()).toEqual([expect.objectContaining({
      sequence: '0000000000000002',
      retracts: first.announcements[0]!.announcementId,
      reason: 'reorged',
    })]);
    const withdrawal = synced.takePendingWithdrawals()[0]!;
    synced.acknowledgeWithdrawal(withdrawal);
    expect(synced.takePendingWithdrawals()).toEqual([]);
  });

  it('refuses a bare, unsigned head', async () => {
    const first = entry('0000000000000001', null, DIGEST_A);
    const routes = routesFor([first]);
    routes.set(`${ROOT}${headPath(SOURCE_NAME)}`, head(first));
    const synced = consumer({ store: new Store(':memory:'), routes, verify: async () => ({ status: 'ok' }) });

    await expect(synced.sync()).rejects.toMatchObject({ reason: 'unsigned-head' });
    expect(synced.checkpoint({ agent: AGENT, name: SOURCE_NAME })).toBeUndefined();
  });

  it('refuses a head that rewinds below the persisted checkpoint', async () => {
    const first = entry('0000000000000001', null, DIGEST_A);
    const second = entry('0000000000000002', sealJson(first).digest, DIGEST_B);
    const store = new Store(':memory:');
    const verify = async () => ({ status: 'ok' as const });
    await consumer({ store, routes: routesFor([first, second]), verify }).sync();

    const rewound = routesFor([first, second]);
    rewound.set(`${ROOT}${headPath(SOURCE_NAME)}`, wireHead(head(first)));
    const restarted = consumer({ store, routes: rewound, verify });

    await expect(restarted.sync()).rejects.toMatchObject({ reason: 'rewound-or-tampered-head' });
    expect(restarted.checkpoint({ agent: AGENT, name: SOURCE_NAME })).toMatchObject({
      sequence: '0000000000000002',
    });
  });

  it('isolates durable pending cards when two domain consumers share one product database', () => {
    const store = new Store(':memory:');
    const firstSource = source(new Map(), async () => ({ status: 'ok' as const }));
    const secondSource: NativeDiscoverySource = {
      ...firstSource,
      identity: { agent: 'did:key:zNativeSolver', name: 'solver' },
      resolveEndpoint: async () => ({
        ...(await firstSource.resolveEndpoint()),
        agent: 'did:key:zNativeSolver',
        name: 'solver',
      }),
    };
    const first = createNativeDiscoveryConsumer({
      store,
      sources: [firstSource],
      transport: { fetch: async () => { throw new Error('not used'); } },
      decode: async () => undefined,
    });
    const second = createNativeDiscoveryConsumer({
      store,
      sources: [secondSource],
      transport: { fetch: async () => { throw new Error('not used'); } },
      decode: async () => undefined,
    });
    const encodedCard = JSON.stringify(cardFor('0000000000000001'), (_key, value: unknown) =>
      typeof value === 'bigint' ? { $bigint: value.toString(10) } : value);
    const insert = store.db.prepare(
      `INSERT INTO native_discovery_cards
        (source_agent, source_name, sequence, entry_digest, announcement_id, card_json, accepted_at)
       VALUES (?, ?, '0000000000000001', ?, ?, ?, '2026-08-02T00:00:00.000Z')`,
    );
    insert.run(AGENT, SOURCE_NAME, DIGEST_A, 'requester-card', encodedCard);
    insert.run('did:key:zNativeSolver', 'solver', DIGEST_B, 'solver-card', encodedCard);

    expect(first.takePending().map(({ announcementId }) => announcementId)).toEqual(['requester-card']);
    expect(second.takePending().map(({ announcementId }) => announcementId)).toEqual(['solver-card']);
  });
});

/**
 * #2523 — a source that has NEVER published a head.
 *
 * The discriminator under test is two facts, not one: the head object is absent (HTTP 404) AND this
 * consumer holds no durable checkpoint for the source. Only both together mean "a chain we have
 * never seen a byte of". Every test below either pins that pair or pins one of the refusals that
 * must survive it — most importantly the rollback case, where a checkpoint EXISTS and the head
 * 404s, which is a source retracting its own history and stays fatal.
 */
describe('native discovery consumer — the never-published source (#2523)', () => {
  const COLD_AGENT = 'did:key:zNeverPublished';
  const COLD_NAME = 'requester';
  const COLD_ROOT = 'https://cold.example';

  /** Mirrors `createHttpTransport`'s contract: a missing object throws carrying its HTTP status. */
  function httpTransport(routes: Map<string, unknown>, missingStatus = 404) {
    return {
      'fetch': async (url: string) => {
        const value = routes.get(url);
        if (value === undefined) {
          throw Object.assign(new Error(`GET ${url} failed with HTTP ${missingStatus}.`), {
            name: 'TransportHttpError',
            status: missingStatus,
            url,
          });
        }
        return {
          status: 200,
          contentType: 'application/json',
          bytes: new TextEncoder().encode(JSON.stringify(value)),
        };
      },
    };
  }

  /**
   * A source whose `.well-known` introduction resolves — exactly what #2520's serving plane
   * synthesizes for a source its operator owns but has not published — and that serves no head.
   * Its verifiers throw, so any test that passes is a test in which no chain verification was
   * skipped: the skip happens strictly before verification is reachable.
   */
  function neverPublished(identity: SourceIdentity): NativeDiscoverySource {
    return {
      identity,
      resolveEndpoint: async () => ({
        agent: identity.agent,
        name: identity.name,
        servingRoot: COLD_ROOT,
        archiveRootUrl: `${COLD_ROOT}${archivePagePath(identity.name, '0000000000000001')}`,
      }),
      verify: async () => { throw new Error('a never-published source must not reach chain verification'); },
      verifyHead: async () => { throw new Error('a never-published source must not reach head revalidation'); },
    };
  }

  const COLD: SourceIdentity = { agent: COLD_AGENT, name: COLD_NAME };

  it('accepts nothing, writes no checkpoint, and still polls its siblings', async () => {
    const first = entry('0000000000000001', null, DIGEST_A);
    const routes = routesFor([first]);
    const store = new Store(':memory:');
    const synced = createNativeDiscoveryConsumer({
      store,
      sources: [neverPublished(COLD), source(routes, async () => ({ status: 'ok' }))],
      transport: httpTransport(routes),
      decode: async (input) => cardFor(input.entry.sequence),
      now: () => FRESH_FIXTURE_TIME,
    });

    // The cold source counts toward neither `accepted` nor `verifiedSources` — it verified nothing.
    // Since #2529 it is also NAMED in the pass report, as a degraded source rather than a silent skip.
    await expect(synced.sync()).resolves.toMatchObject({
      accepted: 1,
      verifiedSources: 1,
      degraded: [{ source: COLD, reason: 'unpublished' }],
    });
    expect(synced.checkpoint(COLD)).toBeUndefined();
    expect(synced.checkpoint({ agent: AGENT, name: SOURCE_NAME })).toMatchObject({
      sequence: '0000000000000001',
    });
    expect(synced.takePending()).toHaveLength(1);
  });

  it('takes the ordinary first-adoption cold path the moment a head appears', async () => {
    const first = entry('0000000000000001', null, DIGEST_A);
    const routes = new Map<string, unknown>();
    const store = new Store(':memory:');
    const adoptions: boolean[] = [];
    const synced = createNativeDiscoveryConsumer({
      store,
      sources: [source(routes, async (input) => {
        for await (const item of input.entries) void item;
        adoptions.push(input.firstAdoption);
        return { status: 'ok' };
      })],
      transport: httpTransport(routes),
      decode: async (input) => cardFor(input.entry.sequence),
      now: () => FRESH_FIXTURE_TIME,
    });

    await expect(synced.sync()).resolves.toMatchObject({
      accepted: 0,
      verifiedSources: 0,
      degraded: [{ source: { agent: AGENT, name: SOURCE_NAME }, reason: 'unpublished' }],
    });
    expect(adoptions).toEqual([]);

    for (const [url, value] of routesFor([first])) routes.set(url, value);
    await expect(synced.sync()).resolves.toEqual({ accepted: 1, verifiedSources: 1, degraded: [] });
    // Polling early skipped no entry: the source is adopted from genesis, not from "now".
    expect(adoptions).toEqual([true]);
  });

  it('REFUSES a source that has a checkpoint and whose head now 404s (rollback, not cold start)', async () => {
    const first = entry('0000000000000001', null, DIGEST_A);
    const routes = routesFor([first]);
    const store = new Store(':memory:');
    const verify = async () => ({ status: 'ok' as const });
    const initial = createNativeDiscoveryConsumer({
      store,
      sources: [source(routes, verify)],
      transport: httpTransport(routes),
      decode: async (input) => cardFor(input.entry.sequence),
      now: () => FRESH_FIXTURE_TIME,
    });
    await expect(initial.sync()).resolves.toEqual({ accepted: 1, verifiedSources: 1, degraded: [] });

    // Same source, same store — the head object disappears.
    routes.delete(`${ROOT}${headPath(SOURCE_NAME)}`);
    const restarted = createNativeDiscoveryConsumer({
      store,
      sources: [source(routes, verify)],
      transport: httpTransport(routes),
      decode: async (input) => cardFor(input.entry.sequence),
      now: () => FRESH_FIXTURE_TIME,
    });

    await expect(restarted.sync()).rejects.toThrow(/HTTP 404/u);
    expect(restarted.checkpoint({ agent: AGENT, name: SOURCE_NAME })).toMatchObject({
      sequence: '0000000000000001',
    });
  });

  it.each([500, 403, 502])('refuses a head that fails with HTTP %i even with no checkpoint', async (status) => {
    const store = new Store(':memory:');
    const synced = createNativeDiscoveryConsumer({
      store,
      sources: [neverPublished(COLD)],
      transport: httpTransport(new Map(), status),
      decode: async () => undefined,
    });

    await expect(synced.sync()).rejects.toThrow(new RegExp(`HTTP ${status}`, 'u'));
    expect(synced.checkpoint(COLD)).toBeUndefined();
  });

  it('never reaches a cold source that cannot introduce itself', async () => {
    const store = new Store(':memory:');
    const synced = createNativeDiscoveryConsumer({
      store,
      sources: [{
        ...neverPublished(COLD),
        resolveEndpoint: async () => { throw new Error('source is not uniquely introduced'); },
      }],
      transport: httpTransport(new Map()),
      decode: async () => undefined,
    });

    await expect(synced.sync()).rejects.toThrow(/not uniquely introduced/u);
  });
});

/**
 * ## Per-source isolation at boot (#2529)
 *
 * `WorkLoop.initialize` awaits `sync()` on the daemon start path, so until now ANY single-source
 * problem was process-fatal. Three instances of that were found live inside a fortnight — a
 * never-published source (#2523), an announcement the consumer's own decode rejected (#2529 F1),
 * and a peer that simply was not up (#2529 F2). These tests pin the CLASS, not the instances: a
 * source that is unavailable or unintelligible degrades itself and the pass continues; a source
 * that is untrustworthy still refuses, hard.
 *
 * The refusal battery at the bottom is the mutation control. Delete `degradedReason`'s
 * `NativeDiscoverySyncError` / `NativeDiscoveryLocalAuthorityError` guards, or widen its
 * status-less-transport branch, and those cases go red rather than quietly widening what boots.
 */
describe('native discovery consumer — per-source isolation (#2529)', () => {
  const PEER: SourceIdentity = { agent: 'did:key:zPeer', name: 'requester' };

  /** Mirrors `createHttpTransport`: a missing object throws carrying its HTTP status. */
  function statusTransport(routes: Map<string, unknown>, missingStatus = 404) {
    return {
      'fetch': async (url: string) => {
        const value = routes.get(url);
        if (value === undefined) {
          throw Object.assign(new Error(`GET ${url} failed with HTTP ${missingStatus}.`), {
            name: 'TransportHttpError',
            status: missingStatus,
            url,
          });
        }
        return {
          status: 200,
          contentType: 'application/json',
          bytes: new TextEncoder().encode(JSON.stringify(value)),
        };
      },
    };
  }

  /** Serves whatever is in `routes`; anything else is a socket that is not listening. */
  function silentTransport(routes: Map<string, unknown>) {
    return {
      'fetch': async (url: string) => {
        const value = routes.get(url);
        if (value === undefined) throw new TypeError('fetch failed');
        return {
          status: 200,
          contentType: 'application/json',
          bytes: new TextEncoder().encode(JSON.stringify(value)),
        };
      },
    };
  }

  function peerSource(identity: SourceIdentity, overrides: Partial<NativeDiscoverySource> = {}): NativeDiscoverySource {
    return {
      identity,
      resolveEndpoint: async () => ({
        agent: identity.agent,
        name: identity.name,
        servingRoot: ROOT,
        archiveRootUrl: `${ROOT}${archivePagePath(SOURCE_NAME, '0000000000000001')}`,
      }),
      verify: async (input) => {
        for await (const item of input.entries) void item;
        return { status: 'ok' };
      },
      verifyHead: async () => ({ status: 'ok' }),
      ...overrides,
    };
  }

  /** The shape `native-discovery-trust.ts` throws when nothing answered at the origin. */
  function unreachableAtIntroduction(identity: SourceIdentity): NativeDiscoverySource {
    return peerSource(identity, {
      resolveEndpoint: async () => {
        throw Object.assign(
          new Error(`native discovery source ${identity.agent}/${identity.name} at ${ROOT} `
            + 'could not be resolved: fetch failed'),
          { name: 'NativeDiscoverySourceResolutionError', kind: 'unreachable' },
        );
      },
    });
  }

  it('degrades a peer whose origin is not listening and still syncs the other sources', async () => {
    const first = entry('0000000000000001', null, DIGEST_A);
    const routes = routesFor([first]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const synced = createNativeDiscoveryConsumer({
      store: new Store(':memory:'),
      sources: [unreachableAtIntroduction(PEER), source(routes, async () => ({ status: 'ok' }))],
      transport: silentTransport(routes),
      decode: async (input) => cardFor(input.entry.sequence),
      now: () => FRESH_FIXTURE_TIME,
    });

    await expect(synced.sync()).resolves.toMatchObject({
      accepted: 1,
      verifiedSources: 1,
      degraded: [{ source: PEER, reason: 'unreachable' }],
    });
    expect(synced.checkpoint(PEER)).toBeUndefined();
    expect(synced.takePending()).toHaveLength(1);
    // Loud and legible: agent, name and baseUrl all appear, so an operator never has to reach for
    // JINN_DEBUG to learn WHICH source is down.
    const logged = warn.mock.calls.map((call) => String(call[0])).join('\n');
    expect(logged).toContain(PEER.agent);
    expect(logged).toContain(ROOT);
    expect(logged).toContain('unreachable');
    warn.mockRestore();
  });

  it('degrades a peer that goes down after its introduction resolved', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const synced = createNativeDiscoveryConsumer({
      store: new Store(':memory:'),
      sources: [peerSource(PEER)],
      transport: {
        'fetch': async () => {
          throw Object.assign(new TypeError('fetch failed'), {
            cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:7401'), { code: 'ECONNREFUSED' }),
          });
        },
      },
      decode: async () => undefined,
      now: () => FRESH_FIXTURE_TIME,
    });

    await expect(synced.sync()).resolves.toMatchObject({
      accepted: 0,
      verifiedSources: 0,
      degraded: [{ source: PEER, reason: 'unreachable' }],
    });
    expect(synced.checkpoint(PEER)).toBeUndefined();
    warn.mockRestore();
  });

  it('recovers a degraded source at a later poll, adopting from genesis with no gap', async () => {
    const first = entry('0000000000000001', null, DIGEST_A);
    const routes = routesFor([first]);
    const live = new Map<string, unknown>();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const adoptions: boolean[] = [];
    const synced = createNativeDiscoveryConsumer({
      store: new Store(':memory:'),
      sources: [source(routes, async (input) => {
        for await (const item of input.entries) void item;
        adoptions.push(input.firstAdoption);
        return { status: 'ok' };
      })],
      transport: silentTransport(live),
      decode: async (input) => cardFor(input.entry.sequence),
      now: () => FRESH_FIXTURE_TIME,
    });

    await expect(synced.sync()).resolves.toMatchObject({ degraded: [{ reason: 'unreachable' }] });
    expect(adoptions).toEqual([]);
    for (const [url, value] of routes) live.set(url, value);
    await expect(synced.sync()).resolves.toEqual({ accepted: 1, verifiedSources: 1, degraded: [] });
    expect(adoptions).toEqual([true]);
    expect(synced.takePending()).toHaveLength(1);
    warn.mockRestore();
  });

  it('degrades a source serving an announcement it cannot decode, without advancing past it', async () => {
    const first = entry('0000000000000001', null, DIGEST_A);
    const routes = routesFor([first]);
    const store = new Store(':memory:');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    let undecodable = true;
    const synced = consumer({
      store,
      routes,
      verify: async (input) => {
        for await (const item of input.entries) void item;
        return { status: 'ok' };
      },
      decode: async (input) => {
        // The exact live failure: the requester's own signed announcement, rejected by the
        // operator's own decode.
        if (undecodable) throw new Error('chainId is not a canonical unsigned integer');
        return cardFor(input.entry.sequence);
      },
    });

    await expect(synced.sync()).resolves.toMatchObject({
      accepted: 0,
      verifiedSources: 0,
      degraded: [{ source: { agent: AGENT, name: SOURCE_NAME }, reason: 'undecodable' }],
    });
    // The load-bearing half: no checkpoint, so the signed announcement is NOT skipped past. A
    // reader bug must never silently consume append-only history.
    expect(synced.checkpoint({ agent: AGENT, name: SOURCE_NAME })).toBeUndefined();
    expect(synced.takePending()).toHaveLength(0);

    undecodable = false;
    await expect(synced.sync()).resolves.toEqual({ accepted: 1, verifiedSources: 1, degraded: [] });
    expect(synced.takePending()).toHaveLength(1);
    warn.mockRestore();
  });

  it('isolates the undecodable source from its siblings', async () => {
    const first = entry('0000000000000001', null, DIGEST_A);
    const routes = routesFor([first]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const synced = createNativeDiscoveryConsumer({
      store: new Store(':memory:'),
      sources: [peerSource(PEER), source(routes, async (input) => {
        for await (const item of input.entries) void item;
        return { status: 'ok' };
      })],
      transport: silentTransport(routes),
      decode: async (input) => {
        if (input.source.agent === PEER.agent) throw new Error('unknown announcement profile');
        return cardFor(input.entry.sequence);
      },
      now: () => FRESH_FIXTURE_TIME,
    });

    await expect(synced.sync()).resolves.toMatchObject({
      accepted: 1,
      verifiedSources: 1,
      degraded: [{ source: PEER, reason: 'undecodable' }],
    });
    expect(synced.takePending()).toHaveLength(1);
    warn.mockRestore();
  });

  it('logs a degraded source once, not once per poll', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const synced = createNativeDiscoveryConsumer({
      store: new Store(':memory:'),
      sources: [unreachableAtIntroduction(PEER)],
      transport: statusTransport(new Map()),
      decode: async () => undefined,
    });

    await synced.sync();
    await synced.sync();
    await synced.sync();
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  /**
   * Every case here names a distinct untrust condition and must still throw OUT of `sync()`.
   */
  describe('an untrustworthy source still refuses, hard', () => {
    const chainVerified: NativeDiscoverySource['verify'] = async (input) => {
      for await (const item of input.entries) void item;
      return { status: 'ok' };
    };

    it('refuses an unsigned head', async () => {
      const first = entry('0000000000000001', null, DIGEST_A);
      const routes = routesFor([first]);
      routes.set(`${ROOT}${headPath(SOURCE_NAME)}`, head(first));
      const synced = consumer({ store: new Store(':memory:'), routes, verify: chainVerified });
      await expect(synced.sync()).rejects.toMatchObject({ reason: 'unsigned-head' });
    });

    it.each([
      'bad-signature',
      'unauthorized-signer',
      'unknown-agent',
      'revoked-key',
      'conflicting-bindings',
      'scope-violation',
      'expired-binding',
    ])('refuses a chain the trust verifier rejects as %s', async (status) => {
      const first = entry('0000000000000001', null, DIGEST_A);
      const routes = routesFor([first]);
      const synced = consumer({
        store: new Store(':memory:'),
        routes,
        verify: async (input) => {
          for await (const item of input.entries) void item;
          return { status };
        },
      });
      await expect(synced.sync()).rejects.toMatchObject({ reason: status });
    });

    it.each(['unauthorized-signer', 'head-payload-mismatch', 'invalid-head-envelope'])(
      'refuses a byte-identical head that revalidation rejects as %s',
      async (status) => {
        const first = entry('0000000000000001', null, DIGEST_A);
        const routes = routesFor([first]);
        const store = new Store(':memory:');
        await consumer({ store, routes, verify: chainVerified }).sync();
        const restarted = consumer({
          store,
          routes,
          verify: chainVerified,
          verifyHead: async () => ({ status }),
        });
        await expect(restarted.sync()).rejects.toMatchObject({ reason: status });
      },
    );

    it('refuses an entry the source served unsigned', async () => {
      const first = entry('0000000000000001', null, DIGEST_A);
      const routes = routesFor([first]);
      routes.set(`${ROOT}${archivePagePath(SOURCE_NAME, '0000000000000001')}`, {
        protocol: RECORD_DISCOVERY_VERSION,
        source: SOURCE_NAME,
        page: '0000000000000001',
        prevArchive: null,
        entries: [{ entry: first }],
      });
      const synced = consumer({ store: new Store(':memory:'), routes, verify: chainVerified });
      await expect(synced.sync()).rejects.toMatchObject({ reason: 'unsigned-entry' });
    });

    it('refuses a head that 404s once a checkpoint exists — a rollback is not an outage', async () => {
      const first = entry('0000000000000001', null, DIGEST_A);
      const routes = routesFor([first]);
      const store = new Store(':memory:');
      const build = () => createNativeDiscoveryConsumer({
        store,
        sources: [source(routes, chainVerified)],
        transport: statusTransport(routes),
        decode: async (input) => cardFor(input.entry.sequence),
        now: () => FRESH_FIXTURE_TIME,
      });
      await build().sync();
      routes.delete(`${ROOT}${headPath(SOURCE_NAME)}`);
      await expect(build().sync()).rejects.toThrow(/HTTP 404/u);
    });

    it('refuses a resolution failure that is not marked unreachable', async () => {
      const synced = createNativeDiscoveryConsumer({
        store: new Store(':memory:'),
        sources: [peerSource(PEER, {
          resolveEndpoint: async () => {
            throw Object.assign(
              new Error('public source did:key:zPeer/requester is not uniquely introduced'),
              { name: 'NativeDiscoverySourceResolutionError', kind: 'unintroduced' },
            );
          },
        })],
        transport: statusTransport(new Map()),
        decode: async () => undefined,
      });
      await expect(synced.sync()).rejects.toThrow(/not uniquely introduced/u);
    });

    it("refuses a decode failure that reports THIS operator's own trust catalog", async () => {
      const first = entry('0000000000000001', null, DIGEST_A);
      const routes = routesFor([first]);
      const synced = consumer({
        store: new Store(':memory:'),
        routes,
        verify: chainVerified,
        decode: async () => {
          throw new NativeDiscoveryLocalAuthorityError({
            cause: new Error('native trust catalog changed after authority load'),
          });
        },
      });
      await expect(synced.sync()).rejects.toThrow(/trust catalog changed after authority load/u);
    });

    it('refuses a malformed payload rather than mistaking it for silence', async () => {
      const synced = createNativeDiscoveryConsumer({
        store: new Store(':memory:'),
        sources: [peerSource(PEER)],
        transport: {
          'fetch': async () => ({
            status: 200,
            contentType: 'application/json',
            bytes: new TextEncoder().encode('{ not json'),
          }),
        },
        decode: async () => undefined,
        now: () => FRESH_FIXTURE_TIME,
      });
      await expect(synced.sync()).rejects.toThrow();
    });
  });
});

// #2531 F2. `archiveRootUrl` names the peer's NEWEST archive page and rolls as the peer appends.
// It was memoized per process, so a long-running consumer kept reading the old page: returning
// sync collected nothing, the terminal check fired, and a benign roll was reported under the
// tamper-class name `advertised-head-entry-mismatch` — 22 consecutive ticks of it in the live gate.
describe('a peer rolling its archive page (#2531 F2)', () => {
  /**
   * A source whose endpoint memoizes exactly the way production's does, over a MUTABLE
   * introduction — so `refresh: true` is the only thing that can observe a roll.
   */
  function rollingSource(state: { root: string; introductionReads: number }): NativeDiscoverySource {
    let resolved: { agent: string; name: string; servingRoot: string; archiveRootUrl: string } | undefined;
    return {
      identity: { agent: AGENT, name: SOURCE_NAME },
      resolveEndpoint: async (options) => {
        if (resolved !== undefined && options?.refresh !== true) return resolved;
        state.introductionReads += 1;
        resolved = {
          agent: AGENT,
          name: SOURCE_NAME,
          servingRoot: ROOT,
          archiveRootUrl: `${ROOT}${archivePagePath(SOURCE_NAME, state.root)}`,
        };
        return resolved;
      },
      verify: async () => ({ status: 'ok' }),
      verifyHead: async () => ({ status: 'ok' }),
    };
  }

  function rollingConsumer(input: {
    readonly store: Store;
    readonly routes: () => Map<string, unknown>;
    readonly source: NativeDiscoverySource;
  }) {
    return createNativeDiscoveryConsumer({
      store: input.store,
      sources: [input.source],
      transport: {
        'fetch': async (url) => {
          const value = input.routes().get(url);
          if (value === undefined) throw new Error(`missing route ${url}`);
          return { status: 200, contentType: 'application/json', bytes: new TextEncoder().encode(JSON.stringify(value)) };
        },
      },
      decode: async (decodeInput) => cardFor(decodeInput.entry.sequence),
      now: () => FRESH_FIXTURE_TIME,
    });
  }

  it('follows the roll within one process lifetime, and never reports it as tamper', async () => {
    const first = entry('0000000000000001', null, DIGEST_A);
    const second = entry('0000000000000002', sealJson(first).digest, DIGEST_B);
    const state = { root: '0000000000000001', introductionReads: 0 };
    let routes = routesFor([first]);
    const store = new Store(':memory:');
    const source = rollingSource(state);
    const consumerUnderTest = rollingConsumer({ store, routes: () => routes, source });

    // Tick 1: cold sync against page 1. The endpoint is now memoized to page 1.
    await expect(consumerUnderTest.sync()).resolves.toEqual({ accepted: 1, verifiedSources: 1, degraded: [] });
    expect(state.introductionReads).toBe(1);
    for (const item of consumerUnderTest.takePending()) consumerUnderTest.acknowledge(item);

    // The peer appends entry 2 and rolls its advertised archive root to page 2.
    routes = routesFor([first, second]);
    state.root = '0000000000000002';

    // Tick 2: SAME process, SAME source object. The memoized page-1 root yields nothing above the
    // high-water mark; the fix re-resolves, sees a different root, and follows it.
    await expect(consumerUnderTest.sync()).resolves.toEqual({ accepted: 1, verifiedSources: 1, degraded: [] });
    expect(consumerUnderTest.takePending().map((item) => item.card.chain.taskId)).toEqual([2n]);
    expect(consumerUnderTest.checkpoint({ agent: AGENT, name: SOURCE_NAME })).toMatchObject({
      sequence: '0000000000000002',
    });
    // Exactly one extra introduction read, on the tick that observed the roll — not one per tick.
    expect(state.introductionReads).toBe(2);
  });

  it('does not re-read the introduction on a steady-state tick that has nothing new', async () => {
    const first = entry('0000000000000001', null, DIGEST_A);
    const state = { root: '0000000000000001', introductionReads: 0 };
    const routes = routesFor([first]);
    const consumerUnderTest = rollingConsumer({
      store: new Store(':memory:'),
      routes: () => routes,
      source: rollingSource(state),
    });

    await expect(consumerUnderTest.sync()).resolves.toMatchObject({ accepted: 1 });
    await expect(consumerUnderTest.sync()).resolves.toMatchObject({ accepted: 0 });
    await expect(consumerUnderTest.sync()).resolves.toMatchObject({ accepted: 0 });
    expect(state.introductionReads).toBe(1);
  });

  it('STILL refuses `advertised-head-entry-mismatch` when the introduction has not rolled', async () => {
    const first = entry('0000000000000001', null, DIGEST_A);
    const second = entry('0000000000000002', sealJson(first).digest, DIGEST_B);
    const state = { root: '0000000000000002', introductionReads: 0 };
    const routes = routesFor([first, second]);
    // The head advertises an entry the served pages do not terminate on: real equivocation.
    routes.set(`${ROOT}${headPath(SOURCE_NAME)}`, wireHead({ ...head(second), entry: sealJson(first).digest }));
    const consumerUnderTest = rollingConsumer({
      store: new Store(':memory:'),
      routes: () => routes,
      source: rollingSource(state),
    });

    await expect(consumerUnderTest.sync()).rejects.toMatchObject({
      reason: 'advertised-head-entry-mismatch',
    });
    expect(consumerUnderTest.checkpoint({ agent: AGENT, name: SOURCE_NAME })).toBeUndefined();
    // It tried the re-resolve exactly once, then refused rather than looping.
    expect(state.introductionReads).toBe(2);
  });

  it('STILL refuses when the introduction HAS rolled but the new root also misses the advertised head', async () => {
    const first = entry('0000000000000001', null, DIGEST_A);
    const second = entry('0000000000000002', sealJson(first).digest, DIGEST_B);
    const state = { root: '0000000000000001', introductionReads: 0 };
    let routes = routesFor([first]);
    const consumerUnderTest = rollingConsumer({
      store: new Store(':memory:'),
      routes: () => routes,
      source: rollingSource(state),
    });

    // Tick 1 pins the endpoint to page 1, exactly as the roll case above does.
    await expect(consumerUnderTest.sync()).resolves.toMatchObject({ accepted: 1 });
    for (const item of consumerUnderTest.takePending()) consumerUnderTest.acknowledge(item);

    // The root really does roll — but the head names an entry the archive does not terminate on.
    // A rolled root is not a licence to accept: following it must not turn equivocation into
    // acceptance, and must not claim in the log to have followed anything.
    routes = routesFor([first, second]);
    routes.set(`${ROOT}${headPath(SOURCE_NAME)}`, wireHead({ ...head(second), entry: DIGEST_C }));
    state.root = '0000000000000002';
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});

    try {
      await expect(consumerUnderTest.sync()).rejects.toMatchObject({
        reason: 'advertised-head-entry-mismatch',
      });
      // The durable checkpoint stays exactly where it was: nothing advanced over the refusal.
      expect(consumerUnderTest.checkpoint({ agent: AGENT, name: SOURCE_NAME })).toMatchObject({
        sequence: '0000000000000001',
      });
      expect(consumerUnderTest.takePending()).toEqual([]);
      expect(state.introductionReads).toBe(2);
      expect(info.mock.calls.flat().join(' ')).not.toContain('rolled its archive page');
    } finally {
      info.mockRestore();
    }
  });
});
