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

export interface SpanInput {
  sessionId: string;
  spanId: string;
  traceId: string;
  parentSpanId: string | null;
  name: string;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: Record<string, unknown>;
  redactedKeys: string[];
}

export interface SpanRow extends SpanInput {}

interface CaptureSpansDbRow {
  session_id: string;
  span_id: string;
  trace_id: string;
  parent_span_id: string | null;
  name: string;
  start_time_unix_nano: string;
  end_time_unix_nano: string;
  attributes_json: string;
  redacted_keys_json: string;
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

  getBySession(sessionId: string): PendingCaptureRow | null {
    const row = this.store.db
      .prepare(
        `SELECT * FROM pending_captures
         WHERE session_id = ?`,
      )
      .get(sessionId) as PendingCapturesDbRow | undefined;
    return row ? rowFromDb(row) : null;
  }

  appendSpan(input: SpanInput): void {
    this.store.db
      .prepare(
        `INSERT INTO capture_spans (
          session_id, span_id, trace_id, parent_span_id,
          name, start_time_unix_nano, end_time_unix_nano,
          attributes_json, redacted_keys_json
        ) VALUES (
          @sessionId, @spanId, @traceId, @parentSpanId,
          @name, @startTimeUnixNano, @endTimeUnixNano,
          @attributesJson, @redactedKeysJson
        )`,
      )
      .run({
        sessionId: input.sessionId,
        spanId: input.spanId,
        traceId: input.traceId,
        parentSpanId: input.parentSpanId,
        name: input.name,
        startTimeUnixNano: input.startTimeUnixNano,
        endTimeUnixNano: input.endTimeUnixNano,
        attributesJson: JSON.stringify(input.attributes),
        redactedKeysJson: JSON.stringify(input.redactedKeys),
      });
  }

  getSpansBySession(sessionId: string): SpanRow[] {
    const rows = this.store.db
      .prepare(
        `SELECT * FROM capture_spans
         WHERE session_id = ?
         ORDER BY start_time_unix_nano ASC, span_id ASC`,
      )
      .all(sessionId) as CaptureSpansDbRow[];
    return rows.map((r) => ({
      sessionId: r.session_id,
      spanId: r.span_id,
      traceId: r.trace_id,
      parentSpanId: r.parent_span_id,
      name: r.name,
      startTimeUnixNano: r.start_time_unix_nano,
      endTimeUnixNano: r.end_time_unix_nano,
      attributes: JSON.parse(r.attributes_json) as Record<string, unknown>,
      redactedKeys: JSON.parse(r.redacted_keys_json) as string[],
    }));
  }

  incrementSpanCounts(
    sessionId: string,
    delta: { spans: number; redactedSpans: number; durationMsDelta: number },
  ): void {
    this.store.db
      .prepare(
        `UPDATE pending_captures
         SET span_count = span_count + @spans,
             redacted_span_count = redacted_span_count + @redactedSpans,
             duration_ms = duration_ms + @durationMsDelta
         WHERE session_id = @sessionId`,
      )
      .run({
        sessionId,
        spans: delta.spans,
        redactedSpans: delta.redactedSpans,
        durationMsDelta: delta.durationMsDelta,
      });
  }
}
