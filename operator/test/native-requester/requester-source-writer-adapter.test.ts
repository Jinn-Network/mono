import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  DISCOVERY_SIGNING_SCOPE,
  RECORD_DISCOVERY_VERSION,
  RECORD_KINDS,
  formatOrigin,
  recordDigest,
  sealJson,
  type AnnouncementEntry,
  type SourceHead,
  type SourceIdentity,
} from '@jinn-network/record-discovery-protocol';
import {
  adaptRequesterSourceV1Publication,
  freezeRequesterSourceV1Intent,
} from '../../src/native-requester/requester-source-writer-adapter.js';

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

describe('requester source v1 durable-writer adapter', () => {
  it('maps the product-owned intent losslessly and pins its signed page/head bytes', async () => {
    const source: SourceIdentity = { agent: 'urn:jinn:requester:fixture', name: 'requester' };
    const recordBytes = new TextEncoder().encode('{"submission":"fixture"}');
    const timestamp = '2026-08-03T12:00:00.000Z';
    const entry: AnnouncementEntry = {
      protocol: RECORD_DISCOVERY_VERSION,
      source,
      sequence: '0000000000000001',
      previous: null,
      timestamp,
      announcements: [{
        announcementId: 'native-requester-fixture',
        action: 'available',
        record: {
          kind: RECORD_KINDS.submission,
          digest: recordDigest(recordBytes),
          mediaType: 'application/vnd.jinn.task-execution.submission.v1+json',
        },
        locations: [{
          profile: 'https://spec.jinn.network/record-discovery/location/https/v1',
          locator: `https://requester.test/records/${recordDigest(recordBytes).slice(7)}`,
        }],
        facts: { chainId: '84532', taskId: '17' },
      }],
    };
    const entryDigest = sealJson(entry).digest;
    const head: SourceHead = {
      protocol: RECORD_DISCOVERY_VERSION,
      origin: formatOrigin(source.agent, source.name),
      sequence: entry.sequence,
      entry: entryDigest,
      issuedAt: timestamp,
      refreshBy: '2026-08-04T12:00:00.000Z',
    };
    const command = adaptRequesterSourceV1Publication({
      source,
      publication: {
        sequence: entry.sequence,
        page: entry.sequence,
        entry,
        entryDigest,
        head,
        announcementId: entry.announcements[0]!.announcementId,
      },
      recordBytes,
      recordContentType: 'application/vnd.jinn.task-execution.submission.v1+json',
    });
    const rebuilt: AnnouncementEntry = { ...entry, announcements: [command.announcement] };
    expect(sealJson(rebuilt).bytes).toEqual(sealJson(entry).bytes);

    const scopedSigner = {
      scope: DISCOVERY_SIGNING_SCOPE,
      keyId: 'did:key:requester-fixture',
      async sign() { return [{ keyid: 'did:key:requester-fixture', sig: new Uint8Array([1, 2, 3]) }]; },
      verify() { return true; },
    };
    const frozen = await freezeRequesterSourceV1Intent({
      source,
      signer: scopedSigner,
      publication: {
        sequence: entry.sequence,
        page: entry.sequence,
        entry,
        entryDigest,
        head,
        announcementId: entry.announcements[0]!.announcementId,
      },
      recordBytes,
      recordContentType: 'application/vnd.jinn.task-execution.submission.v1+json',
      previousState: {
        version: 1,
        source,
        signerKeyId: scopedSigner.keyId,
        last: null,
        announcements: {},
      },
      previousPosition: null,
      previousHeadIssuedAt: null,
      expectedStateRevision: null,
      previousStateDigest: null,
      expectedHeadDigest: null,
    });

    expect({
      page: sha256(new Uint8Array(Buffer.from(frozen.page.bytesBase64, 'base64'))),
      head: sha256(new Uint8Array(Buffer.from(frozen.head.bytesBase64, 'base64'))),
    }).toEqual({
      page: 'a96e935e876f71bd0d18f2d0bf54f3102ea2fbdc9d39e056894ec92f4e7edad6',
      head: '6d2a17c062bb1f8d19cb3fc7687a465dc8fba9c37bacb81a7f36455e7d55e2d1',
    });
  });
});

describe('requester source v1 compatibility freeze refuses before anything is durable (#4094)', () => {
  // `createDurableSourceWriter.append` reads its timestamp strictly at the very
  // top (#3482) because admitting a timestamp the head schema will later refuse
  // signs a head, persists the intent, and only THEN fails -- wedging the source
  // behind a `recover()` that replays the same failure. This pre-C6 path does not
  // go through `append`: `createRequesterSourceIntentStore.read()` CASes the
  // returned intent durable BEFORE `commitIntent` runs `assertIntentOwnership`'s
  // strict comparisons. So the same refusal has to happen here, before the freeze
  // returns anything and before it signs.
  const source: SourceIdentity = { agent: 'urn:jinn:requester:fixture', name: 'requester' };
  const recordContentType = 'application/vnd.jinn.task-execution.submission.v1+json';
  const recordBytes = new TextEncoder().encode('{"submission":"fixture"}');

  function publicationAt(issuedAt: string, refreshBy: string) {
    const entry: AnnouncementEntry = {
      protocol: RECORD_DISCOVERY_VERSION,
      source,
      sequence: '0000000000000001',
      previous: null,
      timestamp: issuedAt,
      announcements: [{
        announcementId: 'native-requester-fixture',
        action: 'available',
        record: { kind: RECORD_KINDS.submission, digest: recordDigest(recordBytes), mediaType: recordContentType },
        locations: [{
          profile: 'https://spec.jinn.network/record-discovery/location/https/v1',
          locator: `https://requester.test/records/${recordDigest(recordBytes).slice(7)}`,
        }],
        facts: { chainId: '84532', taskId: '17' },
      }],
    };
    const entryDigest = sealJson(entry).digest;
    const head: SourceHead = {
      protocol: RECORD_DISCOVERY_VERSION,
      origin: formatOrigin(source.agent, source.name),
      sequence: entry.sequence,
      entry: entryDigest,
      issuedAt,
      refreshBy,
    };
    return { sequence: entry.sequence, page: entry.sequence, entry, entryDigest, head, announcementId: entry.announcements[0]!.announcementId };
  }

  function countingSigner() {
    const counter = { signs: 0 };
    return {
      counter,
      signer: {
        scope: DISCOVERY_SIGNING_SCOPE,
        keyId: 'did:key:requester-fixture',
        async sign() { counter.signs += 1; return [{ keyid: 'did:key:requester-fixture', sig: new Uint8Array([1, 2, 3]) }]; },
        verify() { return true; },
      },
    };
  }

  function freeze(
    publication: ReturnType<typeof publicationAt>,
    signer: ReturnType<typeof countingSigner>['signer'],
    previousHeadIssuedAt: string | null = null,
  ) {
    return freezeRequesterSourceV1Intent({
      source,
      signer,
      publication,
      recordBytes,
      recordContentType,
      previousState: { version: 1, source, signerKeyId: signer.keyId, last: null, announcements: {} },
      previousPosition: null,
      previousHeadIssuedAt,
      expectedStateRevision: null,
      previousStateDigest: null,
      expectedHeadDigest: null,
    });
  }

  const cases: readonly (readonly [string, string, string, string])[] = [
    // §5.2 spells `issuedAt`/`refreshBy` as calendar-strict RFC 3339 with a
    // mandatory offset; an offset-less spelling means host-LOCAL time.
    ['an offset-less issuedAt', '2026-08-03T12:00:00.000', '2026-08-04T12:00:00.000Z', 'issuedAt is invalid'],
    ['an offset-less refreshBy', '2026-08-03T12:00:00.000Z', '2026-08-04T12:00:00.000', 'refreshBy is invalid'],
    ['a calendar-impossible issuedAt', '2026-02-30T12:00:00.000Z', '2026-08-04T12:00:00.000Z', 'issuedAt is invalid'],
    ['a refreshBy that does not follow issuedAt', '2026-08-03T12:00:00.000Z', '2026-08-03T12:00:00.000Z', 'refreshBy does not follow issuedAt'],
  ];

  for (const [label, issuedAt, refreshBy, message] of cases) {
    it(`refuses ${label} without signing anything`, async () => {
      const { signer, counter } = countingSigner();
      await expect(freeze(publicationAt(issuedAt, refreshBy), signer)).rejects.toThrow(message);
      expect(counter.signs).toBe(0);
    });
  }

  it('refuses a head that does not advance the previous head, without signing anything', async () => {
    const { signer, counter } = countingSigner();
    await expect(
      freeze(publicationAt('2026-08-03T12:00:00.000Z', '2026-08-04T12:00:00.000Z'), signer, '2026-08-03T12:00:00.000Z'),
    ).rejects.toThrow('does not advance the previous head');
    expect(counter.signs).toBe(0);
  });

  it('refuses an unreadable previous head issuedAt, without signing anything', async () => {
    const { signer, counter } = countingSigner();
    await expect(
      freeze(publicationAt('2026-08-03T12:00:00.000Z', '2026-08-04T12:00:00.000Z'), signer, '2026-08-02T12:00:00.000'),
    ).rejects.toThrow('previous head issuedAt is invalid');
    expect(counter.signs).toBe(0);
  });

  it('leaves a following conforming freeze unaffected -- the refusal wedges nothing', async () => {
    const { signer, counter } = countingSigner();
    await expect(freeze(publicationAt('2026-08-03T12:00:00.000', '2026-08-04T12:00:00.000Z'), signer)).rejects.toThrow();
    expect(counter.signs).toBe(0);

    const frozen = await freeze(publicationAt('2026-08-03T12:00:00.000Z', '2026-08-04T12:00:00.000Z'), signer);
    expect(frozen.announcementId).toBe('native-requester-fixture');
    expect(counter.signs).toBeGreaterThan(0);
  });

  it('admits a leap second, which the §5.2 schema admits', async () => {
    const { signer } = countingSigner();
    const frozen = await freeze(publicationAt('2026-06-30T23:59:60Z', '2026-07-01T23:59:59.000Z'), signer);
    expect(frozen.announcementId).toBe('native-requester-fixture');
  });
});
