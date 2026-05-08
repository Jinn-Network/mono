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
 *   - secrets are scrubbed from BOTH span.attributes AND span.events[*].attributes
 *     before the span is appended; redacted keys are recorded against this
 *     span's spanId in the redactionManifest.
 */

import { randomBytes } from 'node:crypto';
import { SpanKind, SpanStatusCode, type HrTime, type SpanContext } from '@opentelemetry/api';
import type { ReadableSpan, SpanProcessor } from '@opentelemetry/sdk-trace-base';
import type { Span, RedactionManifest } from './schema.js';
import { computeGenesisHash, computePrevSpanHash } from './hash-chain.js';
import { scrubAttributes } from './secret-scrub.js';

function hex(bytes: number): string {
  return randomBytes(bytes).toString('hex');
}

export interface CollectorInit {
  taskCid: string;
  runId: string;
  /** Override for tests. Defaults to randomBytes(16). */
  traceId?: string;
  /**
   * Optional OpenTelemetry processor chain. The collector keeps the existing
   * in-memory trajectory API, but finalized spans flow through these processors
   * before being appended. This is the compatibility bridge while harnesses are
   * migrated to native OTel emission.
   */
  processors?: SpanProcessor[];
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
  readonly taskCid: string;
  private readonly traceId: string;
  private readonly spans: Span[] = [];
  private readonly redactionEntries: RedactionManifest['spans'] = [];
  private readonly processors: SpanProcessor[];
  private totalRedactions = 0;
  private lastSpanHash: string;

  constructor(init: CollectorInit) {
    this.runId = init.runId;
    this.taskCid = init.taskCid;
    this.traceId = init.traceId ?? hex(16);
    this.processors = init.processors ?? [];
    this.lastSpanHash = computeGenesisHash(init.taskCid);
  }

  /** Append a span; returns the finalized span (with assigned ids + chain hash). */
  addSpan(input: SpanInput): Span {
    if (typeof input.attributes['jinn.span.kind'] !== 'string') {
      throw new Error('TrajectoryCollector.addSpan: jinn.span.kind attribute required');
    }

    const { scrubbed, redactedKeys } = scrubAttributes(input.attributes);

    // Scrub event attributes — raw subprocess output (and any other event data)
    // can contain tokens, passwords, or private keys in their attribute values.
    const scrubbedEvents: Span['events'] = input.events.map((event) => {
      if (!event.attributes || Object.keys(event.attributes).length === 0) return event;
      const { scrubbed: scrubbedAttrs, redactedKeys: eventRedacted } = scrubAttributes(
        event.attributes as Record<string, unknown>,
      );
      for (const k of eventRedacted) {
        redactedKeys.push(k);
      }
      return { ...event, attributes: scrubbedAttrs };
    });

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
      events: scrubbedEvents,
      status: input.status,
    };

    this.runProcessors(span);

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

  private runProcessors(span: Span): void {
    if (this.processors.length === 0) return;
    const readable = toReadableSpan(span);
    for (const processor of this.processors) {
      processor.onEnd(readable);
    }
  }
}

function toHrTime(ns: string): HrTime {
  const n = BigInt(ns);
  return [Number(n / 1_000_000_000n), Number(n % 1_000_000_000n)];
}

function toApiKind(kind: Span['kind']): SpanKind {
  switch (kind) {
    case 'CLIENT':
      return SpanKind.CLIENT;
    case 'SERVER':
      return SpanKind.SERVER;
    case 'PRODUCER':
      return SpanKind.PRODUCER;
    case 'CONSUMER':
      return SpanKind.CONSUMER;
    case 'INTERNAL':
    default:
      return SpanKind.INTERNAL;
  }
}

function toApiStatus(code: Span['status']['code']): SpanStatusCode {
  switch (code) {
    case 'OK':
      return SpanStatusCode.OK;
    case 'ERROR':
      return SpanStatusCode.ERROR;
    case 'UNSET':
    default:
      return SpanStatusCode.UNSET;
  }
}

function toReadableSpan(span: Span): ReadableSpan {
  const context: SpanContext = {
    traceId: span.traceId,
    spanId: span.spanId,
    traceFlags: 0,
  };
  return {
    name: span.name,
    kind: toApiKind(span.kind),
    spanContext: () => context,
    parentSpanContext: span.parentSpanId
      ? { traceId: span.traceId, spanId: span.parentSpanId, traceFlags: 0 }
      : undefined,
    startTime: toHrTime(span.startTimeUnixNano),
    endTime: toHrTime(span.endTimeUnixNano),
    status: {
      code: toApiStatus(span.status.code),
      message: span.status.message,
    },
    attributes: span.attributes,
    events: span.events.map((event) => ({
      name: event.name,
      time: toHrTime(event.timeUnixNano),
      attributes: event.attributes ?? {},
      droppedAttributesCount: 0,
    })),
    links: [],
    duration: toHrTime((BigInt(span.endTimeUnixNano) - BigInt(span.startTimeUnixNano)).toString()),
    ended: true,
    resource: { attributes: {} },
    instrumentationScope: { name: '@jinn-network/trajectory-collector' },
    droppedAttributesCount: 0,
    droppedEventsCount: 0,
    droppedLinksCount: 0,
  } as unknown as ReadableSpan;
}
