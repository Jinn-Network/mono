import { randomBytes } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink, writeFile, type FileHandle } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  LOCATION_PROFILE_HTTPS,
  RECORD_DISCOVERY_VERSION,
  RECORD_KINDS,
  archivePagePath,
  formatOrigin,
  formatSequence,
  headPath,
  recordPath,
  sealJson,
  type AnnouncementEntry,
  type SourceHead,
  type SourceIdentity,
} from '@jinn-network/record-discovery-protocol';
import {
  signHead,
  writeRecord,
  writeWellKnownDocument,
} from '@jinn-network/record-discovery-serve';
import {
  createArchiveHttpHandler,
  createFsBlobStore,
  type ArchiveHttpHandler,
} from '@jinn-network/record-discovery-transport-http';
import { signAnnouncementEntry } from '@jinn-network/marketplace-projector';
import type { NativeSolutionPublisherPort } from './native-solution-coordinator.js';

const SOLVER_RECORDS_SOURCE_NAME = 'solver-records';
const SOLVER_RECORDS_OUTPUT_KIND = 'https://jinn.network/records/task-output/1.0';
const SOLVER_RECORDS_DELIVERY_ENVELOPE_KIND = 'https://jinn.network/records/delivery-envelope/1.0';
const JSON_MEDIA_TYPE = 'application/json';

interface PublishedReceipt {
  readonly location: string;
  readonly sequence: string;
  readonly entryDigest: `sha256:${string}`;
}

interface SourceState {
  readonly version: 1;
  readonly source: SourceIdentity;
  readonly last?: {
    readonly sequence: string;
    readonly entryDigest: `sha256:${string}`;
    readonly page: string;
  };
  readonly published: Readonly<Record<string, PublishedReceipt>>;
}

export class NativeSolutionPublisherOwnershipError extends Error {
  override readonly name = 'NativeSolutionPublisherOwnershipError';
}

export interface NativeSolutionPublisher extends NativeSolutionPublisherPort {
  readonly handler: ArchiveHttpHandler;
  close(): Promise<void>;
}

async function readState(path: string): Promise<SourceState | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as SourceState;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function writeState(path: string, state: SourceState): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${randomBytes(8).toString('hex')}`;
  try {
    await writeFile(temporary, `${JSON.stringify(state)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

function recordKind(role: 'output' | 'evidence' | 'delivery' | 'delivery-envelope'): string {
  switch (role) {
    case 'delivery': return RECORD_KINDS.delivery;
    case 'evidence': return RECORD_KINDS.executionEvidence;
    case 'output': return SOLVER_RECORDS_OUTPUT_KIND;
    case 'delivery-envelope': return SOLVER_RECORDS_DELIVERY_ENVELOPE_KIND;
  }
}

async function acquireOwner(rootDir: string, source: SourceIdentity): Promise<{
  readonly handle: FileHandle;
  readonly path: string;
}> {
  await mkdir(rootDir, { recursive: true, mode: 0o700 });
  const path = join(rootDir, '.solution-publisher-owner');
  try {
    const handle = await open(path, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify({ pid: process.pid, source })}\n`, 'utf8');
    await handle.sync();
    return { handle, path };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new NativeSolutionPublisherOwnershipError(
        `native solution source state path already has a lifecycle owner: ${rootDir}`,
      );
    }
    throw error;
  }
}

export async function openNativeSolutionPublisher(input: {
  readonly rootDir: string;
  readonly publicBaseUrl: string;
  readonly source: SourceIdentity;
  readonly signer: {
    readonly keyId: string;
    sign(payload: Uint8Array): Uint8Array;
  };
}): Promise<NativeSolutionPublisher> {
  if (input.source.name !== SOLVER_RECORDS_SOURCE_NAME) {
    throw new Error(`native solution publisher requires the distinct "${SOLVER_RECORDS_SOURCE_NAME}" source name`);
  }
  const baseUrl = input.publicBaseUrl.replace(/\/+$/u, '');
  if (baseUrl.length === 0) throw new Error('native solution publisher publicBaseUrl is required');
  const basePath = new URL(baseUrl).pathname.replace(/\/+$/u, '');
  const owner = await acquireOwner(input.rootDir, input.source);
  const statePath = join(input.rootDir, 'source-state.json');
  const records = createFsBlobStore(join(input.rootDir, 'public'));
  let state = (await readState(statePath)) ?? {
    version: 1 as const,
    source: input.source,
    published: {},
  };
  if (
    state.version !== 1
    || state.source.agent !== input.source.agent
    || state.source.name !== input.source.name
  ) {
    await owner.handle.close();
    await unlink(owner.path).catch(() => undefined);
    throw new NativeSolutionPublisherOwnershipError('native solution source state belongs to a different source identity');
  }
  let closed = false;
  let append = Promise.resolve();
  const scopedSigner = {
    scope: 'jinn:discovery-announcements' as const,
    sign: async (pae: Uint8Array) => [{ keyid: input.signer.keyId, sig: input.signer.sign(pae) }],
  };
  const headSigner = {
    sign: async (pae: Uint8Array) => [{ keyid: input.signer.keyId, sig: input.signer.sign(pae) }],
  };

  const publish: NativeSolutionPublisherPort['publish'] = async (value) => {
    let resolveResult!: (value: PublishedReceipt) => void;
    let rejectResult!: (error: unknown) => void;
    const result = new Promise<PublishedReceipt>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    append = append.then(async () => {
      if (closed) throw new NativeSolutionPublisherOwnershipError('native solution publisher is closed');
      const existing = state.published[value.publication.publicationKey];
      if (existing !== undefined) {
        resolveResult(existing);
        return;
      }
      if (value.publication.sourceId !== formatOrigin(input.source.agent, input.source.name)) {
        throw new Error('solution publication outbox source does not equal the owned source identity');
      }
      if (value.publication.recordDigest !== value.artifact.digest) {
        throw new Error('solution publication digest does not equal the stored artifact digest');
      }
      const written = await writeRecord(records, value.bytes, value.artifact.family);
      if (written.digest !== value.publication.recordDigest) {
        throw new Error('solution public record write returned a different digest');
      }
      const next = state.last === undefined ? 1n : BigInt(state.last.sequence) + 1n;
      const sequence = formatSequence(next);
      const previous = state.last?.entryDigest ?? null;
      const timestamp = value.publication.createdAt;
      const entry: AnnouncementEntry = {
        protocol: RECORD_DISCOVERY_VERSION,
        source: input.source,
        sequence,
        previous,
        timestamp,
        announcements: [{
          announcementId: value.publication.publicationKey,
          action: 'available',
          record: {
            kind: recordKind(value.publication.role),
            digest: value.publication.recordDigest,
            mediaType: value.artifact.family,
          },
          locations: [{
            profile: LOCATION_PROFILE_HTTPS,
            locator: `${baseUrl}${recordPath(value.publication.recordDigest)}`,
          }],
          facts: {
            engagementId: value.publication.engagementId,
            role: value.publication.role,
            family: value.artifact.family,
            ...(value.artifact.name === null ? {} : { name: value.artifact.name }),
          },
        }],
      };
      const entryDigest = sealJson(entry).digest;
      const signedEntry = await signAnnouncementEntry(entry, scopedSigner);
      const page = sequence;
      const pageBytes = sealJson({
        protocol: RECORD_DISCOVERY_VERSION,
        source: input.source.name,
        page,
        prevArchive: state.last?.page ?? null,
        entries: [{ entry, signature: signedEntry }],
      }).bytes;
      await records.put(archivePagePath(input.source.name, page), pageBytes, JSON_MEDIA_TYPE);
      const head: SourceHead = {
        protocol: RECORD_DISCOVERY_VERSION,
        origin: formatOrigin(input.source.agent, input.source.name),
        sequence,
        entry: entryDigest,
        issuedAt: timestamp,
        refreshBy: new Date(Date.parse(timestamp) + 24 * 60 * 60 * 1000).toISOString(),
      };
      const headEnvelope = await signHead(head, headSigner);
      await records.put(
        headPath(input.source.name),
        sealJson(headEnvelope).bytes,
        'application/vnd.jinn.record-discovery.head.v1+json',
      );
      await writeWellKnownDocument(records, {
        protocol: RECORD_DISCOVERY_VERSION,
        sources: [{
          agent: input.source.agent,
          name: input.source.name,
          headPath: headPath(input.source.name),
          archiveRoot: archivePagePath(input.source.name, page),
        }],
      });
      const receipt: PublishedReceipt = {
        location: `${baseUrl}${written.path}`,
        sequence,
        entryDigest,
      };
      state = {
        ...state,
        last: { sequence, entryDigest, page },
        published: { ...state.published, [value.publication.publicationKey]: receipt },
      };
      await writeState(statePath, state);
      resolveResult(receipt);
    }).catch((error) => {
      rejectResult(error);
    });
    return result;
  };

  return {
    sourceId: formatOrigin(input.source.agent, input.source.name),
    publish,
    handler: createArchiveHttpHandler({ reader: records, ...(basePath === '' ? {} : { basePath }) }),
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      await append.catch(() => undefined);
      await owner.handle.close();
      await unlink(owner.path).catch(() => undefined);
    },
  };
}
