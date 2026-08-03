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
          profile: 'https://jinn.network/record-discovery/location/https/1.0',
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
      page: 'fd38d60ebd91c4b3a1940560d5137a9bbdb5d7a34028f2be7c6ecfc5c38c1d7a',
      head: 'e4f091e72fcad096f58c29a9c023e5445ba74c1dc9769e25c6975454381dab94',
    });
  });
});
