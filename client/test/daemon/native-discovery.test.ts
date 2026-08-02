import { describe, expect, it, vi } from 'vitest';
import {
  RECORD_DISCOVERY_VERSION,
  archivePagePath,
  headPath,
  sealJson,
  type AnnouncementEntry,
  type SourceHead,
} from '@jinn-network/record-discovery-protocol';
import type { AnnouncedSubmissionCard } from '@jinn-network/marketplace-pipeline';
import { Store } from '../../src/store/store.js';
import {
  NativeDiscoverySyncError,
  createNativeDiscoveryConsumer,
  type NativeDiscoverySource,
} from '../../src/daemon/native-discovery.js';

const AGENT = 'did:key:zNativeRequester';
const SOURCE_NAME = 'requester';
const ROOT = 'https://requester.example';
const DIGEST_A = `sha256:${'a'.repeat(64)}` as const;
const DIGEST_B = `sha256:${'b'.repeat(64)}` as const;
const DIGEST_C = `sha256:${'c'.repeat(64)}` as const;

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
      record: { kind: 'https://jinn.network/records/submission/1.0', digest },
      facts: { taskDigest: digest, taskProfileUri: 'https://jinn.network/task-profiles/prediction-forecast/1.0' },
    }],
  };
}

function signed(entryValue: AnnouncementEntry) {
  return {
    entry: entryValue,
    signature: {
      payloadType: 'application/vnd.jinn.record-discovery.entry.v1+json',
      payload: 'signed-entry',
      signatures: [{ keyid: 'requester-key', sig: 'signature' }],
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
    signatures: [{ keyid: 'requester-key', sig: 'signature' }],
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
    endpoint: {
      agent: AGENT,
      name: SOURCE_NAME,
      servingRoot: ROOT,
      archiveRootUrl: `${ROOT}${archivePagePath(SOURCE_NAME, String(routes.size - 1).padStart(16, '0'))}`,
    },
    verify,
    verifyHead,
  };
}

function cardFor(sequence: string): AnnouncedSubmissionCard {
  return {
    record: { kind: 'https://jinn.network/records/submission/1.0', digest: DIGEST_A },
    facts: { taskDigest: DIGEST_A, taskProfileUri: 'https://jinn.network/task-profiles/prediction-forecast/1.0' },
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
    now: input.now,
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
    await expect(cold.sync()).resolves.toEqual({ accepted: 2, verifiedSources: 1 });
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
    await expect(restarted.sync()).resolves.toEqual({ accepted: 1, verifiedSources: 1 });
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

    await expect(synced.sync()).resolves.toEqual({ accepted: 2, verifiedSources: 1 });
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
    await expect(synced.sync()).resolves.toEqual({ accepted: 0, verifiedSources: 1 });
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

  it('isolates durable pending cards when two domain consumers share one product database', () => {
    const store = new Store(':memory:');
    const firstSource = source(new Map(), async () => ({ status: 'ok' as const }));
    const secondSource: NativeDiscoverySource = {
      ...firstSource,
      endpoint: { ...firstSource.endpoint, agent: 'did:key:zNativeSolver', name: 'solver' },
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
