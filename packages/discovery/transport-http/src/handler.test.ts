import { describe, expect, it } from "vitest";
import { WELL_KNOWN_PATH } from "@jinn-network/record-discovery-protocol";

import type { BlobReader } from "./ports.js";
import { IMMUTABLE_CACHE_CONTROL, REVALIDATE_CACHE_CONTROL, computeEtag, createArchiveHttpHandler } from "./handler.js";

const HEX64 = "b".repeat(64);
const encoder = new TextEncoder();

function readerOf(entries: Record<string, { bytes: Uint8Array; contentType: string }>): BlobReader {
  return { async get(path) { return entries[path]; } };
}

const HEAD_BYTES = encoder.encode('{"origin":"did:key:zA/feed","sequence":"0000000000000002"}');
const PAGE_BYTES = encoder.encode('{"page":"0000000000000001"}');
const RECORD_BYTES = encoder.encode("sealed-record-bytes");

function fixtureHandler(options: { basePath?: string; sealed?: boolean } = {}) {
  return createArchiveHttpHandler({
    reader: readerOf({
      [WELL_KNOWN_PATH]: { bytes: encoder.encode('{"protocol":"x","sources":[]}'), contentType: "application/json" },
      "/sources/feed/head": { bytes: HEAD_BYTES, contentType: "application/json" },
      "/sources/feed/entries/0000000000000001": { bytes: PAGE_BYTES, contentType: "application/json" },
      [`/records/${HEX64}`]: { bytes: RECORD_BYTES, contentType: "application/json" },
    }),
    ...(options.basePath === undefined ? {} : { basePath: options.basePath }),
    ...(options.sealed === undefined ? {} : { isSealedPage: () => options.sealed! }),
  });
}

describe("createArchiveHttpHandler", () => {
  it("serves the head with an ETag and a revalidating cache directive", async () => {
    const response = await fixtureHandler()(new Request("http://host/sources/feed/head"));
    expect(response.status).toBe(200);
    expect(response.headers.get("etag")).toBe(computeEtag(HEAD_BYTES));
    expect(response.headers.get("cache-control")).toBe(REVALIDATE_CACHE_CONTROL);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(HEAD_BYTES);
  });

  it("answers 304 when If-None-Match matches the head", async () => {
    const handler = fixtureHandler();
    const response = await handler(new Request("http://host/sources/feed/head", {
      headers: { "if-none-match": computeEtag(HEAD_BYTES) },
    }));
    expect(response.status).toBe(304);
    expect(response.headers.get("etag")).toBe(computeEtag(HEAD_BYTES));
    expect(await response.text()).toBe("");
  });

  it("answers 200 when If-None-Match is stale", async () => {
    const response = await fixtureHandler()(new Request("http://host/sources/feed/head", {
      headers: { "if-none-match": '"sha256-stale"' },
    }));
    expect(response.status).toBe(200);
  });

  it("marks digest paths immutable and declares byte ranges", async () => {
    const response = await fixtureHandler()(new Request(`http://host/records/${HEX64}`));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe(IMMUTABLE_CACHE_CONTROL);
    expect(response.headers.get("accept-ranges")).toBe("bytes");
  });

  it("honors a single byte range on a digest path", async () => {
    const response = await fixtureHandler()(new Request(`http://host/records/${HEX64}`, {
      headers: { range: "bytes=0-5" },
    }));
    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe(`bytes 0-5/${RECORD_BYTES.length}`);
    expect(await response.text()).toBe("sealed");
  });

  it("answers 416 for an unsatisfiable range", async () => {
    const response = await fixtureHandler()(new Request(`http://host/records/${HEX64}`, {
      headers: { range: "bytes=9000-9001" },
    }));
    expect(response.status).toBe(416);
    expect(response.headers.get("content-range")).toBe(`bytes */${RECORD_BYTES.length}`);
  });

  it("marks a sealed archive page immutable and a still-growing page revalidating (Finding F2)", async () => {
    const sealed = await fixtureHandler({ sealed: true })(new Request("http://host/sources/feed/entries/0000000000000001"));
    expect(sealed.headers.get("cache-control")).toBe(IMMUTABLE_CACHE_CONTROL);

    const growing = await fixtureHandler()(new Request("http://host/sources/feed/entries/0000000000000001"));
    expect(growing.headers.get("cache-control")).toBe(REVALIDATE_CACHE_CONTROL);
    expect(growing.headers.get("etag")).toBe(computeEtag(PAGE_BYTES));
  });

  it("serves nothing outside the archive subtree", async () => {
    const handler = fixtureHandler();
    for (const url of [
      "http://host/",
      "http://host/v1/status",
      "http://host/artifacts/search?tags=a",
      `http://host/records/${HEX64}.content-type`,
      "http://host/sources/feed/head.content-type",
      "http://host/sources/feed/entries/0000000000000001/../../../v1/status",
    ]) {
      const response = await handler(new Request(url));
      expect(response.status, url).toBe(404);
    }
  });

  it("answers 404 for an admitted path with no stored object", async () => {
    const response = await fixtureHandler()(new Request("http://host/sources/other/head"));
    expect(response.status).toBe(404);
  });

  it("strips the mount prefix and refuses paths outside it", async () => {
    const handler = fixtureHandler({ basePath: "/v1/archive" });
    expect((await handler(new Request("http://host/v1/archive/sources/feed/head"))).status).toBe(200);
    expect((await handler(new Request("http://host/sources/feed/head"))).status).toBe(404);
    expect((await handler(new Request("http://host/v1/archiver/sources/feed/head"))).status).toBe(404);
  });

  it("answers HEAD without a body and rejects other methods", async () => {
    const handler = fixtureHandler();
    const head = await handler(new Request("http://host/sources/feed/head", { method: "HEAD" }));
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    expect(head.headers.get("content-length")).toBe(String(HEAD_BYTES.length));

    const post = await handler(new Request("http://host/sources/feed/head", { method: "POST" }));
    expect(post.status).toBe(405);
    expect(post.headers.get("allow")).toBe("GET, HEAD");
  });

  it("answers 404 on the tail path when no tail source is injected", async () => {
    const response = await fixtureHandler()(new Request("http://host/sources/feed/tail"));
    expect(response.status).toBe(404);
  });
});

describe("createArchiveHttpHandler tail routing", () => {
  it("serves the SSE tail when a tail source is injected, and only under the mount", async () => {
    const { createInMemoryTailSource } = await import("./tail.js");
    const tail = createInMemoryTailSource(4);
    const handler = createArchiveHttpHandler({
      reader: readerOf({}),
      basePath: "/v1/archive",
      tail: tail.source,
    });

    const response = await handler(new Request("http://host/v1/archive/sources/feed/tail"));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    await response.body!.cancel();

    expect((await handler(new Request("http://host/sources/feed/tail"))).status).toBe(404);
    expect((await handler(new Request("http://host/v1/archive/sources/FEED/tail"))).status).toBe(404);
  });
});
