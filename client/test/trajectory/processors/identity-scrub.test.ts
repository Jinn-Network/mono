import { describe, it, expect } from 'vitest';
import { IdentityScrubProcessor, IDENTITY_SCRUB_VERSION } from '../../../src/trajectory/processors/identity-scrub.js';
import { ReadableSpan } from '@opentelemetry/sdk-trace-base';

function fakeSpan(attrs: Record<string, unknown>): ReadableSpan {
  return {
    name: 'test',
    attributes: { ...attrs },
    spanContext: () => ({ traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), traceFlags: 0 }),
  } as unknown as ReadableSpan;
}

describe('IdentityScrubProcessor', () => {
  const proc = new IdentityScrubProcessor({
    username: 'adrianobradley',
    hostname: 'oak-mbp.local',
    machineId: 'XYZ-123',
    gitAuthorEmail: 'oak@example.com',
    gitAuthorName: 'Oak',
  });

  it('replaces username in string attribute values', () => {
    const span = fakeSpan({ 'shell.cwd': '/Users/adrianobradley/repo' });
    proc.onEnd(span);
    expect(span.attributes['shell.cwd']).toBe('/Users/<USER>/repo');
  });

  it('replaces hostname', () => {
    const span = fakeSpan({ 'net.peer.name': 'oak-mbp.local' });
    proc.onEnd(span);
    expect(span.attributes['net.peer.name']).toBe('<HOST>');
  });

  it('replaces git author email', () => {
    const span = fakeSpan({ 'commit.message': 'Author: Oak <oak@example.com>' });
    proc.onEnd(span);
    expect(span.attributes['commit.message']).toContain('<EMAIL>');
    expect(span.attributes['commit.message']).not.toContain('oak@example.com');
  });

  it('replaces git author name', () => {
    const span = fakeSpan({ 'commit.author': 'Oak Smith' });
    proc.onEnd(span);
    expect(span.attributes['commit.author']).toContain('<AUTHOR>');
    expect(span.attributes['commit.author']).not.toContain('Oak ');
  });

  it('replaces machine ID', () => {
    const span = fakeSpan({ 'machine.id': 'XYZ-123' });
    proc.onEnd(span);
    expect(span.attributes['machine.id']).toBe('<MACHINE>');
  });

  it('replaces IPv4 addresses', () => {
    const span = fakeSpan({ 'http.url': 'http://192.168.1.1:8080/path' });
    proc.onEnd(span);
    expect(span.attributes['http.url']).toBe('http://<IPV4>:8080/path');
  });

  it('leaves non-matching attributes alone', () => {
    const span = fakeSpan({ 'unrelated.field': 'just some value' });
    proc.onEnd(span);
    expect(span.attributes['unrelated.field']).toBe('just some value');
  });

  it('skips non-string attribute values', () => {
    const span = fakeSpan({ 'count': 42, 'flag': true });
    proc.onEnd(span);
    expect(span.attributes['count']).toBe(42);
    expect(span.attributes['flag']).toBe(true);
  });

  it('reports its identity in version metadata', () => {
    expect(IDENTITY_SCRUB_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
