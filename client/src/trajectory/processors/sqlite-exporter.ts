/**
 * Custom OTel SpanProcessor that persists capture-bound spans to SQLite.
 *
 * Capture-bound spans are those carrying a `jinn.session.id` attribute. They
 * land in the `capture_spans` table (keyed by sessionId + spanId) and the
 * corresponding `pending_captures` row's aggregate counters
 * (span_count, redacted_span_count, duration_ms) are updated per-span.
 *
 * Out of scope for Phase 2: solver-bound spans (`jinn.task.id`). Those are
 * still served by the in-memory TrajectoryCollector; migration to the SDK
 * pipeline is a later phase.
 *
 * Spans whose session has no `pending_captures` row are silently dropped
 * (e.g. session ended after the queue drained). This keeps the exporter
 * idempotent and race-free without requiring foreign-key cascades.
 *
 * Spec: spec/2026-05-07-telemetry-collector-and-task-generator.md §4.3
 */
import { ReadableSpan, SpanProcessor } from '@opentelemetry/sdk-trace-base';
import type { CapturesStore } from '../../store/captures.js';
import { SENTINEL_PATTERN } from './sentinel.js';

export const SQLITE_EXPORTER_VERSION = '1.0.0';

export interface SqliteExporterConfig {
  captures: CapturesStore;
}

export class SqliteExporterProcessor implements SpanProcessor {
  constructor(private readonly cfg: SqliteExporterConfig) {}

  forceFlush() { return Promise.resolve(); }
  shutdown() { return Promise.resolve(); }
  onStart() {}

  onEnd(span: ReadableSpan): void {
    const sessionId = span.attributes['jinn.session.id'];
    if (typeof sessionId !== 'string') return;  // out of scope: solver flows

    // Skip spans whose session has no pending row (e.g. session ended
    // after queue drain, or capture was already approved/skipped).
    const pending = this.cfg.captures.listPending();
    if (!pending.some((r) => r.sessionId === sessionId)) return;

    // Compute redactedKeys using the same sentinel pattern that
    // ManifestBuilderProcessor uses for the redaction manifest.
    const redactedKeys: string[] = [];
    for (const [k, v] of Object.entries(span.attributes)) {
      if (typeof v === 'string' && SENTINEL_PATTERN.test(v)) redactedKeys.push(k);
    }

    const startNs = BigInt(span.startTime[0]) * 1_000_000_000n + BigInt(span.startTime[1]);
    const endNs = BigInt(span.endTime[0]) * 1_000_000_000n + BigInt(span.endTime[1]);
    const durationMsDelta = Number((endNs - startNs) / 1_000_000n);

    this.cfg.captures.appendSpan({
      sessionId,
      spanId: span.spanContext().spanId,
      traceId: span.spanContext().traceId,
      parentSpanId: span.parentSpanContext?.spanId ?? null,
      name: span.name,
      startTimeUnixNano: startNs.toString(),
      endTimeUnixNano: endNs.toString(),
      attributes: { ...span.attributes },
      redactedKeys,
    });
    this.cfg.captures.incrementSpanCounts(sessionId, {
      spans: 1,
      redactedSpans: redactedKeys.length > 0 ? 1 : 0,
      durationMsDelta,
    });
  }
}
