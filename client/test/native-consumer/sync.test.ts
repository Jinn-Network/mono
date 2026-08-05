import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { DsseEnvelope } from '@jinn-network/trust-core';
import type { Transport } from '@jinn-network/record-discovery-client';
import {
  MEDIA_ENTRY,
  MEDIA_HEAD,
  RECORD_DISCOVERY_VERSION,
  archivePagePath,
  dssePreAuthEncoding,
  formatOrigin,
  headPath,
  sealJson,
} from '@jinn-network/record-discovery-protocol';
import type {
  AnnouncementEntry,
  SourceHead,
  SourceIdentity,
} from '@jinn-network/record-discovery-protocol';
import { ConsumerState } from '../../src/native-consumer/state.js';
import {
  ConsumerSyncError,
  createProtocolSourceVerifier,
  syncPublicSource,
  type PublicSourceVerifier,
} from '../../src/native-consumer/sync.js';

const roots: string[] = [];
const BASE = 'https://requester.example';
const SOURCE: SourceIdentity = { agent: 'did:web:requester.example', name: 'requester' };
const KEY = 'requester-source-key';

async function stateRoot(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), 'jinn-native-consumer-sync-'));
  roots.push(value);
  return value;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((value) => rm(value, { recursive: true, force: true })));
});

function entry(sequence: number, previous: `sha256:${string}` | null, label = String(sequence)): AnnouncementEntry {
  return {
    protocol: RECORD_DISCOVERY_VERSION,
    source: SOURCE,
    sequence: String(sequence).padStart(16, '0'),
    previous,
    timestamp: `2026-08-02T12:00:0${sequence}.000Z`,
    announcements: [{
      announcementId: `announcement-${label}`,
      action: 'available',
      record: {
        kind: 'https://jinn.network/records/submission/1.0',
        digest: `sha256:${label.padEnd(64, label[0] ?? '0').slice(0, 64)}`,
      },
    }],
  } as AnnouncementEntry;
}

function envelope(payloadType: string, value: unknown): DsseEnvelope {
  const bytes = sealJson(value).bytes;
  const pae = dssePreAuthEncoding(payloadType, bytes);
  return {
    payloadType,
    payload: Buffer.from(bytes).toString('base64'),
    signatures: [{ keyid: KEY, sig: Buffer.from(pae.slice(0, 16)).toString('base64') }],
  };
}

function publicSource(entries: readonly AnnouncementEntry[], issuedAt: string): {
  readonly endpoint: { agent: string; name: string; servingRoot: string; archiveRootUrl: string };
  readonly transport: Transport;
  readonly head: SourceHead;
} {
  const latest = entries.at(-1)!;
  const page = '0000000000000001';
  const head: SourceHead = {
    protocol: RECORD_DISCOVERY_VERSION,
    origin: formatOrigin(SOURCE.agent, SOURCE.name),
    sequence: latest.sequence,
    entry: sealJson(latest).digest,
    issuedAt,
    refreshBy: '2026-08-03T12:00:00.000Z',
  };
  const bodies = new Map<string, unknown>([
    [`${BASE}${headPath(SOURCE.name)}`, envelope(MEDIA_HEAD, head)],
    [`${BASE}${archivePagePath(SOURCE.name, page)}`, {
      protocol: RECORD_DISCOVERY_VERSION,
      source: SOURCE.name,
      page,
      prevArchive: null,
      entries: entries.map((value) => ({ entry: value, signature: envelope(MEDIA_ENTRY, value) })),
    }],
  ]);
  return {
    endpoint: {
      agent: SOURCE.agent,
      name: SOURCE.name,
      servingRoot: BASE,
      archiveRootUrl: `${BASE}${archivePagePath(SOURCE.name, page)}`,
    },
    transport: {
      async fetch(url) {
        const body = bodies.get(url);
        if (body === undefined) throw new Error(`unexpected public URL: ${url}`);
        return { status: 200, bytes: sealJson(body).bytes };
      },
    },
    head,
  };
}

function recordingVerifier(calls: Array<{ mode: string; sequences: readonly string[]; common?: string }>): PublicSourceVerifier {
  return {
    async verify(input) {
      calls.push({
        mode: input.mode,
        sequences: input.entries.map((value) => value.entry.sequence),
        ...(input.commonEntry === undefined ? {} : { common: input.commonEntry }),
      });
      return { status: 'ok' };
    },
  };
}

describe('independent public source sync', () => {
  it('cold-syncs, resumes from its durable high-water mark, and does zero entry work when unchanged', async () => {
    const root = await stateRoot();
    const state = await ConsumerState.open(root);
    const first = entry(1, null, '1');
    const second = entry(2, sealJson(first).digest, '2');
    const calls: Array<{ mode: string; sequences: readonly string[] }> = [];
    const verifier = recordingVerifier(calls);

    const v1 = publicSource([first], '2026-08-02T12:01:00.000Z');
    await expect(syncPublicSource({ ...v1, state, verifier })).resolves.toMatchObject({
      mode: 'cold', received: 1, accepted: 1, duplicate: 0, lag: 0,
    });
    state.close();

    const restarted = await ConsumerState.open(root);
    const v2 = publicSource([first, second], '2026-08-02T12:02:00.000Z');
    await expect(syncPublicSource({ ...v2, state: restarted, verifier })).resolves.toMatchObject({
      mode: 'returning', received: 1, accepted: 1, duplicate: 0, lag: 0,
    });
    await expect(syncPublicSource({ ...v2, state: restarted, verifier })).resolves.toMatchObject({
      mode: 'unchanged', received: 0, accepted: 0, duplicate: 0, lag: 0,
    });
    expect(calls.map((call) => [call.mode, call.sequences])).toEqual([
      ['cold', ['0000000000000001']],
      ['returning', ['0000000000000002']],
      ['unchanged', []],
    ]);
    expect(restarted.checkpoint(SOURCE)?.entry).toBe(sealJson(second).digest);
    restarted.close();
  });

  it('rewinds to the latest common signed entry and retains old fork bytes as inactive audit history', async () => {
    const state = await ConsumerState.open(await stateRoot());
    const common = entry(1, null, '1');
    const oldTip = entry(2, sealJson(common).digest, 'a');
    const newTip = entry(2, sealJson(common).digest, 'b');
    const calls: Array<{ mode: string; sequences: readonly string[]; common?: string }> = [];
    const verifier = recordingVerifier(calls);
    await syncPublicSource({ ...publicSource([common, oldTip], '2026-08-02T12:01:00.000Z'), state, verifier });

    await expect(syncPublicSource({
      ...publicSource([common, newTip], '2026-08-02T12:02:00.000Z'),
      state,
      verifier,
    })).resolves.toMatchObject({ mode: 'rewind', received: 2, accepted: 1, duplicate: 1, lag: 0 });

    expect(calls.at(-1)).toMatchObject({ mode: 'rewind', common: sealJson(common).digest });
    const rows = state.entries(SOURCE);
    expect(rows.find((row) => row.digest === sealJson(common).digest)?.active).toBe(true);
    expect(rows.find((row) => row.digest === sealJson(oldTip).digest)?.active).toBe(false);
    expect(rows.find((row) => row.digest === sealJson(newTip).digest)?.active).toBe(true);
    state.close();
  });

  it('keeps a deep active prefix without reactivating an older displaced fork', async () => {
    const state = await ConsumerState.open(await stateRoot());
    const genesis = entry(1, null, '1');
    const firstFork = entry(2, sealJson(genesis).digest, 'a');
    const firstTip = entry(3, sealJson(firstFork).digest, 'c');
    const secondFork = entry(2, sealJson(genesis).digest, 'b');
    const secondTip = entry(3, sealJson(secondFork).digest, 'd');
    const finalTip = entry(3, sealJson(secondFork).digest, 'e');
    const verifier = recordingVerifier([]);

    await syncPublicSource({
      ...publicSource([genesis, firstFork, firstTip], '2026-08-02T12:01:00.000Z'), state, verifier,
    });
    await syncPublicSource({
      ...publicSource([genesis, secondFork, secondTip], '2026-08-02T12:02:00.000Z'), state, verifier,
    });
    await syncPublicSource({
      ...publicSource([genesis, secondFork, finalTip], '2026-08-02T12:03:00.000Z'), state, verifier,
    });

    const rows = state.entries(SOURCE);
    expect(rows.find((row) => row.digest === sealJson(genesis).digest)?.active).toBe(true);
    expect(rows.find((row) => row.digest === sealJson(firstFork).digest)?.active).toBe(false);
    expect(rows.find((row) => row.digest === sealJson(firstTip).digest)?.active).toBe(false);
    expect(rows.find((row) => row.digest === sealJson(secondFork).digest)?.active).toBe(true);
    expect(rows.find((row) => row.digest === sealJson(secondTip).digest)?.active).toBe(false);
    expect(rows.find((row) => row.digest === sealJson(finalTip).digest)?.active).toBe(true);
    state.close();
  });

  it('fails closed before persistence when verification rejects the signed public material', async () => {
    const state = await ConsumerState.open(await stateRoot());
    const source = publicSource([entry(1, null)], '2026-08-02T12:01:00.000Z');
    const verifier: PublicSourceVerifier = {
      async verify() { return { status: 'rejected', reason: 'stale-source-head' }; },
    };
    await expect(syncPublicSource({ ...source, state, verifier })).rejects.toMatchObject<Partial<ConsumerSyncError>>({
      reason: 'stale-source-head',
    });
    expect(state.checkpoint(SOURCE)).toBeUndefined();
    expect(state.entries(SOURCE)).toEqual([]);
    state.close();
  });

  it('adapts durable consumer state to the public protocol verifier and rejects stale or unknown signers', async () => {
    const source = publicSource([entry(1, null)], '2026-08-02T12:01:00.000Z');
    const validState = await ConsumerState.open(await stateRoot());
    const validVerifier = createProtocolSourceVerifier({
      state: validState,
      keys: {
        async resolve() { return [{ keyid: KEY, publicKey: 'test', algorithm: 'test' }]; },
        async everBound(_agent, keyid) { return keyid === KEY; },
      },
      sigs: {
        async verify(pae, signature) {
          return Buffer.from(signature).equals(Buffer.from(pae.slice(0, 16)));
        },
      },
      fresh: { isFresh: (refreshBy, now) => new Date(refreshBy).getTime() > now.getTime() },
      now: () => new Date('2026-08-02T13:00:00.000Z'),
    });
    const sourceEntry = entry(1, null);
    await expect(validVerifier.verify({
      mode: 'cold',
      source: SOURCE,
      head: source.head,
      headSignature: envelope(MEDIA_HEAD, source.head),
      entries: [{ entry: sourceEntry, signature: envelope(MEDIA_ENTRY, sourceEntry) }],
    })).resolves.toEqual({ status: 'ok' });
    expect(validState.checkpoint(SOURCE)).toBeUndefined();
    await expect(syncPublicSource({ ...source, state: validState, verifier: validVerifier })).resolves.toMatchObject({
      mode: 'cold', lag: 0,
    });
    const reSigned = publicSource([entry(1, null)], '2026-08-02T12:02:00.000Z');
    await expect(syncPublicSource({ ...reSigned, state: validState, verifier: validVerifier })).resolves.toMatchObject({
      mode: 'unchanged', received: 0, lag: 0,
    });
    await expect(syncPublicSource({ ...reSigned, state: validState, verifier: validVerifier })).resolves.toMatchObject({
      mode: 'unchanged', received: 0, lag: 0,
    });
    expect(validState.checkpoint(SOURCE)?.issuedAt).toBe('2026-08-02T12:02:00.000Z');
    validState.close();

    const staleState = await ConsumerState.open(await stateRoot());
    const staleVerifier = createProtocolSourceVerifier({
      state: staleState,
      keys: {
        async resolve() { return [{ keyid: KEY, publicKey: 'test', algorithm: 'test' }]; },
        async everBound() { return true; },
      },
      sigs: { async verify() { return true; } },
      fresh: { isFresh: () => false },
      now: () => new Date('2026-08-04T00:00:00.000Z'),
    });
    await expect(syncPublicSource({ ...source, state: staleState, verifier: staleVerifier })).rejects.toMatchObject({
      reason: 'stale-source-head',
    });
    staleState.close();

    const unknownState = await ConsumerState.open(await stateRoot());
    const unknownVerifier = createProtocolSourceVerifier({
      state: unknownState,
      keys: { async resolve() { return []; }, async everBound() { return false; } },
      sigs: { async verify() { return false; } },
      fresh: { isFresh: () => true },
      now: () => new Date('2026-08-02T13:00:00.000Z'),
    });
    await expect(syncPublicSource({ ...source, state: unknownState, verifier: unknownVerifier })).rejects.toMatchObject({
      reason: 'unauthorized-source-signer',
    });
    unknownState.close();
  });
});
