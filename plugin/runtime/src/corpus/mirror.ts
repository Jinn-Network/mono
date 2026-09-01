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
  splitOrigin,
  type AnnouncementEntry,
  type HighWaterMark,
  type HighWaterMarkStore,
  type SourceHead,
  type SourceIdentity,
} from "@jinn-network/record-discovery-protocol";

import type { MirrorSourceConfig } from "../config.js";
import type { RuntimeLogger } from "../logger.js";
import type { CorpusAdmission } from "./admission.js";
import { adaptAnnouncementEntry } from "./announcements.js";
import type { ChainVerification } from "./chain-verification.js";
import { describeError } from "./errors.js";
import type { CorpusFilesystem } from "./fs.js";
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
  readonly fs: CorpusFilesystem;
  readonly storePaths: OpenCorpusMirrorStoreOptions;
  readonly highWaterMarks: HighWaterMarkStore;
  readonly admission: CorpusAdmission;
  readonly chainVerification: ChainVerification;
  readonly transport: Transport;
  readonly log: RuntimeLogger;
}

/**
 * Whether a fetched head names EXACTLY the position and instant already on
 * file, and nothing else.
 *
 * All four facts are load-bearing, and every one of them is what keeps the
 * revalidation path fail-closed:
 *
 * - `origin` must name the source being followed. Revalidation resolves keys
 *   from the head's own origin, so a head that claims another agent must
 *   never be measured against this source's mark.
 * - `sequence` and `entry` must equal the mark. A head naming any other chain
 *   position is making a chain claim -- forward, rewound or forked -- and a
 *   chain claim is `verifySourceChain`'s to judge, not this path's.
 * - `issuedAt` must equal the mark's. A LOWER one is a rollback or a
 *   backdated re-sign and must keep meeting the strict-increase rule; a
 *   HIGHER one is a genuine re-signing at the same position, which this
 *   consumer has not accepted before.
 *
 * ## Two divergences worth naming
 *
 * The operator's equivalent (`sameHead`, `operator/src/daemon/native-discovery.ts`)
 * compares `refreshBy` and the signature bytes too, because it persists a whole
 * signed high-water record. `HighWaterMark` carries only `sequence`/`entry`/
 * `issuedAt`, so this predicate cannot. The residue is narrow: a head with the
 * same position and `issuedAt` but a stretched `refreshBy` is a §5.2-violating
 * re-sign that would be revalidated as fresh -- and minting one needs the
 * source's own currently-valid signing key, which already buys the ability to
 * re-sign correctly. It is not a door an outsider can reach.
 *
 * The other divergence is a gap, not a residue: a head re-signed at the SAME
 * position with a HIGHER `issuedAt` -- which `serve`'s `maintainHead` produces
 * on every idle source at least daily -- is routed to `verifySourceChain` and
 * REFUSED there today. `returningSync` feeds no entries above the mark, so the
 * linkage walk cannot find the head's own cited entry and fails `linkage`
 * before it ever consults the boundary. Both consumers refuse that shape (the
 * operator as `rewound-or-tampered-head`), so closing it is an ecosystem-wide
 * design call -- admit it onto revalidation and advance the mark, or let the
 * walk terminate when the head's entry IS the boundary -- and not one to make
 * silently inside the same-head fix. The refusal itself is pinned protocol-side
 * (`verify/source-chain.test.ts`, "re-signed idle head").
 */
function isUnchangedHead(
  head: SourceHead,
  identity: SourceIdentity,
  mark: HighWaterMark,
): boolean {
  let origin;
  try {
    origin = splitOrigin(head.origin);
  } catch {
    return false;
  }
  return (
    origin.agent === identity.agent &&
    origin.name === identity.name &&
    head.sequence === mark.sequence &&
    head.entry === mark.entry &&
    head.issuedAt === mark.issuedAt
  );
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
      const mark = await options.highWaterMarks.get(identity);
      const firstAdoption = mark === undefined;
      const { entries, head } = await collect(source, counters, signal);

      // An archive polled more often than it re-signs re-serves the head this
      // mirror already accepted. `verifySourceChain` cannot express that: §5.2
      // requires `issuedAt` to strictly increase on every re-signing, so an
      // unchanged head is refused `broken-chain` -- which would sit a healthy
      // mirror red between publishes. Revalidate instead (#3443), which is the
      // same shape `operator/src/daemon/native-discovery.ts` takes.
      if (mark !== undefined && entries.length === 0 && isUnchangedHead(head.head, identity, mark)) {
        const revalidation = await options.chainVerification.revalidateHead({
          source: identity,
          head: head.head,
          ...(head.signature === undefined ? {} : { headSignature: head.signature }),
        });
        if (revalidation.status === "rejected") {
          return {
            source: identity,
            status: "failed",
            ...counters,
            failure: { code: "chain-verification-rejected", message: revalidation.reason },
          };
        }
        // Nothing to adopt and nothing to advance -- and NOT advancing is the
        // point: leaving the persisted `issuedAt` in place keeps it the
        // monotonicity floor the next moving head has to clear.
        options.log.debug("corpus.mirror.head-revalidated", {
          source: `${identity.agent}/${identity.name}`,
          sequence: head.head.sequence,
        });
        return { source: identity, status: "synced", ...counters };
      }

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
        lock = await tryAcquireSyncLock({ path: options.lockPath, fs: options.fs });
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
