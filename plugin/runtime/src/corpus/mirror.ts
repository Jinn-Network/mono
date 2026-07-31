// SPDX-License-Identifier: Apache-2.0

import { createEvidenceIndexer } from "@jinn-network/evidence-discovery/indexer";
import {
  coldSync,
  fetchHead,
  returningSync,
  type SourceEndpoint,
  type SyncedEntry,
  type Transport,
} from "@jinn-network/record-discovery-client";
import {
  sealJson,
  type AnnouncementEntry,
  type HighWaterMarkStore,
  type SourceIdentity,
} from "@jinn-network/record-discovery-protocol";

import type { MirrorSourceConfig } from "../config.js";
import type { RuntimeLogger } from "../logger.js";
import type { CorpusAdmission } from "./admission.js";
import { adaptAnnouncementEntry } from "./announcements.js";
import type { ChainVerification } from "./chain-verification.js";
import { describeError } from "./errors.js";
import { tryAcquireSyncLock } from "./lock.js";
import { createCorpusRepositoryResolver } from "./repositories.js";
import { withCorpusMirrorStore, type OpenCorpusMirrorStoreOptions } from "./store.js";

export type MirrorSyncStatus = "synced" | "skipped-locked" | "partial" | "failed";

export interface MirrorSourceSyncReport {
  readonly source: SourceIdentity;
  readonly status: "synced" | "failed";
  readonly entriesWalked: number;
  readonly indexed: number;
  readonly rejected: number;
  readonly withdrawn: number;
  readonly excluded: number;
  readonly failure?: { readonly code: string; readonly message: string };
}

export interface MirrorSyncOutcome {
  readonly status: MirrorSyncStatus;
  readonly sources: readonly MirrorSourceSyncReport[];
}

export interface CorpusMirror {
  syncOnce(options?: { readonly signal?: AbortSignal }): Promise<MirrorSyncOutcome>;
}

export interface CreateCorpusMirrorOptions {
  readonly sources: readonly MirrorSourceConfig[];
  readonly maxEntriesPerSync: number;
  readonly lockPath: string;
  readonly storePaths: OpenCorpusMirrorStoreOptions;
  readonly highWaterMarks: HighWaterMarkStore;
  readonly admission: CorpusAdmission;
  readonly chainVerification: ChainVerification;
  readonly transport: Transport;
  readonly log: RuntimeLogger;
}

interface Counters {
  entriesWalked: number;
  indexed: number;
  rejected: number;
  withdrawn: number;
  excluded: number;
}

/**
 * The public-corpus mirror.
 *
 * LOCK ORDERING (C3 finding F-C3-8, resolved): the skip-if-held sync lock is
 * taken FIRST and released LAST; the catalog handle is opened INSIDE it and
 * closed before the lock is released. A losing instance discards its attempt
 * before opening anything. Readers (`read.ts`) take no sync lock at all — the
 * catalog is WAL, so a mid-write sync never blocks a pickup.
 *
 * `syncOnce` NEVER THROWS. Every failure — lock I/O, transport, chain
 * verification, a malformed record — is a value in the returned outcome, so a
 * caller can fire it opportunistically and drop the promise.
 */
export function createCorpusMirror(options: CreateCorpusMirrorOptions): CorpusMirror {
  async function collect(
    source: MirrorSourceConfig,
    counters: Counters,
    signal: AbortSignal | undefined,
  ): Promise<{ readonly entries: SyncedEntry[]; readonly head: Awaited<ReturnType<typeof fetchHead>> }> {
    const endpoint: SourceEndpoint = {
      agent: source.agent,
      name: source.name,
      servingRoot: source.servingRoot,
      archiveRootUrl: source.archiveRootUrl,
    };
    const head = await fetchHead(endpoint, options.transport);
    const mark = await options.highWaterMarks.get({ agent: source.agent, name: source.name });
    const walk =
      mark === undefined
        ? coldSync(endpoint, { transport: options.transport })
        : returningSync(
            endpoint,
            { sequence: mark.sequence, entry: mark.entry },
            { transport: options.transport },
          );

    const entries: SyncedEntry[] = [];
    for await (const synced of walk) {
      if (signal?.aborted === true) break;
      if (counters.entriesWalked >= options.maxEntriesPerSync) break;
      counters.entriesWalked += 1;
      entries.push(synced);
    }
    return { entries, head };
  }

  async function syncSource(
    source: MirrorSourceConfig,
    indexer: ReturnType<typeof createEvidenceIndexer>,
    signal: AbortSignal | undefined,
  ): Promise<MirrorSourceSyncReport> {
    const identity: SourceIdentity = { agent: source.agent, name: source.name };
    const counters: Counters = {
      entriesWalked: 0,
      indexed: 0,
      rejected: 0,
      withdrawn: 0,
      excluded: 0,
    };

    try {
      const firstAdoption = (await options.highWaterMarks.get(identity)) === undefined;
      const { entries, head } = await collect(source, counters, signal);

      const verification = await options.chainVerification.verify({
        source: identity,
        head: head.head,
        ...(head.signature === undefined ? {} : { headSignature: head.signature }),
        entries,
        firstAdoption,
      });
      if (verification.status === "rejected") {
        return {
          source: identity,
          status: "failed",
          ...counters,
          failure: { code: "chain-verification-rejected", message: verification.reason },
        };
      }

      let latest: AnnouncementEntry | undefined;
      for (const synced of entries) {
        const adaptation = adaptAnnouncementEntry(synced.entry, source, options.admission);
        counters.excluded += adaptation.excluded.length;

        for (const announcement of adaptation.announcements) {
          try {
            const result = await indexer.index(
              announcement,
              signal === undefined ? undefined : { signal },
            );
            if (result.status === "indexed") counters.indexed += 1;
            else if (result.status === "rejected") counters.rejected += 1;
            else counters.withdrawn += 1;
          } catch (error) {
            // One unfetchable or nonconforming record must not wedge the rest
            // of a source's entries.
            counters.rejected += 1;
            options.log.warn("corpus.mirror.index-failed", {
              announcementId: announcement.announcementId,
              message: describeError(error),
            });
          }
        }
        latest = synced.entry;
      }

      if (latest !== undefined) {
        await options.highWaterMarks.put(identity, {
          sequence: latest.sequence,
          entry: sealJson(latest).digest,
          issuedAt: head.head.issuedAt,
        });
      }

      return { source: identity, status: "synced", ...counters };
    } catch (error) {
      return {
        source: identity,
        status: "failed",
        ...counters,
        failure: { code: "source-sync-failed", message: describeError(error) },
      };
    }
  }

  return Object.freeze({
    async syncOnce(operation?: { readonly signal?: AbortSignal }): Promise<MirrorSyncOutcome> {
      let lock;
      try {
        lock = await tryAcquireSyncLock(options.lockPath);
      } catch (error) {
        options.log.warn("corpus.mirror.lock-failed", { message: describeError(error) });
        return { status: "failed", sources: [] };
      }
      if (lock === undefined) return { status: "skipped-locked", sources: [] };

      try {
        return await withCorpusMirrorStore(options.storePaths, async (store) => {
          const indexer = createEvidenceIndexer({
            repositories: createCorpusRepositoryResolver({
              sources: options.sources,
              local: store.repository,
              transport: options.transport,
            }),
            catalog: store.catalog,
          });

          const reports: MirrorSourceSyncReport[] = [];
          for (const source of options.sources) {
            reports.push(await syncSource(source, indexer, operation?.signal));
          }

          const failed = reports.filter((report) => report.status === "failed").length;
          const status: MirrorSyncStatus =
            failed === 0 ? "synced" : failed === reports.length ? "failed" : "partial";
          return { status, sources: reports };
        });
      } catch (error) {
        options.log.error("corpus.mirror.sync-failed", { message: describeError(error) });
        return { status: "failed", sources: [] };
      } finally {
        await lock.close();
      }
    },
  });
}
