/**
 * Pins for the pre-sized bounded body read (#3759).
 *
 * The change is, by its own acceptance criteria, an internal optimization with
 * no observable behaviour change — so no test here can be red before it and
 * green after. These pins encode current behaviour instead: they are a fence
 * that must stay green across the change, and each one bites on a specific way
 * the pre-sizing could be got wrong (an ungated `content-length` on an encoded
 * response, `subarray` retaining the whole backing buffer, a cumulative check
 * that stops being the authority). No peak-RSS assertions — they are flaky
 * under a shared vitest worker; the memory claim is argued in the code comment
 * and measured out of band.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchBytesFromIpfs } from '../src/corpus-read/ipfs.js';

const CID = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi';
/** A distinctive fill, so a trailing run of zeros is detectable. */
const FILL = 7;

function body(size: number, headers: Record<string, string>): Response {
  return new Response(new Uint8Array(size).fill(FILL), {
    status: 200,
    headers: { 'content-type': 'application/octet-stream', ...headers },
  });
}

function stub(build: () => Response): void {
  vi.stubGlobal('fetch', vi.fn(async () => build()));
}

async function read(maxResponseBytes?: number): Promise<Uint8Array> {
  return fetchBytesFromIpfs('https://gateway.example', CID, {
    fallbackGatewayBase: false,
    ...(maxResponseBytes === undefined ? {} : { maxResponseBytes }),
  });
}

/** Every byte is the fill — no zero-padding crept in from a pre-sized buffer. */
function allFilled(bytes: Uint8Array): boolean {
  return bytes.every((value) => value === FILL);
}

describe('bounded IPFS body read (#3759)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('returns exactly the bytes an honest content-length declares', async () => {
    stub(() => body(4096, { 'content-length': '4096' }));

    const bytes = await read();

    expect(bytes.byteLength).toBe(4096);
    expect(allFilled(bytes)).toBe(true);
  });

  it('takes the fast path for an explicit identity encoding', async () => {
    stub(() => body(4096, { 'content-length': '4096', 'content-encoding': 'identity' }));

    const bytes = await read();

    expect(bytes.byteLength).toBe(4096);
    expect(allFilled(bytes)).toBe(true);
  });

  it('returns the whole body when content-length under-declares it', async () => {
    stub(() => body(4096, { 'content-length': '100' }));

    const bytes = await read();

    expect(bytes.byteLength).toBe(4096);
    expect(allFilled(bytes)).toBe(true);
  });

  it('still refuses an under-declared body that streams past the cap', async () => {
    // The cumulative counter, not the declared length and not the pre-sized
    // buffer's own length, is what enforces the cap.
    stub(() => body(4096, { 'content-length': '100' }));

    await expect(read(1024)).rejects.toThrow(/exceeds the 1024-byte cap/);
  });

  it('returns only the received bytes when content-length over-declares', async () => {
    stub(() => body(100, { 'content-length': '4096' }));

    const bytes = await read();

    expect(bytes.byteLength).toBe(100);
    expect(allFilled(bytes)).toBe(true);
    // `subarray` would satisfy the two assertions above while retaining the
    // whole 4096-byte backing store — silently defeating the change on the one
    // path where it matters.
    expect(bytes.buffer.byteLength).toBe(100);
  });

  it('returns the full decoded body when content-length describes wire bytes', async () => {
    // `content-encoding` makes `content-length` the *compressed* size, so
    // pre-sizing from it would allocate a buffer guaranteed to overflow.
    stub(() =>
      body(200_000, { 'content-length': '230', 'content-encoding': 'gzip' }),
    );

    const bytes = await read();

    expect(bytes.byteLength).toBe(200_000);
    expect(allFilled(bytes)).toBe(true);
  });

  it('reads a body with no content-length at all', async () => {
    stub(() => body(4096, {}));

    const bytes = await read();

    expect(bytes.byteLength).toBe(4096);
    expect(allFilled(bytes)).toBe(true);
  });

  it('reads a body whose content-length does not parse', async () => {
    stub(() => body(4096, { 'content-length': 'abc' }));

    const bytes = await read();

    expect(bytes.byteLength).toBe(4096);
    expect(allFilled(bytes)).toBe(true);
  });

  it('still refuses an oversized declared content-length before reading', async () => {
    let pulled = 0;
    stub(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              if (pulled >= 16) {
                controller.close();
                return;
              }
              pulled += 1;
              controller.enqueue(new Uint8Array(1024));
            },
          }),
          {
            status: 200,
            headers: {
              'content-type': 'application/octet-stream',
              'content-length': String(64 * 1024 * 1024),
            },
          },
        ),
    );

    await expect(read()).rejects.toThrow(/exceeds the 8388608-byte cap \(content-length/);
    expect(pulled).toBeLessThanOrEqual(2);
  });
});
