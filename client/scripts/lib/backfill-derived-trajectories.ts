/**
 * backfill-derived-trajectories — one-shot backfill of derived jinn.trajectory.v1
 * records from historical `system_snapshot` transcripts (#1672).
 *
 * Importable core (the tsx entry file wraps this) so tests can drive it with an
 * in-memory Store and skip IPFS/RPC entirely. It:
 *   1. Walks historical system_snapshot artifacts — local `served_artifacts`
 *      first (primary, no I/O deps), then an optional indexer/IPFS second pass
 *      for snapshots not held locally.
 *   2. Extracts the claude-code / codex solve transcript from each snapshot
 *      (hermes is structurally absent from TRANSCRIPT_PATHS — skipped for free).
 *   3. Parses it into spans via the #1473 parsers fed to a fresh
 *      TrajectoryCollector, stamping derivedFrom + backfill-job provenance.
 *   4. Writes derived records to the LOCAL store only, unsigned/unscrubbed at
 *      rest, idempotently keyed by the source snapshot's sha256.
 *   5. On the opt-in publish edge, routes through emitTrajectory with
 *      buildLayer2ScrubPipeline() — scrub-at-altitude runs before any external
 *      write. Local materialization NEVER publishes.
 *
 * No signed/anchored envelope is mutated — every output is a new
 * provenance-linked record in the separate `derived_trajectories` table.
 */

import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hex } from 'viem';
import type { Store, DerivedTrajectoryOutcome } from '../../src/store/store.js';
import {
  untarGz,
  findSolveTranscript,
  extractSnapshotTranscript,
  type SolveTranscript,
} from '../../packages/harness-layer/src/snapshot-transcript.js';
import { TrajectoryCollector, type SpanInput } from '../../src/trajectory/collector.js';
import { ClaudeCodeStreamJsonParser } from '../../src/trajectory/transcript-to-spans/claude-code-stream-json.js';
import { CodexExecJsonParser } from '../../src/trajectory/transcript-to-spans/codex-exec-json.js';
import type { TranscriptSpanParser } from '../../src/trajectory/transcript-to-spans/types.js';
import { emitTrajectory } from '../../src/trajectory/emit.js';
import type { ScrubPipeline } from '../../src/trajectory/scrub/pipeline.js';

const BACKFILL_JOB = 'backfill-derived-trajectories@1.0.0';

export interface BackfillDeps {
  /** Required — local walk source + derived-record sink. */
  store: Store;
  /** Optional indexer/IPFS second pass (both must be present to enable it). */
  listEnvelopeSnapshots?: () => Promise<
    Array<{ envelopeCid: string; snapshotCid: string; sha256: string }>
  >;
  ipfs?: (cid: string) => Promise<unknown>;
  /** Optional publish edge (present ⇒ publish enabled). */
  publish?: {
    signerPrivateKey: Hex;
    signerAddress: `0x${string}`;
    ipfsRegistryUrl: string;
    scrubPipeline: ScrubPipeline;
  };
  /** Injectable clock, defaults to new Date().toISOString(). */
  now?: () => string;
  logger?: (line: string) => void;
  /**
   * Cap on how many source snapshots this run considers (a bounded trial run,
   * per the CLI --limit flag). Counts every snapshot enumerated across the
   * local walk and the indexer pass; unset ⇒ the whole corpus.
   */
  limit?: number;
}

export interface BackfillSummary {
  found: number;
  fetched: number;
  parsed: number;
  skippedUnavailable: number;
  skippedNoTranscript: number;
  alreadyDone: number;
  published: number;
}

const LOCAL_PAGE_SIZE = 500;

function pickParser(harness: SolveTranscript['harness']): TranscriptSpanParser {
  return harness === 'codex' ? new CodexExecJsonParser() : new ClaudeCodeStreamJsonParser();
}

/** Parse a transcript string via the file-path parser API through a temp file. */
async function parseTranscript(transcript: SolveTranscript): Promise<{
  parser: TranscriptSpanParser;
  spans: SpanInput[];
}> {
  const parser = pickParser(transcript.harness);
  const dir = mkdtempSync(join(tmpdir(), 'backfill-transcript-'));
  const path = join(dir, 'stdout.jsonl');
  try {
    writeFileSync(path, transcript.jsonl);
    const spans = await parser.parse(path);
    return { parser, spans };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Record an 'unavailable' skip (source missing or unreadable). Idempotency stamp so re-runs don't retry it. */
function recordUnavailable(
  store: Store,
  summary: BackfillSummary,
  now: () => string,
  source: { sha256: string; envelopeCid: string | null; requestId?: string | null },
): void {
  summary.skippedUnavailable++;
  store.saveDerivedTrajectory({
    sourceSha256: source.sha256,
    sourceEnvelopeCid: source.envelopeCid,
    sourceRequestId: source.requestId ?? null,
    outcome: 'unavailable',
    spanCount: 0,
    createdAt: now(),
  });
}

export async function backfillDerivedTrajectories(
  deps: BackfillDeps,
): Promise<BackfillSummary> {
  const { store } = deps;
  const now = deps.now ?? (() => new Date().toISOString());
  const log = deps.logger ?? (() => {});
  const summary: BackfillSummary = {
    found: 0,
    fetched: 0,
    parsed: 0,
    skippedUnavailable: 0,
    skippedNoTranscript: 0,
    alreadyDone: 0,
    published: 0,
  };

  // How many source snapshots this run may still consider (a bounded trial
  // run). Unset limit ⇒ Infinity ⇒ the whole corpus. Decremented for each
  // snapshot considered across BOTH the local walk and the indexer pass.
  let remaining = deps.limit ?? Infinity;

  // ── Local walk (primary) ──────────────────────────────────────────────
  let before: string | undefined;
  let beforeSha256: string | undefined;
  walk: for (;;) {
    if (remaining <= 0) break;
    const page = store.listServedArtifactMetadata({
      artifactType: 'system_snapshot',
      limit: LOCAL_PAGE_SIZE,
      before,
      beforeSha256,
    });
    if (page.length === 0) break;
    for (const meta of page) {
      if (remaining <= 0) break walk;
      if (store.hasDerivedTrajectory(meta.sha256)) {
        summary.alreadyDone++;
        continue;
      }
      remaining--;
      summary.found++;
      const artifact = store.getServedArtifact(meta.sha256);
      if (!artifact) {
        recordUnavailable(store, summary, now, {
          sha256: meta.sha256,
          envelopeCid: meta.envelopeCid,
          requestId: meta.requestId,
        });
        continue;
      }
      summary.fetched++;
      // Local BLOB is the raw scrubbed tarball (NOT a donation wrapper): untar
      // + find directly, no unwrapDonation (#1672 plan D1).
      let transcript: SolveTranscript | null = null;
      try {
        transcript = findSolveTranscript(untarGz(artifact.content));
      } catch (err) {
        recordUnavailable(store, summary, now, {
          sha256: meta.sha256,
          envelopeCid: meta.envelopeCid,
          requestId: meta.requestId,
        });
        log(`[backfill] ${meta.sha256}: unreadable snapshot — ${(err as Error).message}`);
        continue;
      }
      await processSnapshot({
        deps,
        summary,
        now,
        sourceSha256: meta.sha256,
        sourceEnvelopeCid: meta.envelopeCid,
        sourceRequestId: meta.requestId,
        transcript,
      });
    }
    if (page.length < LOCAL_PAGE_SIZE) break;
    before = page[page.length - 1]!.createdAt;
    beforeSha256 = page[page.length - 1]!.sha256;
  }

  // ── Indexer/IPFS second pass (opt-in) ─────────────────────────────────
  if (deps.listEnvelopeSnapshots && deps.ipfs) {
    const entries = await deps.listEnvelopeSnapshots();
    for (const entry of entries) {
      if (remaining <= 0) break;
      if (store.hasDerivedTrajectory(entry.sha256)) {
        summary.alreadyDone++;
        continue;
      }
      remaining--;
      summary.found++;
      let transcript: SolveTranscript | null = null;
      try {
        const wrapper = await deps.ipfs(entry.snapshotCid);
        summary.fetched++;
        // IPFS path DOES carry the donation wrapper — unwrap it.
        transcript = extractSnapshotTranscript(wrapper, entry.sha256);
      } catch (err) {
        recordUnavailable(store, summary, now, {
          sha256: entry.sha256,
          envelopeCid: entry.envelopeCid,
        });
        log(`[backfill] ${entry.sha256}: IPFS fetch failed — ${(err as Error).message}`);
        continue;
      }
      await processSnapshot({
        deps,
        summary,
        now,
        sourceSha256: entry.sha256,
        sourceEnvelopeCid: entry.envelopeCid,
        sourceRequestId: null,
        transcript,
      });
    }
  }

  return summary;
}

interface ProcessArgs {
  deps: BackfillDeps;
  summary: BackfillSummary;
  now: () => string;
  sourceSha256: string;
  sourceEnvelopeCid: string | null;
  sourceRequestId: string | null;
  transcript: SolveTranscript | null;
}

async function processSnapshot(args: ProcessArgs): Promise<void> {
  const { deps, summary, now, sourceSha256, sourceEnvelopeCid, sourceRequestId, transcript } = args;
  const store = deps.store;
  const derivedFrom = sourceEnvelopeCid ?? sourceSha256;

  // Snapshot had no extractable transcript, or one that parsed to zero spans.
  const recordNoTranscript = (harness?: string): void => {
    summary.skippedNoTranscript++;
    store.saveDerivedTrajectory({
      sourceSha256,
      sourceEnvelopeCid,
      sourceRequestId,
      harness,
      outcome: 'no_transcript',
      spanCount: 0,
      createdAt: now(),
    });
  };

  if (!transcript) {
    recordNoTranscript();
    return;
  }

  const { parser, spans } = await parseTranscript(transcript);
  const runId = `backfill-${sourceSha256.slice(0, 12)}`;
  const collector = new TrajectoryCollector({ taskCid: derivedFrom, runId });
  for (const span of spans) {
    collector.addSpan({
      ...span,
      attributes: {
        ...span.attributes,
        'jinn.transcript.derivedFrom': derivedFrom,
        'jinn.transcript.backfillJob': BACKFILL_JOB,
      },
    });
  }

  const snap = collector.snapshot();
  if (snap.spans.length === 0) {
    // A transcript file existed but yielded no spans (empty/garbage).
    recordNoTranscript(transcript.harness);
    return;
  }

  const blob = {
    schemaVersion: 'jinn.trajectory.v1' as const,
    runId,
    parentEnvelopeCid: null,
    derivedFrom,
    spans: snap.spans,
    redactionManifest: snap.redactionManifest,
  };

  store.saveDerivedTrajectory({
    sourceSha256,
    sourceEnvelopeCid,
    sourceRequestId,
    harness: transcript.harness,
    outcome: 'parsed' satisfies DerivedTrajectoryOutcome,
    spanCount: snap.spans.length,
    trajectoryJson: JSON.stringify(blob),
    parserName: parser.parserName,
    parserVersion: parser.parserVersion,
    createdAt: now(),
  });
  summary.parsed++;

  // Publish edge (opt-in only) — scrub-at-altitude runs before any external write.
  if (deps.publish) {
    const result = await emitTrajectory({
      collector,
      runId,
      derivedFrom,
      parentEnvelopeCid: null,
      scrubPipeline: deps.publish.scrubPipeline,
      signerPrivateKey: deps.publish.signerPrivateKey,
      signerAddress: deps.publish.signerAddress,
      ipfsRegistryUrl: deps.publish.ipfsRegistryUrl,
    });
    store.setDerivedTrajectoryPublishedCid(sourceSha256, result.cid);
    summary.published++;
  }
}
