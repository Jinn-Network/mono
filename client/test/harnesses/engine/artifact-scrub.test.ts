import { describe, expect, it } from 'vitest';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { scrubArtifactBytes } from '../../../src/harnesses/engine/artifact-scrub.js';
import { CredentialScrubProcessor } from '../../../src/trajectory/processors/credential-scrub.js';
import { IdentityScrubProcessor } from '../../../src/trajectory/processors/identity-scrub.js';
import { PathScrubProcessor } from '../../../src/trajectory/processors/path-scrub.js';

function fakeSpan(attrs: Record<string, unknown>): ReadableSpan {
  return {
    attributes: attrs,
    spanContext: () => ({ traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), traceFlags: 0 }),
  } as unknown as ReadableSpan;
}

describe('donation artifact scrubber', () => {
  it('uses the same identity/path/credential rules as telemetry processors', () => {
    const identity = {
      username: 'adriano',
      hostname: 'devbox',
      machineId: 'machine-1',
      gitAuthorName: 'Adriano Bradley',
      gitAuthorEmail: 'adriano@example.com',
    };
    const path = {
      home: '/Users/adriano',
      repoRoot: '/Users/adriano/repo',
    };
    const span = fakeSpan({
      author: 'Adriano Bradley <adriano@example.com> on devbox',
      path: '/Users/adriano/repo/src/index.ts',
      token: 'secret-value',
    });

    new PathScrubProcessor(path).onEnd(span);
    new IdentityScrubProcessor(identity).onEnd(span);
    new CredentialScrubProcessor().onEnd(span);

    const artifact = scrubArtifactBytes(
      Buffer.from(JSON.stringify({
        author: 'Adriano Bradley <adriano@example.com> on devbox',
        path: '/Users/adriano/repo/src/index.ts',
        token: 'secret-value',
      }), 'utf8'),
      { identity, path },
    );
    const parsed = JSON.parse(artifact.bytes.toString('utf8')) as Record<string, unknown>;

    expect(parsed.author).toBe(span.attributes.author);
    expect(parsed.path).toBe(span.attributes.path);
    expect(parsed.token).toBe(span.attributes.token);
    expect(artifact.redactedKeys).toEqual(['token']);
  });

  it('leaves binary data unchanged', () => {
    const bytes = Buffer.from([0x00, 0xff, 0x10, 0x20]);
    const out = scrubArtifactBytes(bytes, {
      identity: { username: 'adriano' },
      path: { home: '/Users/adriano' },
    });

    expect(out.bytes).toBe(bytes);
    expect(out.redactedKeys).toEqual([]);
  });

  it('redacts credential-looking values even when the field name is generic', () => {
    const out = scrubArtifactBytes(
      Buffer.from(JSON.stringify({
        log: 'request failed with Authorization: Bearer sk-ant-oat01-abcdefghijklmnop and cwd /Users/adriano/repo',
        note: 'github token ghp_abcdefghijklmnopqrstuvwxyz123456',
      }), 'utf8'),
      {
        identity: { username: 'adriano' },
        path: { home: '/Users/adriano', repoRoot: '/Users/adriano/repo' },
      },
    );

    const parsed = JSON.parse(out.bytes.toString('utf8')) as Record<string, unknown>;
    expect(String(parsed.log)).toContain('<REDACTED>');
    expect(String(parsed.log)).toContain('.');
    expect(String(parsed.log)).not.toContain('sk-ant-oat01');
    expect(String(parsed.note)).toBe('github token <REDACTED>');
  });
});
