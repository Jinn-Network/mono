import { describe, it, expect } from 'vitest';
import { PathScrubProcessor, PATH_SCRUB_VERSION } from '../../../src/trajectory/processors/path-scrub.js';
import { ReadableSpan } from '@opentelemetry/sdk-trace-base';

function fakeSpan(attrs: Record<string, unknown>): ReadableSpan {
  return {
    name: 't',
    attributes: { ...attrs },
    spanContext: () => ({ traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), traceFlags: 0 }),
  } as unknown as ReadableSpan;
}

describe('PathScrubProcessor', () => {
  const proc = new PathScrubProcessor({
    home: '/Users/adrianobradley',
    repoRoot: '/Users/adrianobradley/harbor/jinn-mono',
  });

  it('replaces $HOME with /users/anon', () => {
    const span = fakeSpan({ 'file.path': '/Users/adrianobradley/.claude/settings.json' });
    proc.onEnd(span);
    expect(span.attributes['file.path']).toBe('/users/anon/.claude/settings.json');
  });

  it('makes paths under repoRoot relative', () => {
    const span = fakeSpan({ 'file.path': '/Users/adrianobradley/harbor/jinn-mono/cargo/client/src/main.ts' });
    proc.onEnd(span);
    expect(span.attributes['file.path']).toBe('cargo/client/src/main.ts');
  });

  it('repoRoot-relative wins over home-anonymisation', () => {
    // The path starts with home AND with repoRoot. repoRoot is more specific
    // and should fire first to produce a clean repo-relative path.
    const span = fakeSpan({ 'file.path': '/Users/adrianobradley/harbor/jinn-mono/x.ts' });
    proc.onEnd(span);
    expect(span.attributes['file.path']).toBe('x.ts');
  });

  it('scrubs paths embedded inside longer strings', () => {
    const span = fakeSpan({
      message: 'read /Users/adrianobradley/harbor/jinn-mono/cargo/client/src/main.ts from /Users/adrianobradley/.jinn-client/config.json',
    });
    proc.onEnd(span);
    expect(span.attributes['message']).toBe(
      'read cargo/client/src/main.ts from /users/anon/.jinn-client/config.json',
    );
  });

  it('leaves system paths alone', () => {
    const span = fakeSpan({ 'file.path': '/usr/local/bin/node' });
    proc.onEnd(span);
    expect(span.attributes['file.path']).toBe('/usr/local/bin/node');
  });

  it('handles paths without trailing-slash quirks at repo root', () => {
    const procExact = new PathScrubProcessor({ home: '/Users/anon', repoRoot: '/Users/anon/repo' });
    const span = fakeSpan({ 'file.path': '/Users/anon/repo' });
    procExact.onEnd(span);
    // Exact-match repoRoot path becomes empty string (the relative root).
    // We accept either '' or '.' as the canonical representation; pick '.'.
    expect(span.attributes['file.path']).toBe('.');
  });

  it('skips non-string attribute values', () => {
    const span = fakeSpan({ count: 42, flag: true });
    proc.onEnd(span);
    expect(span.attributes['count']).toBe(42);
    expect(span.attributes['flag']).toBe(true);
  });

  it('reports its identity in version metadata', () => {
    expect(PATH_SCRUB_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('repoRoot is optional', () => {
    const noRepo = new PathScrubProcessor({ home: '/Users/anon' });
    const span = fakeSpan({ 'file.path': '/Users/anon/foo.ts' });
    noRepo.onEnd(span);
    expect(span.attributes['file.path']).toBe('/users/anon/foo.ts');
  });
});
