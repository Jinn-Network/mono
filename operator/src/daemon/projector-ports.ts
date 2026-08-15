/**
 * Assembles the projector loop's `AnnouncementProjectionPorts` (cutover stage 1, Task 9): a
 * filesystem-backed local archive under `archiveRoot`, the task-execution facts recompute
 * registry, and (for every tick after genesis) an append-aware archive writer — `serve`'s own
 * `writeArchivePages` is genesis/full-history-only (page numbering always starts at one), so an
 * incremental batch needs a host-injected writer that continues the page count instead.
 */
import type {
  AnnouncementEntry,
  ReferencedBytes,
  SourceHead,
  SourceIdentity,
} from '@jinn-network/record-discovery-protocol';
import {
  RECORD_DISCOVERY_VERSION,
  archivePagePath,
  formatSequence,
  headPath,
  sealJson,
} from '@jinn-network/record-discovery-protocol';
import type {
  ArchivePage,
  BlobStore,
  Clock,
  SignedEntry,
} from '@jinn-network/record-discovery-serve';
import { createFsBlobStore } from '@jinn-network/record-discovery-transport-http';
import { TASK_EXECUTION_FACTS_RECOMPUTE } from '@jinn-network/record-discovery-facts-task-execution';
import type {
  AnnouncementProjectionPorts,
  ScopedDiscoverySigner,
} from '@jinn-network/marketplace-projector';

export interface ProjectorPortsInput {
  readonly source: SourceIdentity;
  readonly signer: ScopedDiscoverySigner;
  readonly archiveRoot: string;
  readonly resolveRecord: AnnouncementProjectionPorts['resolveRecord'];
  readonly verifyVerdictObservation: AnnouncementProjectionPorts['verifyVerdictObservation'];
  readonly referencedBytes: ReferencedBytes;
  readonly clock?: Clock;
  /**
   * Persisted archive page count for this source, read/written by the host (the daemon's
   * `Store` config table). Not part of the plan's original produced interface — required to
   * thread `createAppendArchiveWriter`'s continuation state from the host into this pure
   * assembly function; see the Task 9 execution report for the gap this closes.
   */
  readonly readPageCount: () => number;
  readonly writePageCount: (count: number) => void;
}

export function buildAnnouncementProjectionPorts(
  input: ProjectorPortsInput,
  continuation: {
    readonly previousHead?: SourceHead;
    readonly previousEntryDigest?: `sha256:${string}` | null;
    readonly initialSequence?: bigint;
  },
): AnnouncementProjectionPorts {
  const store = createFsBlobStore(input.archiveRoot);
  return {
    source: input.source,
    signer: input.signer,
    store,
    clock: input.clock ?? { now: () => new Date() },
    factsRecompute: TASK_EXECUTION_FACTS_RECOMPUTE,
    referencedBytes: input.referencedBytes,
    resolveRecord: input.resolveRecord,
    verifyVerdictObservation: input.verifyVerdictObservation,
    readPublishedArchive: async () => {
      const entries: AnnouncementEntry[] = [];
      // Read contiguous archive pages instead of trusting only the mutable page-count config:
      // a crash may happen after a page rename but before that separate continuation counter is
      // recorded. Archive paths are immutable and contiguous by construction.
      for (let pageNumber = 1n; ; pageNumber += 1n) {
        const page = formatSequence(pageNumber);
        const stored = await store.get(archivePagePath(input.source.name, page));
        if (stored === undefined) break;
        const parsed = JSON.parse(new TextDecoder().decode(stored.bytes)) as {
          entries?: Array<{ entry?: AnnouncementEntry }>;
        };
        for (const signed of parsed.entries ?? []) {
          if (signed.entry !== undefined) entries.push(signed.entry);
        }
      }
      const storedHead = await store.get(headPath(input.source.name));
      if (storedHead === undefined) return { entries };
      const wire = JSON.parse(new TextDecoder().decode(storedHead.bytes)) as {
        payload?: string;
      };
      const payload = wire.payload === undefined
        ? new TextDecoder().decode(storedHead.bytes)
        : new TextDecoder().decode(Uint8Array.from(atob(wire.payload), (char) => char.charCodeAt(0)));
      return { entries, head: JSON.parse(payload) as SourceHead };
    },
    ...(continuation.previousHead === undefined
      ? {}
      : {
          previousHead: continuation.previousHead,
          previousEntryDigest: continuation.previousEntryDigest ?? null,
          initialSequence: continuation.initialSequence ?? 1n,
          appendArchiveEntries: createAppendArchiveWriter(
            store,
            input.readPageCount,
            input.writePageCount,
          ),
        }),
  };
}

const ARCHIVE_PAGE_CONTENT_TYPE = 'application/json';

/** The append-aware archive writer `projectAnnouncements` requires for incremental batches. */
export function createAppendArchiveWriter(
  store: BlobStore,
  readPageCount: () => number,
  writePageCount: (count: number) => void,
): NonNullable<AnnouncementProjectionPorts['appendArchiveEntries']> {
  return async (input: {
    readonly source: SourceIdentity;
    readonly previousHead: SourceHead;
    readonly entries: readonly SignedEntry[];
  }): Promise<{ readonly pages: string[] }> => {
    const pageCount = readPageCount();
    const page = formatSequence(BigInt(pageCount + 1));
    const prevArchive = pageCount === 0 ? null : formatSequence(BigInt(pageCount));
    const body: ArchivePage = {
      protocol: RECORD_DISCOVERY_VERSION,
      source: input.source.name,
      page,
      prevArchive,
      entries: [...input.entries],
    };
    const { bytes } = sealJson(body);
    await store.put(archivePagePath(input.source.name, page), bytes, ARCHIVE_PAGE_CONTENT_TYPE);
    writePageCount(pageCount + 1);
    return { pages: [page] };
  };
}
