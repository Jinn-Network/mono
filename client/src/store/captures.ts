/**
 * Typed CRUD wrapper around the `pending_captures` SQLite table.
 *
 * Holds capture envelopes in pending review state — i.e. after the OTel
 * pipeline has produced a redacted envelope but before the operator has
 * decided to publish or skip it. The Captures-tab UI (Phase 7) drives
 * the queue; the publish path (Phase 8) drains it.
 *
 * Status lifecycle:
 *   pending → approved (publishedAt + envelopeCid set)
 *   pending → skipped  (skippedAt set; retained for the grace window
 *                       before being purged)
 *
 * Spec: spec/2026-05-07-telemetry-collector-and-task-generator.md §4.4, §4.5
 */
import type { Store } from './store.js';

export interface PendingCaptureInput {
  sessionId: string;
  capturedAt: string; // ISO datetime
  originatingTool: {
    name: string;
    version?: string;
  };
  capturePath: 'A' | 'B' | 'C' | 'D';
  status: 'pending';
  spanCount: number;
  durationMs: number;
  redactedSpanCount: number;
  repoRemoteUrl?: string;
  repoCommitHash?: string;
}

export interface PendingCaptureRow {
  sessionId: string;
  capturedAt: string;
  originatingTool: { name: string; version?: string };
  capturePath: 'A' | 'B' | 'C' | 'D';
  status: 'pending' | 'approved' | 'skipped';
  spanCount: number;
  durationMs: number;
  redactedSpanCount: number;
  repoRemoteUrl?: string;
  repoCommitHash?: string;
  envelopeCid?: string;
  publishedAt?: string;
  skippedAt?: string;
}

interface PendingCapturesDbRow {
  session_id: string;
  captured_at: string;
  originating_tool_name: string;
  originating_tool_version: string | null;
  capture_path: 'A' | 'B' | 'C' | 'D';
  status: 'pending' | 'approved' | 'skipped';
  span_count: number;
  duration_ms: number;
  redacted_span_count: number;
  repo_remote_url: string | null;
  repo_commit_hash: string | null;
  envelope_cid: string | null;
  published_at: string | null;
  skipped_at: string | null;
}

function rowFromDb(row: PendingCapturesDbRow): PendingCaptureRow {
  const out: PendingCaptureRow = {
    sessionId: row.session_id,
    capturedAt: row.captured_at,
    originatingTool: { name: row.originating_tool_name },
    capturePath: row.capture_path,
    status: row.status,
    spanCount: row.span_count,
    durationMs: row.duration_ms,
    redactedSpanCount: row.redacted_span_count,
  };
  if (row.originating_tool_version !== null) {
    out.originatingTool.version = row.originating_tool_version;
  }
  if (row.repo_remote_url !== null) out.repoRemoteUrl = row.repo_remote_url;
  if (row.repo_commit_hash !== null) out.repoCommitHash = row.repo_commit_hash;
  if (row.envelope_cid !== null) out.envelopeCid = row.envelope_cid;
  if (row.published_at !== null) out.publishedAt = row.published_at;
  if (row.skipped_at !== null) out.skippedAt = row.skipped_at;
  return out;
}

export class CapturesStore {
  constructor(private readonly store: Store) {}

  savePending(input: PendingCaptureInput): void {
    this.store.db
      .prepare(
        `INSERT INTO pending_captures (
          session_id, captured_at,
          originating_tool_name, originating_tool_version,
          capture_path, status,
          span_count, duration_ms, redacted_span_count,
          repo_remote_url, repo_commit_hash
        ) VALUES (
          @sessionId, @capturedAt,
          @originatingToolName, @originatingToolVersion,
          @capturePath, @status,
          @spanCount, @durationMs, @redactedSpanCount,
          @repoRemoteUrl, @repoCommitHash
        )`,
      )
      .run({
        sessionId: input.sessionId,
        capturedAt: input.capturedAt,
        originatingToolName: input.originatingTool.name,
        originatingToolVersion: input.originatingTool.version ?? null,
        capturePath: input.capturePath,
        status: input.status,
        spanCount: input.spanCount,
        durationMs: input.durationMs,
        redactedSpanCount: input.redactedSpanCount,
        repoRemoteUrl: input.repoRemoteUrl ?? null,
        repoCommitHash: input.repoCommitHash ?? null,
      });
  }

  listPending(): PendingCaptureRow[] {
    const rows = this.store.db
      .prepare(
        `SELECT * FROM pending_captures
         WHERE status = 'pending'
         ORDER BY captured_at DESC`,
      )
      .all() as PendingCapturesDbRow[];
    return rows.map(rowFromDb);
  }

  markApproved(
    sessionId: string,
    info: { envelopeCid: string; publishedAt: string },
  ): void {
    this.store.db
      .prepare(
        `UPDATE pending_captures
         SET status = 'approved',
             envelope_cid = @envelopeCid,
             published_at = @publishedAt
         WHERE session_id = @sessionId`,
      )
      .run({
        sessionId,
        envelopeCid: info.envelopeCid,
        publishedAt: info.publishedAt,
      });
  }

  markSkipped(sessionId: string, info: { skippedAt: string }): void {
    this.store.db
      .prepare(
        `UPDATE pending_captures
         SET status = 'skipped',
             skipped_at = @skippedAt
         WHERE session_id = @sessionId`,
      )
      .run({ sessionId, skippedAt: info.skippedAt });
  }

  getApproved(sessionId: string): PendingCaptureRow | null {
    const row = this.store.db
      .prepare(
        `SELECT * FROM pending_captures
         WHERE session_id = ? AND status = 'approved'`,
      )
      .get(sessionId) as PendingCapturesDbRow | undefined;
    return row ? rowFromDb(row) : null;
  }

  getSkipped(sessionId: string): PendingCaptureRow | null {
    const row = this.store.db
      .prepare(
        `SELECT * FROM pending_captures
         WHERE session_id = ? AND status = 'skipped'`,
      )
      .get(sessionId) as PendingCapturesDbRow | undefined;
    return row ? rowFromDb(row) : null;
  }
}
