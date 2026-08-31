import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchFromIpfs } from '../src/corpus-read/ipfs.js';

const CID = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi';
/** 64 hex chars — expands to two CID path candidates, so four attempts in all. */
const HEX_CID = 'a'.repeat(64);

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function redirect(location: string, status = 302): Response {
  return new Response('moved', { status, headers: { location } });
}

describe('fetchFromIpfs redirect revalidation (#3410)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('refuses a redirect that leaves the configured gateway', async () => {
    const requested: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        // The whole redirect control rests on this: with the default
        // `follow`, undici would chase the Location itself, unrevalidated.
        expect(init?.redirect).toBe('manual');
        requested.push(String(input));
        return redirect('https://169.254.169.254/latest/meta-data/');
      }),
    );

    await expect(
      fetchFromIpfs('https://gateway.example', CID, { fallbackGatewayBase: false }),
    ).rejects.toThrow(/redirect leaves the configured gateway/);

    expect(requested.some((url) => url.includes('169.254.169.254'))).toBe(false);
  });

  it('refuses a redirect that downgrades https to http', async () => {
    const requested: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        requested.push(String(input));
        return redirect('http://gateway.example/ipfs/other');
      }),
    );

    await expect(
      fetchFromIpfs('https://gateway.example', CID, { fallbackGatewayBase: false }),
    ).rejects.toThrow(/redirect downgrades https to http/);

    expect(requested.some((url) => url.startsWith('http://'))).toBe(false);
  });

  it('follows a redirect into a subdomain of the configured gateway', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.startsWith('https://gateway.example/')) {
          return redirect(`https://${CID}.ipfs.gateway.example/`);
        }
        return json({ ok: true });
      }),
    );

    await expect(
      fetchFromIpfs('https://gateway.example', CID, { fallbackGatewayBase: false }),
    ).resolves.toEqual({ ok: true });
  });

  it('refuses a redirect to a different port on the gateway host', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => redirect('http://127.0.0.1:5001/admin')),
    );

    await expect(
      fetchFromIpfs('http://127.0.0.1:8080', CID, { fallbackGatewayBase: false }),
    ).rejects.toThrow(/redirect changes the gateway port \(5001\)/);
  });

  it('refuses a redirect chain longer than the hop cap', async () => {
    let hop = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        hop += 1;
        return redirect(`https://hop${hop}.gateway.example/`);
      }),
    );

    await expect(
      fetchFromIpfs('https://gateway.example', CID, { fallbackGatewayBase: false }),
    ).rejects.toThrow(/exceeded 3 redirects/);

    // Exactly the initial request plus the three capped follow-ups.
    expect(hop).toBe(4);
  });
});

describe('fetchFromIpfs response byte cap (#3410)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('refuses a response whose declared content-length exceeds the cap', async () => {
    let chunks = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              pull(controller) {
                // Bounded so an unfixed reader terminates and fails the
                // assertion below rather than exhausting the worker's heap.
                if (chunks >= 16) {
                  controller.close();
                  return;
                }
                chunks += 1;
                controller.enqueue(new Uint8Array(1024));
              },
            }),
            {
              status: 200,
              headers: {
                'content-type': 'application/json',
                'content-length': String(64 * 1024 * 1024),
              },
            },
          ),
      ),
    );

    await expect(
      fetchFromIpfs('https://gateway.example', CID, { fallbackGatewayBase: false }),
    ).rejects.toThrow(/exceeds the 8388608-byte cap \(content-length/);

    // The stream fills its one-chunk queue on construction; what matters is
    // that nothing drained it. Pre-fix this reached all 16 chunks.
    expect(chunks).toBeLessThanOrEqual(2);
  });

  it('refuses an unbounded body that streams past the cap', async () => {
    let enqueued = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              pull(controller) {
                // Bounded only so an unfixed reader fails the assertion below
                // instead of exhausting the test worker's heap.
                if (enqueued >= 64) {
                  controller.close();
                  return;
                }
                enqueued += 1;
                controller.enqueue(new Uint8Array(1024 * 1024));
              },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
      ),
    );

    await expect(
      fetchFromIpfs('https://gateway.example', CID, { fallbackGatewayBase: false }),
    ).rejects.toThrow(/IPFS JSON fetch failed after all candidates/);

    // Bounded: the reader stopped near the 8 MiB cap instead of draining
    // all 64 MiB the stream was willing to hand over.
    expect(enqueued).toBeLessThan(16);
  });

  it('still returns a normal small JSON body', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ hello: 'world' })));

    await expect(
      fetchFromIpfs('https://gateway.example', CID, { fallbackGatewayBase: false }),
    ).resolves.toEqual({ hello: 'world' });
  });
});

describe('fetchFromIpfs whole-operation deadline (#3410)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('bounds the whole call while still attempting every candidate', async () => {
    vi.useFakeTimers();
    const started: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (input: RequestInfo | URL, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            started.push(String(input));
            init?.signal?.addEventListener('abort', () => {
              reject(new Error('aborted'));
            });
          }),
      ),
    );

    const begunAt = Date.now();
    let settledAt = 0;
    const pending = fetchFromIpfs('https://gateway.example', HEX_CID).catch((error: unknown) => {
      settledAt = Date.now();
      throw error;
    });
    const assertion = expect(pending).rejects.toThrow(
      /IPFS JSON fetch failed after all candidates/,
    );
    await vi.advanceTimersByTimeAsync(180_000);
    await assertion;

    // Two CID path candidates x two gateways, every one of them tried...
    expect(started.length).toBe(4);
    // ...inside the whole-operation budget, not four times the per-attempt one.
    expect(settledAt - begunAt).toBeLessThanOrEqual(45_000);
  });
});
