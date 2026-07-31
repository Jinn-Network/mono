// SPDX-License-Identifier: Apache-2.0
import type { ExecutionEvidenceProjection } from "@jinn-network/evidence-discovery";
import type { LocalEvidenceRuntime } from "@jinn-network/evidence-local-runtime";
import type {
  EvidenceRecordReference,
  Sha256Digest,
} from "@jinn-network/evidence-repository";
import type { Span } from "@jinn-network/evidence-trajectory";

import { loadTrajectoryRecord, trajectoryReferenceFromRecordBytes } from "../capture/link.js";
import type { CorpusReader } from "../corpus/read.js";
import type { CorpusRetrieval } from "../corpus/retrieve.js";
import { excerptsFromSpans } from "./excerpts-local.js";
import { excerptsFromRetrieval } from "./excerpts-public.js";
import {
  MAX_SUMMARY_CHARS,
  type IndexableRecord,
  type IndexReceipt,
  type RelevanceIndex,
} from "./index-store.js";
import { extractArtifactText } from "./text.js";
import type { TraceSpanSource } from "./trace-decode-adapter.js";

const PAGE_SIZE = 100;

export interface IndexingDeps {
  readonly index: RelevanceIndex;
  readonly spanSource: TraceSpanSource;
  /** Injected: the archive is exclusively locked, so the caller owns the lifetime policy. */
  readonly openLocalRuntime: () => Promise<LocalEvidenceRuntime>;
  readonly corpusReader?: CorpusReader;
  readonly corpusRetrieval?: CorpusRetrieval;
}

export interface IndexingReport {
  readonly indexed: number;
  readonly excludedRecords: number;
  readonly excludedExcerpts: number;
  readonly skipped: number;
  readonly excludedByTrust: number;
}

const EMPTY_REPORT: IndexingReport = Object.freeze({
  indexed: 0,
  excludedRecords: 0,
  excludedExcerpts: 0,
  skipped: 0,
  excludedByTrust: 0,
});

function merge(left: IndexingReport, right: Partial<IndexingReport>): IndexingReport {
  return {
    indexed: left.indexed + (right.indexed ?? 0),
    excludedRecords: left.excludedRecords + (right.excludedRecords ?? 0),
    excludedExcerpts: left.excludedExcerpts + (right.excludedExcerpts ?? 0),
    skipped: left.skipped + (right.skipped ?? 0),
    excludedByTrust: left.excludedByTrust + (right.excludedByTrust ?? 0),
  };
}

function fromReceipt(receipt: IndexReceipt): Partial<IndexingReport> {
  return {
    indexed: receipt.status === "indexed" ? 1 : 0,
    excludedRecords: receipt.status === "excluded-record" ? 1 : 0,
    excludedExcerpts: receipt.excluded.filter((entry) => entry.scope === "excerpt").length,
  };
}

function firstLine(text: string): string {
  return text.split("\n")[0]?.slice(0, MAX_SUMMARY_CHARS).trim() ?? "";
}

/**
 * One local record, from a runtime the caller already holds open. Returns `undefined` when
 * the record cannot be made indexable — a missing task artifact means no summary, and a
 * record with no summary has nothing to attribute an excerpt to.
 */
async function indexableFromLocal(
  runtime: LocalEvidenceRuntime,
  projection: ExecutionEvidenceProjection,
  spanSource: TraceSpanSource,
): Promise<IndexableRecord | undefined> {
  const taskBytes = await runtime.repository.getArtifact({
    digest: projection.task.digest,
  });
  if (taskBytes === null) return undefined;
  const summary = firstLine(extractArtifactText(taskBytes, projection.task.mediaType));
  if (summary.length === 0) return undefined;

  const feedBytes = await runtime.repository.getArtifact({
    digest: projection.nativeTrace.digest,
  });

  let excerpts: IndexableRecord["excerpts"] = [];
  if (feedBytes !== null) {
    const recordBytes = await runtime.repository.getRecord(projection.reference);
    const trajectoryReference =
      recordBytes === null ? null : trajectoryReferenceFromRecordBytes(recordBytes);
    let spans: readonly Span[] = trajectoryReference === null
      ? []
      : (await loadTrajectoryRecord(runtime.repository, trajectoryReference)).spans;
    if (spans.length === 0) {
      // No producer-side trajectory: fall back to decoding the declared native trace.
      spans = spanSource.spansFor({
        bytes: feedBytes,
        nativeTraceDigest: projection.nativeTrace.digest as Sha256Digest,
        nativeTraceName: projection.nativeTrace.entityId,
      });
    }
    excerpts = excerptsFromSpans({
      spans,
      feedBytes,
      sourceEntityId: projection.nativeTrace.entityId,
      sourceDigest: projection.nativeTrace.digest as Sha256Digest,
    });
  }

  return {
    plane: "local",
    reference: projection.reference,
    summary,
    origin: projection.executorId,
    capturedAt: projection.startedAt,
    outcome: projection.outcome,
    excerpts,
  };
}

/** Every execution record in the operator's own archive. Opens and closes the archive. */
export async function indexLocalPlane(deps: IndexingDeps): Promise<IndexingReport> {
  const runtime = await deps.openLocalRuntime();
  let report = EMPTY_REPORT;
  try {
    let cursor: string | undefined;
    do {
      const page = await runtime.catalog.findExecutions({ limit: PAGE_SIZE, ...(cursor === undefined ? {} : { cursor }) });
      for (const projection of page.items) {
        const indexable = await indexableFromLocal(runtime, projection, deps.spanSource);
        if (indexable === undefined) {
          report = merge(report, { skipped: 1 });
          continue;
        }
        report = merge(report, fromReceipt(await deps.index.put(indexable)));
      }
      cursor = page.nextCursor;
    } while (cursor !== undefined);
  } finally {
    await runtime.close();
  }
  return report;
}

/** One freshly captured record — the post-`sealSession` path C7 calls. */
export async function indexLocalRecord(
  deps: IndexingDeps,
  reference: EvidenceRecordReference,
): Promise<IndexReceipt | undefined> {
  const runtime = await deps.openLocalRuntime();
  try {
    // `findExecutions` orders by start time descending, so a freshly sealed record is on
    // the first page. Paging on is the correct fallback for a record sealed some time ago.
    let cursor: string | undefined;
    do {
      const page = await runtime.catalog.findExecutions({
        limit: PAGE_SIZE,
        ...(cursor === undefined ? {} : { cursor }),
      });
      const projection = page.items.find(
        (candidate) => candidate.reference.digest === reference.digest,
      );
      if (projection !== undefined) {
        const indexable = await indexableFromLocal(runtime, projection, deps.spanSource);
        return indexable === undefined ? undefined : await deps.index.put(indexable);
      }
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    return undefined;
  } finally {
    await runtime.close();
  }
}

/**
 * Every mirrored public record. Reads whatever the mirror currently holds and never
 * triggers a sync — C5's reader deliberately holds no mirror, so "sync never blocks
 * pickup" is structural rather than a convention this function has to remember.
 */
export async function indexPublicPlane(deps: IndexingDeps): Promise<IndexingReport> {
  const reader = deps.corpusReader;
  const retrieval = deps.corpusRetrieval;
  if (reader === undefined || retrieval === undefined) {
    // No corpus configured means nothing was excluded by trust. Recording zero rather than
    // returning early keeps a stale count from an earlier configuration out of the doctor,
    // where it would name a cause that no longer exists.
    deps.index.recordTrustExclusions(0);
    return EMPTY_REPORT;
  }

  let report = EMPTY_REPORT;
  let cursor: string | undefined;
  do {
    const page = await reader.listRecords({
      family: "execution-evidence",
      limit: PAGE_SIZE,
      ...(cursor === undefined ? {} : { cursor }),
    });
    report = merge(report, { excludedByTrust: page.excludedByTrust });

    for (const candidate of page.items) {
      const outcome = await retrieval.fetchRecord(candidate.reference, {
        artifacts: {
          selections: [
            { selector: { kind: "role", role: "task" }, requirement: "optional" },
            { selector: { kind: "role", role: "result" }, requirement: "optional" },
            { selector: { kind: "role", role: "native-trace" }, requirement: "optional" },
          ],
        },
      });
      if (outcome.status !== "fetched") {
        report = merge(report, { skipped: 1 });
        continue;
      }

      const projection = candidate.projection as ExecutionEvidenceProjection;
      const extracted = excerptsFromRetrieval(outcome.result, {
        spanSource: deps.spanSource,
      });
      if (extracted.summary.length === 0) {
        report = merge(report, { skipped: 1 });
        continue;
      }

      report = merge(
        report,
        fromReceipt(
          await deps.index.put({
            plane: "public",
            reference: candidate.reference,
            summary: extracted.summary,
            origin: projection.executorId,
            capturedAt: projection.startedAt,
            outcome: projection.outcome,
            excerpts: extracted.excerpts,
          }),
        ),
      );
    }
    cursor = page.nextCursor;
  } while (cursor !== undefined);

  // Persisted at the end of the pass, as the pass's total. A crash mid-pass leaves the
  // previous value, which is stale but never invents an exclusion that did not happen.
  deps.index.recordTrustExclusions(report.excludedByTrust);
  return report;
}

/** Both planes, in local-then-public order. The index is a cache; this repopulates it. */
export async function rebuildIndex(deps: IndexingDeps): Promise<IndexingReport> {
  const local = await indexLocalPlane(deps);
  const remote = await indexPublicPlane(deps);
  return merge(local, remote);
}
