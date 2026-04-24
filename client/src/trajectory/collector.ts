/**
 * TrajectoryCollector — in-memory span accumulator.
 *
 * Invariants (enforced on add):
 *   - span.traceId is shared across all spans in a run (set at construction)
 *   - span.spanId is 16 hex chars unique per span
 *   - span.attributes['jinn.prevSpanHash'] is set to genesis (for first span)
 *     or the keccak256(JCS(previous finalized span)) on add — callers do NOT
 *     set it.
 *   - span.attributes['jinn.span.kind'] MUST be supplied by the caller.
 *   - secrets are scrubbed before the span is appended; redacted keys are
 *     recorded against this span's spanId in the redactionManifest.
 */

import { randomBytes } from 'node:crypto';
import type { Span, RedactionManifest } from './schema.js';
import { computeGenesisHash, computePrevSpanHash } from './hash-chain.js';
import { scrubAttributes } from './secret-scrub.js';

function hex(bytes: number): string {
  return randomBytes(bytes).toString('hex');
}

export interface CollectorInit {
  intentCid: string;
  runId: string;
  /** Override for tests. Defaults to randomBytes(16). */
  traceId?: string;
}

/** Caller-supplied span input. Omits chain + id fields the collector assigns. */
export interface SpanInput {
  name: string;
  kind: Span['kind'];
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: Record<string, unknown>;
  events: Span['events'];
  status: Span['status'];
  parentSpanId?: string | null;
}

export class TrajectoryCollector {
  readonly runId: string;
  readonly intentCid: string;
  private readonly traceId: string;
  private readonly spans: Span[] = [];
  private readonly redactionEntries: RedactionManifest['spans'] = [];
  private totalRedactions = 0;
  private lastSpanHash: string;

  constructor(init: CollectorInit) {
    this.runId = init.runId;
    this.intentCid = init.intentCid;
    this.traceId = init.traceId ?? hex(16);
    this.lastSpanHash = computeGenesisHash(init.intentCid);
  }

  /** Append a span; returns the finalized span (with assigned ids + chain hash). */
  addSpan(input: SpanInput): Span {
    if (typeof input.attributes['jinn.span.kind'] !== 'string') {
      throw new Error('TrajectoryCollector.addSpan: jinn.span.kind attribute required');
    }

    const { scrubbed, redactedKeys } = scrubAttributes(input.attributes);

    const span: Span = {
      traceId: this.traceId,
      spanId: hex(8),
      parentSpanId: input.parentSpanId ?? null,
      name: input.name,
      kind: input.kind,
      startTimeUnixNano: input.startTimeUnixNano,
      endTimeUnixNano: input.endTimeUnixNano,
      attributes: {
        ...scrubbed,
        'jinn.prevSpanHash': this.lastSpanHash,
      },
      events: input.events,
      status: input.status,
    };

    this.spans.push(span);
    this.lastSpanHash = computePrevSpanHash(span);

    if (redactedKeys.length > 0) {
      this.redactionEntries.push({ spanId: span.spanId, redactedKeys });
      this.totalRedactions += redactedKeys.length;
    }

    return span;
  }

  /** Immutable snapshot for emit / tests. */
  snapshot(): { spans: Span[]; redactionManifest: RedactionManifest } {
    return {
      spans: this.spans.slice(),
      redactionManifest: {
        spans: this.redactionEntries.slice(),
        totalRedactions: this.totalRedactions,
      },
    };
  }
}
