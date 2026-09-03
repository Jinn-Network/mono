import { describe, expect, it } from "vitest";
import type { ClientUnderTest } from "@jinn-network/record-discovery-testing";
import { runConsumerConformance } from "@jinn-network/record-discovery-testing";
import { checkLocator } from "@jinn-network/record-discovery-client";

import type { FetchLike } from "./ports.js";
import {
  TransportHttpError,
  TransportOversizeError,
  TransportRedirectError,
  createHttpTransport,
} from "./fetch-transport.js";

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

// A destination guard that inspects the requested URL buys nothing if the
// server at that URL can post a forwarding address (#3411). The archive's
// serving root is operator-configured but PEER-OPERATED, so the peer answers a
// perfectly contained request with a 302 and, under fetch's default
// `redirect: "follow"`, undici walks the daemon wherever it points.
describe("createHttpTransport redirect containment (#3411)", () => {
  function redirecting(location: string, status = 302): ReturnType<typeof stubFetch> {
    return stubFetch((url) => (url === "https://peer.example/archive/0001.json"
      ? new Response(null, { status, headers: { location } })
      : new Response(encoder.encode("internal-secret"), { status: 200 })));
  }

  it("asks the fetch primitive not to follow redirects itself", async () => {
    const stub = stubFetch(() => new Response(encoder.encode("x"), { status: 200 }));
    let seen: string | undefined;
    const transport = createHttpTransport("", async (url, init) => {
      seen = init?.redirect;
      return stub.fetchLike(url, init);
    });
    await transport.fetch("https://peer.example/archive/0001.json");
    expect(seen).toBe("manual");
  });

  const offOrigin = [
    ["loopback", "http://127.0.0.1:8545/"],
    ["cloud metadata", "http://169.254.169.254/latest/meta-data/"],
    ["private space", "http://10.0.0.5:8080/x"],
    ["another public origin", "https://evil.example/collect"],
    ["a protocol-relative target", "//evil.example/collect"],
    ["a scheme downgrade on the same host", "http://peer.example/archive/0001.json"],
    ["a port change on the same host", "https://peer.example:8443/archive/0001.json"],
  ] as const;

  for (const [label, location] of offOrigin) {
    it(`refuses a redirect to ${label}, and never fetches it`, async () => {
      const stub = redirecting(location);
      const transport = createHttpTransport("", stub.fetchLike);
      await expect(transport.fetch("https://peer.example/archive/0001.json"))
        .rejects.toThrow(TransportRedirectError);
      expect(stub.calls.map((call) => call.url)).toEqual(["https://peer.example/archive/0001.json"]);
    });
  }

  it("refuses a non-HTTP redirect target", async () => {
    const stub = redirecting("file:///etc/passwd");
    const transport = createHttpTransport("", stub.fetchLike);
    await expect(transport.fetch("https://peer.example/archive/0001.json"))
      .rejects.toThrow(TransportRedirectError);
  });

  it("follows a same-origin redirect, which is inside the origin the operator chose", async () => {
    const stub = redirecting("/archive/0001-final.json");
    const transport = createHttpTransport("", stub.fetchLike);
    const response = await transport.fetch("https://peer.example/archive/0001.json");
    expect(new TextDecoder().decode(response.bytes)).toBe("internal-secret");
    expect(stub.calls.map((call) => call.url)).toEqual([
      "https://peer.example/archive/0001.json",
      "https://peer.example/archive/0001-final.json",
    ]);
  });

  it("refuses a same-origin redirect loop rather than following it forever", async () => {
    const stub = stubFetch((url) => new Response(null, {
      status: 302,
      headers: { location: `${url}?next` },
    }));
    const transport = createHttpTransport("", stub.fetchLike);
    await expect(transport.fetch("https://peer.example/archive/0001.json"))
      .rejects.toThrow(TransportRedirectError);
    expect(stub.calls.length).toBe(6); // the first request plus MAX_REDIRECTS hops
  });

  it("reports a redirect with no Location as the HTTP error it is", async () => {
    const stub = stubFetch(() => new Response(null, { status: 302 }));
    const transport = createHttpTransport("", stub.fetchLike);
    await expect(transport.fetch("https://peer.example/archive/0001.json"))
      .rejects.toThrow(TransportHttpError);
  });

  // 304 shares the 3xx band but is the ETag revalidation hit, not a redirect.
  it("still serves the cached body on 304 rather than treating it as a redirect", async () => {
    const stub = stubFetch((_url, init) => (init?.headers?.["if-none-match"] === '"e1"'
      ? new Response(null, { status: 304, headers: { etag: '"e1"' } })
      : new Response(encoder.encode("page"), { status: 200, headers: { etag: '"e1"' } })));
    const transport = createHttpTransport("https://peer.example", stub.fetchLike);
    await transport.fetch("/archive/0001.json");
    const again = await transport.fetch("/archive/0001.json");
    expect(new TextDecoder().decode(again.bytes)).toBe("page");
    expect(transport.stats().revalidations).toBe(1);
  });
});

describe("createHttpTransport deadline (#3222)", () => {
  it("hands the caller's signal to the fetch primitive, on every redirect hop", async () => {
    const controller = new AbortController();
    const seen: (AbortSignal | undefined)[] = [];
    const transport = createHttpTransport("", async (url, init) => {
      seen.push(init?.signal);
      return url === "https://peer.example/a"
        ? new Response(null, { status: 302, headers: { location: "https://peer.example/b" } })
        : new Response(encoder.encode("ok"), { status: 200 });
    });

    await transport.fetch("https://peer.example/a", { signal: controller.signal });
    expect(seen).toEqual([controller.signal, controller.signal]);
  });

  it("abandons a body that stalls after the headers arrive", async () => {
    const controller = new AbortController();
    // Headers land, then the stream trickles and never ends -- the shape a
    // black-holed peer presents. Nothing here aborts the socket, so the only
    // thing that can end this read is the loop observing the signal.
    const transport = createHttpTransport("", async () => {
      let chunks = 0;
      return new Response(
        new ReadableStream<Uint8Array>({
          pull(controllerStream) {
            chunks += 1;
            if (chunks === 2) controller.abort();
            controllerStream.enqueue(encoder.encode("."));
          },
        }),
        { status: 200 },
      );
    });

    await expect(
      transport.fetch("https://peer.example/slow", { signal: controller.signal }),
    ).rejects.toThrow(/abort/iu);
  });

  it("still fetches when no signal is supplied", async () => {
    const stub = stubFetch(() => new Response(encoder.encode("ok"), { status: 200 }));
    const transport = createHttpTransport("", stub.fetchLike);
    expect((await transport.fetch("https://peer.example/x")).status).toBe(200);
  });
});
