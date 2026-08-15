import {
  MEDIA_HEAD,
  RECORD_DISCOVERY_VERSION,
  archivePagePath,
  headPath,
  parseAnnouncementEntry,
  recordDigest,
  recordPath,
  sealJson,
  type AnnouncementEntry,
  type SourceHead,
  type SourceIdentity,
} from '@jinn-network/record-discovery-protocol';
import {
  signAnnouncementEntry,
  signHead,
  type AppendAnnouncementCommand,
  type ArchivePage,
  type DurableSourceAppendIntent,
  type DurableSourceReceipt,
  type DurableSourceSigner,
  type DurableSourceState,
} from '@jinn-network/record-discovery-serve';

/**
 * The requester persists publication intent inside its product association.
 * This compatibility reader pins the exact, lossless mapping of a pre-C6 v1
 * intent into the generic writer command. The generic writer then recovers the
 * append through that association and requester-source.json, without adding a
 * second durable source authority.
 */
export interface RequesterSourcePublicationV1 {
  readonly sequence: string;
  readonly page: string;
  readonly entry: AnnouncementEntry;
  readonly entryDigest: `sha256:${string}`;
  readonly head: SourceHead;
  readonly announcementId: string;
}

export function adaptRequesterSourceV1Publication(input: {
  readonly source: SourceIdentity;
  readonly publication: RequesterSourcePublicationV1;
  readonly recordBytes: Uint8Array;
  readonly recordContentType: string;
}): AppendAnnouncementCommand {
  const publication = input.publication;
  const entry = parseAnnouncementEntry(publication.entry);
  const announcement = entry.announcements[0];
  if (entry.announcements.length !== 1
    || announcement === undefined
    || announcement.action !== 'available') {
    throw new Error('requester source v1 publication must contain one available announcement');
  }
  if (entry.source.agent !== input.source.agent
    || entry.source.name !== input.source.name
    || publication.sequence !== entry.sequence
    || publication.page !== entry.sequence
    || publication.entryDigest !== sealJson(entry).digest
    || publication.announcementId !== announcement.announcementId) {
    throw new Error('requester source v1 publication identity or source position is inconsistent');
  }
  if (publication.head.origin !== `${input.source.agent}/${input.source.name}`
    || publication.head.sequence !== entry.sequence
    || publication.head.entry !== publication.entryDigest
    || publication.head.issuedAt !== entry.timestamp) {
    throw new Error('requester source v1 head does not bind the exact announcement entry');
  }
  if (recordDigest(input.recordBytes) !== announcement.record.digest
    || (announcement.record.mediaType !== undefined
      && announcement.record.mediaType !== input.recordContentType)) {
    throw new Error('requester source v1 publication does not bind the exact record bytes and media type');
  }
  return {
    announcement,
    timestamp: entry.timestamp,
    record: { bytes: input.recordBytes, contentType: input.recordContentType },
  };
}

/**
 * Freezes a pre-C6 requester publication as the generic writer's durable
 * intent. This is a compatibility reader only: the returned transaction is
 * committed and recovered by `createDurableSourceWriter`.
 */
export async function freezeRequesterSourceV1Intent(input: {
  readonly source: SourceIdentity;
  readonly signer: DurableSourceSigner;
  readonly publication: RequesterSourcePublicationV1;
  readonly recordBytes: Uint8Array;
  readonly recordContentType: string;
  readonly previousState: DurableSourceState;
  readonly previousPosition: DurableSourceAppendIntent['previousPosition'];
  readonly previousHeadIssuedAt: string | null;
  readonly expectedStateRevision: string | null;
  readonly previousStateDigest: `sha256:${string}` | null;
  readonly expectedHeadDigest: `sha256:${string}` | null;
}): Promise<DurableSourceAppendIntent> {
  const command = adaptRequesterSourceV1Publication(input);
  const announcement = command.announcement;
  if (announcement.action !== 'available') {
    throw new Error('requester source v1 compatibility intent must be available');
  }
  const signedEntry = await signAnnouncementEntry(input.publication.entry, input.signer);
  const page: ArchivePage = {
    protocol: RECORD_DISCOVERY_VERSION,
    source: input.source.name,
    page: input.publication.page,
    prevArchive: input.previousPosition?.page ?? null,
    entries: [{ entry: input.publication.entry, signature: signedEntry }],
  };
  const pageBytes = sealJson(page).bytes;
  const headEnvelope = await signHead(input.publication.head, input.signer);
  const headBytes = sealJson(headEnvelope).bytes;
  const fingerprint = sealJson({
    source: input.source,
    timestamp: command.timestamp,
    announcement,
    recordContentType: input.recordContentType,
  }).digest;
  const record = {
    digest: announcement.record.digest,
    path: recordPath(announcement.record.digest),
    contentType: input.recordContentType,
  };
  const receipt: DurableSourceReceipt = {
    source: input.source,
    announcementId: announcement.announcementId,
    fingerprint,
    sequence: input.publication.sequence,
    entryDigest: input.publication.entryDigest,
    page: input.publication.page,
    record,
  };
  const nextState: DurableSourceState = {
    ...input.previousState,
    last: {
      sequence: input.publication.sequence,
      entryDigest: input.publication.entryDigest,
      page: input.publication.page,
    },
    announcements: {
      ...input.previousState.announcements,
      [announcement.announcementId]: { action: 'available', fingerprint, receipt },
    },
  };
  return {
    version: 1,
    source: input.source,
    signerKeyId: input.signer.keyId,
    announcementId: announcement.announcementId,
    fingerprint,
    expectedStateRevision: input.expectedStateRevision,
    previousStateDigest: input.previousStateDigest,
    previousPosition: input.previousPosition,
    expectedHeadDigest: input.expectedHeadDigest,
    previousHeadIssuedAt: input.previousHeadIssuedAt,
    record,
    page: {
      path: archivePagePath(input.source.name, input.publication.page),
      contentType: 'application/json',
      digest: recordDigest(pageBytes),
      bytesBase64: Buffer.from(pageBytes).toString('base64'),
    },
    head: {
      path: headPath(input.source.name),
      contentType: MEDIA_HEAD,
      digest: recordDigest(headBytes),
      bytesBase64: Buffer.from(headBytes).toString('base64'),
    },
    nextState,
    receipt,
  };
}
