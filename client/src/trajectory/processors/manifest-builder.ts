import { ReadableSpan, SpanProcessor } from '@opentelemetry/sdk-trace-base';
import { SENTINEL_PATTERN } from './sentinel.js';

export const MANIFEST_BUILDER_VERSION = '1.0.0';

export interface SpanRedactionRecord {
  spanId: string;
  redactedKeys: string[];
}

export interface RedactionManifest {
  spans: SpanRedactionRecord[];
}

export class ManifestBuilderProcessor implements SpanProcessor {
  private readonly records: SpanRedactionRecord[] = [];

  forceFlush() { return Promise.resolve(); }
  shutdown() { return Promise.resolve(); }
  onStart() {}

  onEnd(span: ReadableSpan): void {
    const redactedKeys: string[] = [];
    for (const [k, v] of Object.entries(span.attributes)) {
      if (typeof v === 'string' && SENTINEL_PATTERN.test(v)) {
        redactedKeys.push(k);
      }
    }
    if (redactedKeys.length > 0) {
      this.records.push({ spanId: span.spanContext().spanId, redactedKeys });
    }
  }

  /** Drain accumulated records into a manifest and reset internal state. */
  flushManifest(): RedactionManifest {
    const out = { spans: this.records.slice() };
    this.records.length = 0;
    return out;
  }
}
