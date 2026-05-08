import { ReadableSpan, SpanProcessor } from '@opentelemetry/sdk-trace-base';

export const CREDENTIAL_SCRUB_VERSION = '1.0.0';

// Patterns are matched against a normalized form of the attribute key
// (lowercased, with non-alphanumerics stripped) so compound keys like
// "X-Api-Key", "auth.token", and "http.request.header.authorization" all
// match the same set of substrings as their bare-word counterparts.
const SENSITIVE_KEY_PATTERNS = [
  /authorization/,
  /apikey/,
  /bearer/,
  /password/,
  /secret/,
  /token/,
  /privatekey/,
];

const REDACTED = '<REDACTED>';

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export class CredentialScrubProcessor implements SpanProcessor {
  forceFlush() {
    return Promise.resolve();
  }
  shutdown() {
    return Promise.resolve();
  }
  onStart() {}

  onEnd(span: ReadableSpan): void {
    const attrs = span.attributes as Record<string, unknown>;
    for (const key of Object.keys(attrs)) {
      const normalized = normalizeKey(key);
      if (SENSITIVE_KEY_PATTERNS.some((p) => p.test(normalized))) {
        attrs[key] = REDACTED;
      }
    }
  }
}
