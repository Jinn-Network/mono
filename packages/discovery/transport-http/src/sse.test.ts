import { describe, expect, it } from "vitest";

import { createInMemoryTailSource } from "./tail.js";
import { SSE_CONTENT_TYPE, formatSseFrame, openArchiveTailStream } from "./sse.js";

async function drain(response: Response, limitFrames: number): Promise<string[]> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  const frames: string[] = [];
  while (frames.length < limitFrames) {
    const { value, done } = await reader.read();
    if (value !== undefined) buffered += decoder.decode(value, { stream: true });
    let boundary = buffered.indexOf("\n\n");
    while (boundary !== -1) {
      frames.push(buffered.slice(0, boundary));
      buffered = buffered.slice(boundary + 2);
      boundary = buffered.indexOf("\n\n");
    }
    if (done) break;
  }
  await reader.cancel().catch(() => undefined);
  return frames;
}

describe("formatSseFrame", () => {
  it("emits id, event, and multi-line data in wire order", () => {
    expect(formatSseFrame({ id: "0000000000000001", event: "announcement", data: '{"a":1}' }))
      .toBe('id: 0000000000000001\nevent: announcement\ndata: {"a":1}\n\n');
  });

  it("splits an embedded newline into successive data lines", () => {
    expect(formatSseFrame({ event: "note", data: "one\ntwo" })).toBe("event: note\ndata: one\ndata: two\n\n");
  });
});

describe("openArchiveTailStream", () => {
  it("declares the SSE content type and a retry hint, then live-tails from now", async () => {
    const tail = createInMemoryTailSource(10);
    tail.publish("announcement", '{"before":true}');

    const response = openArchiveTailStream(new Request("http://host/sources/feed/tail"), "feed", tail.source);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(SSE_CONTENT_TYPE);
    expect(response.headers.get("cache-control")).toBe("no-cache");

    const framesPromise = drain(response, 2);
    tail.publish("announcement", '{"after":true}');
    const frames = await framesPromise;

    expect(frames[0]).toBe("retry: 3000");
    expect(frames[1]).toBe('id: 0000000000000002\nevent: announcement\ndata: {"after":true}');
  });

  it("replays after Last-Event-ID, then continues live", async () => {
    const tail = createInMemoryTailSource(10);
    tail.publish("announcement", '{"n":1}');
    tail.publish("announcement", '{"n":2}');
    tail.publish("announcement", '{"n":3}');

    const response = openArchiveTailStream(
      new Request("http://host/sources/feed/tail", { headers: { "last-event-id": "0000000000000001" } }),
      "feed",
      tail.source,
    );
    const frames = await drain(response, 3);
    expect(frames[1]).toBe('id: 0000000000000002\nevent: announcement\ndata: {"n":2}');
    expect(frames[2]).toBe('id: 0000000000000003\nevent: announcement\ndata: {"n":3}');
  });

  it("prefers Last-Event-ID over the ?cursor query parameter", async () => {
    const tail = createInMemoryTailSource(10);
    tail.publish("announcement", '{"n":1}');
    tail.publish("announcement", '{"n":2}');

    const response = openArchiveTailStream(
      new Request("http://host/sources/feed/tail?cursor=oldest", {
        headers: { "last-event-id": "0000000000000001" },
      }),
      "feed",
      tail.source,
    );
    const frames = await drain(response, 2);
    expect(frames[1]).toBe('id: 0000000000000002\nevent: announcement\ndata: {"n":2}');
  });

  it("emits a typed unknown-cursor terminal event, then closes", async () => {
    const tail = createInMemoryTailSource(10);
    tail.publish("announcement", '{"n":1}');

    const response = openArchiveTailStream(
      new Request("http://host/sources/feed/tail?cursor=0000000000000099"),
      "feed",
      tail.source,
    );
    const frames = await drain(response, 5);
    expect(frames[1]!.startsWith("event: unknown-cursor\n")).toBe(true);
    expect(JSON.parse(frames[1]!.split("data: ")[1]!)).toEqual({ detailCode: "cursor-unknown" });
    expect(frames).toHaveLength(2);
  });

  it("emits a typed cursor-too-old terminal event naming the cold-sync path, then closes", async () => {
    const tail = createInMemoryTailSource(2);
    for (let index = 0; index < 4; index += 1) tail.publish("announcement", `{"n":${index}}`);

    const response = openArchiveTailStream(
      new Request("http://host/sources/feed/tail?cursor=0000000000000001"),
      "feed",
      tail.source,
    );
    const frames = await drain(response, 5);
    expect(frames[1]!.startsWith("event: cursor-too-old\n")).toBe(true);
    expect(JSON.parse(frames[1]!.split("data: ")[1]!)).toEqual({
      detailCode: "cursor-too-old",
      coldSync: { head: "/sources/feed/head", archiveRoot: "/sources/feed/entries/0000000000000001" },
    });
    expect(frames).toHaveLength(2);
  });

  it("starts at the window start for cursor=oldest", async () => {
    const tail = createInMemoryTailSource(10);
    tail.publish("announcement", '{"n":1}');
    tail.publish("announcement", '{"n":2}');

    const response = openArchiveTailStream(
      new Request("http://host/sources/feed/tail?cursor=oldest"),
      "feed",
      tail.source,
    );
    const frames = await drain(response, 3);
    expect(frames[1]).toBe('id: 0000000000000001\nevent: announcement\ndata: {"n":1}');
    expect(frames[2]).toBe('id: 0000000000000002\nevent: announcement\ndata: {"n":2}');
  });
});
