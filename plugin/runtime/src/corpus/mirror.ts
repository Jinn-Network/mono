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
 * How a fetched head relates to the chain position already on file, when the
 * walk above the mark yielded nothing.
 *
 * `"unchanged"` is the archive re-serving the exact head this consumer already
 * accepted; `"re-signed"` is the same chain position re-signed at a later
 * instant. §5.2 obliges a live source to re-sign an idle head before
 * `refreshBy` expires, and `serve` ships `maintainHead` for exactly that. The
 * operator's projector loop now honours that obligation for the requester
 * source it serves (#2549), so the shape arrives from in-tree publishers as
 * well as from conformant external ones; the solver/evaluator sources written
 * through `serve`'s durable source writer still re-sign only on append.
 * Both are revalidation's to judge (#3443, #3468); `undefined` means the head
 * is making a chain claim, which is `verifySourceChain`'s to judge and never
 * this path's.
 *
 * Every fact below is load-bearing, and every one of them is what keeps the
 * revalidation path fail-closed:
 *
 * - `origin` must name the source being followed. Revalidation resolves keys
 *   from the head's own origin, so a head that claims another agent must never
 *   be measured against this source's mark.
 * - `sequence` and `entry` must equal the mark. A head naming any other chain
 *   position -- forward, rewound or forked -- is a chain claim.
 * - `issuedAt` must not go backwards. A LOWER (or unparseable) one is a
 *   rollback or a backdated re-sign and must keep meeting the strict-increase
 *   rule inside `verifySourceChain`; an EQUAL one is the unchanged head; a
 *   HIGHER one is the honest idle re-sign.
 *
 * ## The mark advances for a re-sign, and that is the point (#3468)
 *
 * `issuedAt` on the mark is the strict-increase floor. An accepted re-sign
 * raises it, so the head it replaced -- byte-identical to one this consumer
 * once accepted -- is a REGRESSION at the next poll and takes the chain path,
 * where §5.2 refuses it. Leaving the floor behind would keep an
 * indefinitely-replayable window open at that position. The mark's POSITION
 * (`sequence`/`entry`) is untouched: nothing was adopted.
 *
 * ## Two divergences worth naming
 *
 * The operator's equivalent (`sameHead`, `operator/src/daemon/native-discovery.ts`)
 * compares `refreshBy` and the signature bytes too, because it persists a whole
 * signed high-water record. `HighWaterMark` carries only `sequence`/`entry`/
 * `issuedAt`, so this predicate cannot. What that leaves is now bounded rather
 * than merely narrow: a head with the same position and `issuedAt` but a
 * stretched `refreshBy` still reaches revalidation, and `verifySourceHead`
 * refuses it there once the window breaks the published-source profile's §5.2
 * rules (#3467) -- whether the stretch arrived by re-signing (the shape this
 * path now admits, above) or was baked into the original head at adoption.
 * Stretching `issuedAt` instead does not evade it: the same check bounds
 * `issuedAt` against the consumer's own clock, so both halves of the window
 * are bounded, not just their difference. Inside the bound the divergence is a
 * scheduling difference, not a trust one.
 *
 * The second divergence is one of shape: this consumer classifies only after
 * the walk yielded nothing (`entries.length === 0` at the call site), while
 * the operator classifies from the head alone and never walks. A source whose
 * archive holds entries ABOVE its advertised head therefore fails here and
 * reads as a clean idle poll there. Both are fail-closed; they are not
 * identical.
 */
function classifyIdleHead(
  head: SourceHead,
  identity: SourceIdentity,
  mark: HighWaterMark,
): "unchanged" | "re-signed" | undefined {
  let origin;
  try {
    origin = splitOrigin(head.origin);
  } catch {
    return undefined;
  }
  if (origin.agent !== identity.agent || origin.name !== identity.name) return undefined;
  if (head.sequence !== mark.sequence || head.entry !== mark.entry) return undefined;
  if (head.issuedAt === mark.issuedAt) return "unchanged";
  // An unparseable instant on either side yields NaN, and every comparison
  // with NaN is false -- so a malformed head takes the chain path with the
  // rollback and the backdated re-sign, without a separate guard.
  return new Date(head.issuedAt).getTime() > new Date(mark.issuedAt).getTime()
    ? "re-signed"
    : undefined;
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
  ): Promise<{
    readonly entries: SyncedEntry[];
    readonly truncated: boolean;
    readonly head: Awaited<ReturnType<typeof fetchHead>>;
  }> {
    const endpoint: SourceEndpoint = {
      agent: source.agent,
      name: source.name,
      servingRoot: source.servingRoot,
      archiveRootUrl: source.archiveRootUrl,
    };
    // The signal reaches the NETWORK READ, not just the loop below it. A
    // deadline consulted only between walked entries bounds nothing: a peer
    // that accepts the connection and never answers holds this call inside a
    // single read forever, and `fetchHead` is the first read of the cycle --
    // before any between-entry check exists to run (#3222).
    const head = await fetchHead(endpoint, options.transport, signal);
    const mark = await options.highWaterMarks.get({ agent: source.agent, name: source.name });
    const ports = { transport: options.transport, ...(signal === undefined ? {} : { signal }) };
    const walk =
      mark === undefined
        ? coldSync(endpoint, ports)
        : returningSync(endpoint, { sequence: mark.sequence, entry: mark.entry }, ports);

    const entries: SyncedEntry[] = [];
    // Set only when an entry the walk had already produced is abandoned, so a
    // walk that simply ran out is never reported as cut (#3252).
    let truncated = false;
    for await (const synced of walk) {
      if (signal?.aborted === true || counters.entriesWalked >= options.maxEntriesPerSync) {
        truncated = true;
        break;
      }
      counters.entriesWalked += 1;
      entries.push(synced);
    }
    return { entries, truncated, head };
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
      const { entries, truncated, head } = await collect(source, counters, signal);

      // An archive polled more often than it appends re-serves the chain
      // position this mirror already accepted -- byte-identical if the poll
      // outran the re-signing, re-signed at a later instant if it did not
      // (§5.2 obliges a live source to re-sign an idle head; see
      // `classifyIdleHead` on why nothing in this tree does it yet).
      // `verifySourceChain` can express neither: §5.2 requires `issuedAt` to
      // strictly increase, so the unchanged head is refused
      // `issued-at-monotonicity`, and the re-signed one clears that only to
      // fail `linkage` -- the walk above the mark is fed no entries, so the
      // head's own cited entry is absent from the fed set. Either way a
      // healthy mirror would sit red between publishes. Revalidate instead
      // (#3443, #3468), the same shape `operator/src/daemon/native-discovery.ts`
      // takes.
      // A cut walk is never an idle poll: the entries it abandoned sit above
      // the mark whatever the head says, so it belongs on the verification
      // path where the truncation is judged, not on the revalidation one where
      // it would read as a clean no-op (#3252).
      const idle =
        mark === undefined || entries.length !== 0 || truncated
          ? undefined
          : classifyIdleHead(head.head, identity, mark);
      if (mark !== undefined && idle !== undefined) {
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
        if (idle === "re-signed") {
          // Nothing is adopted, so the POSITION does not move -- but the
          // instant does: the accepted re-sign is the new monotonicity floor,
          // which is what makes the head it replaced a regression rather than
          // an indefinitely replayable byte-identical head.
          await options.highWaterMarks.put(identity, {
            sequence: mark.sequence,
            entry: mark.entry,
            issuedAt: head.head.issuedAt,
          });
        }
        options.log.debug("corpus.mirror.head-revalidated", {
          source: `${identity.agent}/${identity.name}`,
          sequence: head.head.sequence,
          head: idle,
        });
        return { source: identity, status: "synced", ...counters };
      }

      const verification = await options.chainVerification.verify({
        source: identity,
        head: head.head,
        ...(head.signature === undefined ? {} : { headSignature: head.signature }),
        entries,
        truncated,
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
