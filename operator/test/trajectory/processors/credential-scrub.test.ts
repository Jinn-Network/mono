import { describe, it, expect } from 'vitest';
import { CredentialScrubProcessor, CREDENTIAL_SCRUB_VERSION } from '../../../src/trajectory/processors/credential-scrub.js';
import { ReadableSpan } from '@opentelemetry/sdk-trace-base';

function fakeSpan(attrs: Record<string, unknown>): ReadableSpan {
  return {
    name: 't',
    attributes: { ...attrs },
    spanContext: () => ({ traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), traceFlags: 0 }),
  } as unknown as ReadableSpan;
}

describe('CredentialScrubProcessor', () => {
  const proc = new CredentialScrubProcessor();

  it('redacts authorization-style attribute keys (case-insensitive)', () => {
    const span = fakeSpan({
      'http.request.header.authorization': 'Bearer sk-foo123',
      'http.request.header.AUTHORIZATION': 'Bearer x',
      'http.url': 'https://x.com',
    });
    proc.onEnd(span);
    expect(span.attributes['http.request.header.authorization']).toBe('<REDACTED>');
    expect(span.attributes['http.request.header.AUTHORIZATION']).toBe('<REDACTED>');
    expect(span.attributes['http.url']).toBe('https://x.com');
  });

  it('redacts apiKey, api_key, bearer, password, secret, token, privateKey, private_key', () => {
    const span = fakeSpan({
      apiKey: 'foo',
      api_key: 'foo2',
      BEARER: 'bar',
      password: 'baz',
      secret: 'qux',
      token: 'tok',
      privateKey: 'pk',
      private_key: 'pk2',
    });
    proc.onEnd(span);
    for (const k of ['apiKey', 'api_key', 'BEARER', 'password', 'secret', 'token', 'privateKey', 'private_key']) {
      expect(span.attributes[k]).toBe('<REDACTED>');
    }
  });

  it('redacts compound keys containing sensitive substrings', () => {
    const span = fakeSpan({
      'auth.token': 'tok',
      'X-Api-Key': 'k',
      'session.token': 'st',
    });
    proc.onEnd(span);
    expect(span.attributes['auth.token']).toBe('<REDACTED>');
    expect(span.attributes['X-Api-Key']).toBe('<REDACTED>');
    expect(span.attributes['session.token']).toBe('<REDACTED>');
  });

  it('leaves non-sensitive keys alone', () => {
    const span = fakeSpan({
      url: 'https://x.com',
      method: 'GET',
      'http.status_code': 200,
    });
    proc.onEnd(span);
    expect(span.attributes['url']).toBe('https://x.com');
    expect(span.attributes['method']).toBe('GET');
    expect(span.attributes['http.status_code']).toBe(200);
  });

  it('reports its identity in version metadata', () => {
    expect(CREDENTIAL_SCRUB_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
