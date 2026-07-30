import { describe, expect, it } from "vitest";
import type { ClientUnderTest } from "@jinn-network/record-discovery-testing";
import { runConsumerConformance } from "@jinn-network/record-discovery-testing";
import { checkLocator } from "@jinn-network/record-discovery-client";

import type { FetchLike } from "./ports.js";
import { TransportHttpError, TransportOversizeError, createHttpTransport } from "./fetch-transport.js";

const encoder = new TextEncoder();

function stubFetch(handler: (url: string, init?: Parameters<FetchLike>[1]) => Response): {
  fetchLike: FetchLike;
  calls: Array<{ url: string; headers: Record<string, string> }>;
} {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  return {
    calls,
    async fetchLike(url, init) {
      calls.push({ url, headers: init?.headers ?? {} });
      return handler(url, init);
    },
  };
}

describe("createHttpTransport", () => {
  it("resolves relative paths against the base URL and returns bytes plus metadata", async () => {
    const stub = stubFetch(() => new Response(encoder.encode('{"ok":true}'), {
      status: 200,
      headers: { "content-type": "application/json", "content-length": "11" },
    }));
    const transport = createHttpTransport("https://archive.example/v1/archive", stub.fetchLike);

    const response = await transport.fetch("/sources/feed/head");
    expect(stub.calls[0]!.url).toBe("https://archive.example/v1/archive/sources/feed/head");
    expect(response.status).toBe(200);
    expect(response.contentType).toBe("application/json");
    expect(response.declaredLength).toBe(11);
    expect(new TextDecoder().decode(response.bytes)).toBe('{"ok":true}');
  });

  it("passes an absolute URL through untouched", async () => {
    const stub = stubFetch(() => new Response(encoder.encode("x"), { status: 200 }));
    const transport = createHttpTransport("https://archive.example", stub.fetchLike);
    await transport.fetch("https://mirror.example/sources/feed/head");
    expect(stub.calls[0]!.url).toBe("https://mirror.example/sources/feed/head");
  });

  it("sends If-None-Match on a repeat request and serves the cached body on 304", async () => {
    let served = 0;
    const stub = stubFetch((_url, init) => {
      served += 1;
      if (init?.headers?.["if-none-match"] === '"sha256-abc"') {
        return new Response(null, { status: 304, headers: { etag: '"sha256-abc"' } });
      }
      return new Response(encoder.encode("head-bytes"), {
        status: 200,
        headers: { etag: '"sha256-abc"', "content-type": "application/json" },
      });
    });
    const transport = createHttpTransport("https://archive.example", stub.fetchLike);

    const first = await transport.fetch("/sources/feed/head");
    const second = await transport.fetch("/sources/feed/head");

    expect(served).toBe(2);
    expect(new TextDecoder().decode(second.bytes)).toBe("head-bytes");
    expect(second.status).toBe(200);
    expect(second.contentType).toBe("application/json");
    expect(first.bytes).toEqual(second.bytes);
    expect(transport.stats()).toEqual({ requests: 2, revalidations: 1 });
  });

  it("never caches a response without an ETag", async () => {
    const stub = stubFetch(() => new Response(encoder.encode("no-etag"), { status: 200 }));
    const transport = createHttpTransport("https://archive.example", stub.fetchLike);
    await transport.fetch("/sources/feed/head");
    await transport.fetch("/sources/feed/head");
    expect(stub.calls[1]!.headers["if-none-match"]).toBeUndefined();
  });

  it("throws a typed error on a non-2xx, non-304 status", async () => {
    const stub = stubFetch(() => new Response(null, { status: 503 }));
    const transport = createHttpTransport("https://archive.example", stub.fetchLike);
    await expect(transport.fetch("/sources/feed/head")).rejects.toBeInstanceOf(TransportHttpError);
  });

  it("refuses a body whose declared length exceeds the ceiling before reading it", async () => {
    const stub = stubFetch(() => new Response(encoder.encode("x"), {
      status: 200,
      headers: { "content-length": "999999999" },
    }));
    const transport = createHttpTransport("https://archive.example", stub.fetchLike, { maxBytes: 1024 });
    await expect(transport.fetch("/records/deadbeef")).rejects.toBeInstanceOf(TransportOversizeError);
  });

  it("refuses a body that exceeds the ceiling despite an absent declared length", async () => {
    const stub = stubFetch(() => new Response(encoder.encode("x".repeat(2048)), { status: 200 }));
    const transport = createHttpTransport("https://archive.example", stub.fetchLike, { maxBytes: 1024 });
    await expect(transport.fetch("/records/deadbeef")).rejects.toBeInstanceOf(TransportOversizeError);
  });

  it("stops reading an unbounded stream at the ceiling instead of draining it", async () => {
    // A hostile source omits content-length and never stops sending. The
    // ceiling has to hold DURING the read, so the proof is that the
    // producer stops being pulled shortly after the cap, not that an
    // error arrives once the whole body has already been buffered.
    let chunksPulled = 0;
    const stub = stubFetch(() => new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        chunksPulled += 1;
        controller.enqueue(encoder.encode("x".repeat(256)));
      },
    }), { status: 200 }));

    const transport = createHttpTransport("https://archive.example", stub.fetchLike, { maxBytes: 1024 });
    await expect(transport.fetch("/records/deadbeef")).rejects.toBeInstanceOf(TransportOversizeError);
    expect(chunksPulled).toBeLessThan(32);
  });
});

// The hostile-locator guards (§7/§14) are `client`'s, not this
// package's -- but they are only real once a production Transport backs
// them, so the kit's consumer suite runs here against `client`'s
// `checkLocator` wired to this transport.
//
// The stub's response branches on the locator itself: `checkLocator`
// checks size before content-type, so a single fixed oversize/wrong-type
// response cannot satisfy both the oversize and the wrong-content-type
// vectors at once (the oversize check would mask the content-type one).
// Each vector's locator is stable per fixture, so branching on it keeps
// each vector exercising the guard it names.
const underTest: ClientUnderTest = {
  async checkLocator(location) {
    const loc = location as { profile: string; locator: string };
    const stub = stubFetch(() =>
      loc.locator.includes("huge-blob")
        ? new Response(encoder.encode("x".repeat(4096)), {
            status: 200,
            headers: { "content-type": "application/json", "content-length": "4096" },
          })
        : new Response(encoder.encode("x"), {
            status: 200,
            headers: { "content-type": "text/html", "content-length": "1" },
          }),
    );
    return checkLocator(loc, {
      transport: createHttpTransport("https://archive.example", stub.fetchLike, { maxBytes: 1 << 20 }),
      maxBytes: 1024,
    });
  },
};

runConsumerConformance(underTest);
