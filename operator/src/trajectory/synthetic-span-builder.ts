/**
 * Synthetic span builder — bridges canonical TranscriptEvents (Task 3.1)
 * into OTel spans landing in the embedded receiver (Task 1.1).
 *
 * Path B (transcript-tail) traversal: a per-tool parser observes new bytes
 * appended to a transcript file, normalises into TranscriptEvent, and feeds
 * each event through this module. The result is a span emitted via OTLP/HTTP
 * to the embedded receiver, which dispatches it through the same processor
 * stack as path-A native OTel spans (identity-scrub, path-scrub,
 * credential-scrub, manifest-builder, sqlite-exporter). That uniformity is
 * the whole point — by the time scrubbing + persistence run, path provenance
 * has been erased.
 *
 * Per-session traceId stability is provided via a session-root span: the
 * first event for a sessionId starts a long-lived "session" span; every
 * subsequent event for that session is emitted as a child within the
 * session's active context. Child spans inherit the session's traceId. The
 * session-root span is held open for the life of the provider; the watcher
 * dispatcher (Task 3.9) will own end-of-session lifecycle later.
 *
 * Spec: spec/2026-05-07-telemetry-collector-and-task-generator.md §4.2 path B.
 */

import {
  trace,
  context as otelContext,
  SpanKind,
  type Span,
  type Tracer,
} from '@opentelemetry/api';
import {
  BasicTracerProvider,
  BatchSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import type { TranscriptEvent, TranscriptParser } from './transcript-parsers/types.js';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface SyntheticSpanProviderConfig {
  /**
   * Where to export spans. Defaults to the OTLP/HTTP exporter's own default
   * (`http://localhost:4318/v1/traces`). In tests, point at the embedded
   * receiver's ephemeral httpPort.
   */
  otlpHttpEndpoint?: string;
}

export interface SyntheticSpanProvider {
  /** Force-flush pending spans to the OTLP exporter. Safe to call repeatedly. */
  flush(): Promise<void>;
  /** Shut down the provider — ends any open session-root spans, flushes, closes the exporter. */
  shutdown(): Promise<void>;
  /** @internal Tracer used by emitSyntheticSpan; exposed for testability. */
  readonly tracer: Tracer;
  /** @internal Map<sessionId, session-root span>. */
  readonly sessionRoots: Map<string, Span>;
}

export type TranscriptTool = TranscriptParser['tool'];

export interface EmitInput {
  tool: TranscriptTool;
  sessionId: string;
  event: TranscriptEvent;
}

// ---------------------------------------------------------------------------
// Provider lifecycle
// ---------------------------------------------------------------------------

export function startSyntheticSpanProvider(
  cfg: SyntheticSpanProviderConfig = {},
): SyntheticSpanProvider {
  const exporter = new OTLPTraceExporter(
    cfg.otlpHttpEndpoint ? { url: cfg.otlpHttpEndpoint } : {},
  );
  const processor = new BatchSpanProcessor(exporter, {
    // Tight bounds: synthetic spans should land in the receiver fast so the
    // flush() awaitable in tests is honest about what's been exported.
    scheduledDelayMillis: 50,
  });
  const provider = new BasicTracerProvider({
    spanProcessors: [processor],
  });

  const tracer = provider.getTracer('jinn-synthetic-spans');
  const sessionRoots = new Map<string, Span>();

  return {
    tracer,
    sessionRoots,
    async flush() {
      await processor.forceFlush();
    },
    async shutdown() {
      // End every session-root span so we don't leak open spans on the
      // exporter side. The watcher dispatcher will own session-end semantics
      // proper (Phase 6 / Task 3.9); on provider shutdown we just close them.
      for (const root of sessionRoots.values()) {
        root.end();
      }
      sessionRoots.clear();
      await provider.shutdown();
    },
  };
}

// ---------------------------------------------------------------------------
// Emission
// ---------------------------------------------------------------------------

function getOrCreateSessionRoot(
  provider: SyntheticSpanProvider,
  sessionId: string,
  tool: TranscriptTool,
): Span {
  let root = provider.sessionRoots.get(sessionId);
  if (!root) {
    root = provider.tracer.startSpan('session', { kind: SpanKind.INTERNAL });
    root.setAttribute('jinn.session.id', sessionId);
    root.setAttribute('transcript.tool', tool);
    provider.sessionRoots.set(sessionId, root);
  }
  return root;
}

export function emitSyntheticSpan(
  provider: SyntheticSpanProvider,
  input: EmitInput,
): void {
  const root = getOrCreateSessionRoot(provider, input.sessionId, input.tool);
  // Pass the session-root span as the explicit parent context. Avoids
  // depending on a globally-registered ContextManager (BasicTracerProvider
  // does not auto-register one); the third arg of `Tracer.startSpan` is the
  // parent context, and `trace.setSpan(ctx, root)` injects the root as the
  // parent so the new span inherits its traceId.
  const parentCtx = trace.setSpan(otelContext.active(), root);
  const span = provider.tracer.startSpan(
    input.event.kind,
    { kind: SpanKind.INTERNAL },
    parentCtx,
  );

  // Universal attributes — every synthetic span carries these so processors
  // (sqlite-exporter routes on jinn.session.id, manifest-builder keys on
  // transcript.tool) can operate without sniffing event-kind specifics.
  span.setAttribute('jinn.session.id', input.sessionId);
  span.setAttribute('transcript.tool', input.tool);

  // Event-kind-specific attributes. Switch is exhaustive over the
  // TranscriptEvent discriminated union; adding a new kind in types.ts will
  // surface as a TS exhaustiveness error here.
  switch (input.event.kind) {
    case 'user-message':
    case 'assistant-message':
      span.setAttribute('message.content', input.event.content);
      break;
    case 'tool-call':
      span.setAttribute('tool.name', input.event.name);
      span.setAttribute('tool.args', JSON.stringify(input.event.args));
      break;
    case 'tool-result':
      span.setAttribute('tool.name', input.event.name);
      span.setAttribute('tool.result', input.event.content);
      span.setAttribute('tool.result.is_error', input.event.isError ?? false);
      break;
    case 'edit':
      span.setAttribute('edit.path', input.event.path);
      span.setAttribute('edit.diff', input.event.diff);
      break;
    default: {
      // Exhaustiveness guard — TS will complain if a new kind is added.
      const _exhaustive: never = input.event;
      void _exhaustive;
    }
  }

  span.end();
}
