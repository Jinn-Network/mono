/**
 * The IPFS response byte cap takes an operator override (#3453).
 *
 * The cap governs every IPFS read in the system, so an operator whose gateway
 * legitimately serves larger payloads had no way to move it without editing a
 * call site. `JINN_IPFS_MAX_RESPONSE_BYTES` is the option-with-env-fallback
 * shape `fetch-artifact.ts` already uses: an explicit per-call bound wins, the
 * env replaces the default, and an out-of-range value falls back to the default
 * rather than disabling the bound.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchBytesFromIpfs } from '../src/corpus-read/ipfs.js';

const CID = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi';
const ENV_KEY = 'JINN_IPFS_MAX_RESPONSE_BYTES';

/** A body of `size` bytes with an honest `content-length`. */
function sized(size: number): Response {
  return new Response(new Uint8Array(size), {
    status: 200,
    headers: { 'content-type': 'application/octet-stream', 'content-length': String(size) },
  });
}

/** A streamed body of `chunks` x 1 MiB with no `content-length` at all. */
function streamed(chunks: number): Response {
  let emitted = 0;
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        if (emitted >= chunks) {
          controller.close();
          return;
        }
        emitted += 1;
        controller.enqueue(new Uint8Array(1024 * 1024));
      },
    }),
    { status: 200, headers: { 'content-type': 'application/octet-stream' } },
  );
}

/**
 * A tiny body behind an oversized declared `content-length`. Any cap at or
 * below 8388608 refuses it on the header alone, so the default cases assert the
 * fallback without allocating megabytes.
 */
function overDeclared(): Response {
  return new Response(new Uint8Array(8), {
    status: 200,
    headers: {
      'content-type': 'application/octet-stream',
      'content-length': String(8 * 1024 * 1024 + 1),
    },
  });
}

function stub(build: () => Response): void {
  vi.stubGlobal('fetch', vi.fn(async () => build()));
}

describe('IPFS response byte cap operator override (#3453)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it('raises the cap above the default', async () => {
    vi.stubEnv(ENV_KEY, String(16 * 1024 * 1024));
    stub(() => streamed(9));

    const bytes = await fetchBytesFromIpfs('https://gateway.example', CID, {
      fallbackGatewayBase: false,
    });

    expect(bytes.byteLength).toBe(9 * 1024 * 1024);
  });

  it('lowers the cap below the default', async () => {
    vi.stubEnv(ENV_KEY, '1024');
    stub(() => sized(4096));

    await expect(
      fetchBytesFromIpfs('https://gateway.example', CID, { fallbackGatewayBase: false }),
    ).rejects.toThrow(/exceeds the 1024-byte cap/);
  });

  it('lets an explicit bound raise past the env', async () => {
    vi.stubEnv(ENV_KEY, '1024');
    stub(() => sized(4096));

    const bytes = await fetchBytesFromIpfs('https://gateway.example', CID, {
      fallbackGatewayBase: false,
      maxResponseBytes: 8 * 1024 * 1024,
    });

    expect(bytes.byteLength).toBe(4096);
  });

  it('lets an explicit bound lower past the env', async () => {
    vi.stubEnv(ENV_KEY, String(16 * 1024 * 1024));
    stub(() => sized(4096));

    await expect(
      fetchBytesFromIpfs('https://gateway.example', CID, {
        fallbackGatewayBase: false,
        maxResponseBytes: 1024,
      }),
    ).rejects.toThrow(/exceeds the 1024-byte cap/);
  });

  // The never-unbounded guarantee: no out-of-range spelling can disable the cap.
  for (const [label, value] of [
    ['zero', '0'],
    ['negative', '-1'],
    ['non-integer', 'abc'],
    ['empty', ''],
  ] as const) {
    it(`falls back to the default when the env is ${label}`, async () => {
      vi.stubEnv(ENV_KEY, value);
      stub(overDeclared);

      await expect(
        fetchBytesFromIpfs('https://gateway.example', CID, { fallbackGatewayBase: false }),
      ).rejects.toThrow(/exceeds the 8388608-byte cap/);
    });
  }
});
