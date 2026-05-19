import { describe, it, expect } from 'vitest';
import { extractHandshakeUrl, makeHandshakeCollector } from './handshake-url';

describe('extractHandshakeUrl', () => {
  it('extracts URL from a typical daemon line', () => {
    const line = '[server] UI handshake URL: http://127.0.0.1:7332/auth/handshake?token=abc123';
    expect(extractHandshakeUrl(line)).toBe('http://127.0.0.1:7332/auth/handshake?token=abc123');
  });

  it('returns null on non-matching lines', () => {
    expect(extractHandshakeUrl('some unrelated log line')).toBeNull();
    expect(extractHandshakeUrl('')).toBeNull();
  });

  it('handles whitespace variation between label and URL', () => {
    const line = 'UI handshake URL:       http://localhost:7332/x';
    expect(extractHandshakeUrl(line)).toBe('http://localhost:7332/x');
  });

  it('does not match if URL is missing', () => {
    expect(extractHandshakeUrl('UI handshake URL:')).toBeNull();
  });
});

describe('makeHandshakeCollector', () => {
  it('resolves when URL appears in a chunk', async () => {
    const collector = makeHandshakeCollector(5000);
    collector.feed('startup line\n');
    collector.feed('UI handshake URL: http://127.0.0.1:7332/auth?t=xyz\n');
    const url = await collector.promise;
    expect(url).toBe('http://127.0.0.1:7332/auth?t=xyz');
  });

  it('handles URL split across two feed calls', async () => {
    const collector = makeHandshakeCollector(5000);
    collector.feed('UI handshake URL: http://12');
    collector.feed('7.0.0.1:7332/auth?t=split\n');
    const url = await collector.promise;
    expect(url).toBe('http://127.0.0.1:7332/auth?t=split');
  });

  it('rejects after timeout if URL never arrives', async () => {
    const collector = makeHandshakeCollector(50);
    collector.feed('only unrelated lines\n');
    await expect(collector.promise).rejects.toThrow(/timed out/i);
  });
});
