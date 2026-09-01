/**
 * `buildFetchIpfsBytes` failure classification (#3451).
 *
 * The builder used to wrap its fetch in `catch { return undefined }`, so every failure mode
 * collapsed into the one answer the caller reads as "this digest is not on IPFS". The 8 MiB
 * response cap (#3438) then made a merely-large sealed document indistinguishable from one that
 * was never pinned. These tests pin the three answers -- and the distinct report each gets when
 * the classified fetch is narrowed for the ports that still consume `Uint8Array | undefined`.
 * Collapsing any of them back into a bare `undefined` turns them red.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const DIGEST = `sha256:${'b'.repeat(64)}` as const;
const CAP = 8 * 1024 * 1024;
const GATEWAY = 'https://gateway.example';

function respondWith(response: () => Response): void {
  vi.stubGlobal('fetch', vi.fn(async () => response()));
}

function status(code: number): Response {
  return new Response('nope', { status: code, statusText: 'x' });
}

describe('buildFetchIpfsBytes (#3451)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('returns the bytes when the gateway serves them', async () => {
    const { buildFetchIpfsBytes } = await import('../../src/daemon/composition-root.js');
    respondWith(() => new Response('hello', { status: 200, headers: { 'content-type': 'text/plain' } }));
    const bytes = await buildFetchIpfsBytes(GATEWAY)(DIGEST);
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(new TextDecoder().decode(bytes as Uint8Array)).toBe('hello');
  });

  it('reports a size-refused document as too-large rather than absent', async () => {
    const { buildFetchIpfsBytes } = await import('../../src/daemon/composition-root.js');
    respondWith(() =>
      new Response('x', {
        status: 200,
        headers: { 'content-type': 'application/octet-stream', 'content-length': String(CAP + 1) },
      }),
    );
    await expect(buildFetchIpfsBytes(GATEWAY)(DIGEST)).resolves.toBe('too-large');
  });

  it('reports a transport failure as unavailable rather than absent', async () => {
    const { buildFetchIpfsBytes } = await import('../../src/daemon/composition-root.js');
    respondWith(() => status(503));
    await expect(buildFetchIpfsBytes(GATEWAY)(DIGEST)).resolves.toBe('unavailable');
  });

  it('reports genuine absence as undefined', async () => {
    const { buildFetchIpfsBytes } = await import('../../src/daemon/composition-root.js');
    respondWith(() => status(404));
    await expect(buildFetchIpfsBytes(GATEWAY)(DIGEST)).resolves.toBeUndefined();
  });
});

describe('narrowIpfsBytes (#3451)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  async function narrowedWithLogger(result: Uint8Array | 'too-large' | 'unavailable' | undefined) {
    const { narrowIpfsBytes } = await import('../../src/daemon/composition-root.js');
    const warn = vi.fn();
    const narrowed = narrowIpfsBytes(async () => result, { warn });
    return { value: await narrowed(DIGEST), warn };
  }

  it('passes bytes through untouched and says nothing', async () => {
    const bytes = new TextEncoder().encode('hi');
    const { value, warn } = await narrowedWithLogger(bytes);
    expect(value).toBe(bytes);
    expect(warn).not.toHaveBeenCalled();
  });

  it('reports a size refusal as served-but-too-large, naming the digest', async () => {
    const { value, warn } = await narrowedWithLogger('too-large');
    expect(value).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    const message = warn.mock.calls[0]![0] as string;
    expect(message).toContain(DIGEST);
    expect(message).toMatch(/refused for size, not absent/);
  });

  it('reports a transport failure distinctly from a size refusal', async () => {
    const { value, warn } = await narrowedWithLogger('unavailable');
    expect(value).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    const message = warn.mock.calls[0]![0] as string;
    expect(message).toContain(DIGEST);
    expect(message).toMatch(/nothing was learned/);
    expect(message).not.toMatch(/refused for size/);
  });

  it('stays silent on genuine absence -- the caller already handles a real miss', async () => {
    const { value, warn } = await narrowedWithLogger(undefined);
    expect(value).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });
});
