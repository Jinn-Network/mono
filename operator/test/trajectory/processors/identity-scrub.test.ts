import { describe, it, expect } from 'vitest';
import { IdentityScrubProcessor, scrubIdentityString, IDENTITY_SCRUB_VERSION } from '../../../src/trajectory/processors/identity-scrub.js';
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

describe('scrubIdentityString protects the jinn. protocol prefix (#1474)', () => {
  const jinnId = { username: 'jinn' };

  it('leaves jinn.-prefixed protocol tokens intact when username === "jinn"', () => {
    expect(scrubIdentityString('jinn.artifact.emit', jinnId)).toBe('jinn.artifact.emit');
    expect(scrubIdentityString('jinn.span.kind', jinnId)).toBe('jinn.span.kind');
  });

  it('preserves protocol value and key via onEnd under a jinn username', () => {
    const proc = new IdentityScrubProcessor(jinnId);
    const span = fakeSpan({ 'jinn.span.kind': 'jinn.artifact.emit' });
    proc.onEnd(span);
    expect(span.attributes['jinn.span.kind']).toBe('jinn.artifact.emit');
    expect(Object.keys(span.attributes)).toContain('jinn.span.kind');
  });

  it('still scrubs genuine jinn-substring PII outside the protocol namespace', () => {
    expect(scrubIdentityString('/home/jinn/notes', jinnId)).toBe('/home/<USER>/notes');
    expect(scrubIdentityString('jinn', jinnId)).toBe('<USER>');
  });

  it('scrubs adjacent PII while preserving a protocol token in the same string', () => {
    expect(scrubIdentityString('jinn.artifact.emit at /home/jinn/x', jinnId))
      .toBe('jinn.artifact.emit at /home/<USER>/x');
  });

  it('never leaks control chars into output', () => {
    const outputs = [
      scrubIdentityString('jinn.artifact.emit', jinnId),
      scrubIdentityString('jinn.span.kind', jinnId),
      scrubIdentityString('jinn.artifact.emit at /home/jinn/x', jinnId),
      // Numeric-username input: the old sentinel design corrupted the index and
      // leaked raw control chars here; the split approach must not.
      scrubIdentityString('jinn.span.0', { username: '0' }),
    ];
    for (const out of outputs) {
      // No control characters (U+0000-U+001F) should ever reach the corpus.
      expect(out).not.toMatch(/[\u0000-\u001f]/);
    }
  });
});

describe('scrubIdentityString protects protocol tokens against digit/short identity tokens (#1474 regression)', () => {
  it('leaves a protocol token intact when username is a bare digit', () => {
    // The trailing "0" is part of the protocol token, not PII to redact.
    expect(scrubIdentityString('jinn.span.0', { username: '0' })).toBe('jinn.span.0');
    expect(scrubIdentityString('jinn.artifact.emit', { username: '0' })).toBe('jinn.artifact.emit');
  });

  it('leaves a protocol token intact when gitAuthorName is a bare digit', () => {
    expect(scrubIdentityString('jinn.span.kind', { gitAuthorName: '0' })).toBe('jinn.span.kind');
  });

  it('preserves many protocol tokens in one string under a digit identity', () => {
    // 12 tokens; under the old numeric-sentinel design, indices >= 10 corrupted.
    const tokens = Array.from({ length: 12 }, (_, i) => `jinn.t${i}.emit`);
    const input = tokens.join(' ');
    expect(scrubIdentityString(input, { username: '1' })).toBe(input);
  });

  it('still redacts a genuine digit-username outside protocol tokens', () => {
    expect(scrubIdentityString('/home/0/x', { username: '0' })).toBe('/home/<USER>/x');
  });
});
