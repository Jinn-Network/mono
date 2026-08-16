import { ReadableSpan, SpanProcessor } from '@opentelemetry/sdk-trace-base';
import {
  CREDENTIAL_REDACTED,
  isSensitiveCredentialKey,
} from './credential-scrub.js';

export const TRANSCRIPT_CONTENT_SCRUB_VERSION = '1.0.0';

const TRANSCRIPT_CONTENT_KEYS = new Set([
  'message.content',
  'tool.args',
  'tool.result',
  'edit.diff',
  'file.diff',
]);

const RAW_CREDENTIAL_PATTERNS: readonly RegExp[] = [
  /\bBearer\s+[A-Za-z0-9._-]{10,}/i,
  /\bsk-ant-[A-Za-z0-9_-]{20,}\b/,
  /\bsk-[A-Za-z0-9_-]{20,}\b/,
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/,
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/,
];

const CREDENTIAL_ASSIGNMENT_PATTERN =
  /\b[A-Za-z0-9_.-]*(?:authorization|api[_-]?key|apikey|bearer|password|secret|token|private[_-]?key|privatekey)[A-Za-z0-9_.-]*\b\s*[:=]/i;

export function containsSensitiveTranscriptContent(value: unknown): boolean {
  if (typeof value === 'string') {
    const trimmed = value.trimStart();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        return containsSensitiveTranscriptContent(JSON.parse(value) as unknown);
      } catch {
        // Fall through to text checks.
      }
    }
    return CREDENTIAL_ASSIGNMENT_PATTERN.test(value)
      || RAW_CREDENTIAL_PATTERNS.some((pattern) => pattern.test(value));
  }

  if (Array.isArray(value)) {
    return value.some((entry) => containsSensitiveTranscriptContent(entry));
  }

  if (value && typeof value === 'object') {
    for (const [key, nested] of Object.entries(value)) {
      if (isSensitiveCredentialKey(key)) return true;
      if (containsSensitiveTranscriptContent(nested)) return true;
    }
  }

  return false;
}

export class TranscriptContentScrubProcessor implements SpanProcessor {
  forceFlush() { return Promise.resolve(); }
  shutdown() { return Promise.resolve(); }
  onStart() {}

  onEnd(span: ReadableSpan): void {
    const attrs = span.attributes as Record<string, unknown>;
    for (const key of TRANSCRIPT_CONTENT_KEYS) {
      if (containsSensitiveTranscriptContent(attrs[key])) {
        attrs[key] = CREDENTIAL_REDACTED;
      }
    }
  }
}
