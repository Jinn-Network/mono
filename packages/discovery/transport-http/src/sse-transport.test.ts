import { describe, expect, it } from "vitest";

import type { FetchLike } from "./ports.js";
import { createInMemoryTailSource } from "./tail.js";
import { openArchiveTailStream } from "./sse.js";
import { SseFrameOverflowError, SseTerminalError, createSseStreamTransport } from "./sse-transport.js";

function waitFor(predicate: () => boolean, label: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 2000;
    const tick = () => {
      if (predicate()) { resolve(); return; }
      if (Date.now() > deadline) { reject(new Error(`timed out waiting for ${label}`)); return; }
      setTimeout(tick, 5);
    };
    tick();
  });
}

/**
 * Wraps a Response's body so the connection ends after `idleMs` with no new
 * chunk, instead of staying open forever. `openArchiveTailStream`'s live
 * tail never closes on its own (correctly -- a real SSE connection stays
 * open until the network drops it); an in-process loopback has no network
 * layer to drop it, so tests that exercise reconnect-after-disconnect need
 * this to simulate an idle-timed-out proxy/connection.
 */
function withIdleTimeout(response: Response, idleMs: number): Response {
  const upstream = response.body;
  if (upstream === null) return response;
  const reader = upstream.getReader();
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const outcome = await Promise.race([
        reader.read().then((result) => ({ kind: "read" as const, result })),
        new Promise<{ kind: "idle" }>((resolve) => setTimeout(() => resolve({ kind: "idle" }), idleMs)),
      ]);
      if (cancelled) return;
      if (outcome.kind === "idle") {
        await reader.cancel().catch(() => undefined);
        controller.close();
        return;
      }
      if (outcome.result.done) {
        controller.close();
        return;
      }
      controller.enqueue(outcome.result.value);
    },
    cancel(reason) {
      cancelled = true;
      return reader.cancel(reason);
    },
  });
  return new Response(body, { status: response.status, headers: response.headers });
}

/** Serves the real SSE endpoint over an in-process fetch, so the parser is tested against the real writer. */
function loopback(tailSource: ReturnType<typeof createInMemoryTailSource>): {
  fetchLike: FetchLike;
  lastEventIds: Array<string | undefined>;
} {
  const lastEventIds: Array<string | undefined> = [];
  return {
    lastEventIds,
    async fetchLike(url, init) {
      lastEventIds.push(init?.headers?.["last-event-id"]);
      const request = new Request(url, {
        headers: init?.headers ?? {},
        ...(init?.signal === undefined ? {} : { signal: init.signal }),
      });
      return withIdleTimeout(openArchiveTailStream(request, "feed", tailSource.source), 30);
    },
  };
}

describe("createSseStreamTransport", () => {
  it("delivers each event's data payload to onMessage", async () => {
    const tail = createInMemoryTailSource(10);
    const transport = createSseStreamTransport("https://archive.example", loopback(tail).fetchLike);
    const seen: string[] = [];

    const subscription = transport.connect("/sources/feed/tail", (raw) => seen.push(raw), () => undefined);
    await waitFor(() => seen.length === 0, "the stream to open");
    tail.publish("announcement", '{"n":1}');
    tail.publish("observation", '{"n":2}');
    await waitFor(() => seen.length === 2, "two delivered events");
    subscription.close();

    expect(seen).toEqual(['{"n":1}', '{"n":2}']);
  });

  it("resumes with Last-Event-ID after a disconnect", async () => {
    const tail = createInMemoryTailSource(10);
    tail.publish("announcement", '{"n":1}');
    const link = loopback(tail);
    const transport = createSseStreamTransport("https://archive.example", link.fetchLike, { reconnectDelayMs: 1 });
    const seen: string[] = [];

    const subscription = transport.connect("/sources/feed/tail?cursor=oldest", (raw) => seen.push(raw), () => undefined);
    await waitFor(() => seen.length === 1, "the replayed event");

    // The in-process stream ends when the tail source's buffer is
    // consumed and the underlying ReadableStream is closed by the peer;
    // publish after the reconnect to prove the resume carried the cursor.
    await waitFor(() => link.lastEventIds.length >= 2, "a reconnect");
    expect(link.lastEventIds[0]).toBeUndefined();
    expect(link.lastEventIds[1]).toBe("0000000000000001");
    subscription.close();
  });

  it("reports a typed terminal event to onError and does not reconnect", async () => {
    const tail = createInMemoryTailSource(2);
    for (let index = 0; index < 4; index += 1) tail.publish("announcement", `{"n":${index}}`);
    const link = loopback(tail);
    const transport = createSseStreamTransport("https://archive.example", link.fetchLike, { reconnectDelayMs: 1 });
    const errors: unknown[] = [];

    const subscription = transport.connect(
      "/sources/feed/tail?cursor=0000000000000001",
      () => undefined,
      (error) => errors.push(error),
    );
    await waitFor(() => errors.length === 1, "the terminal error");
    subscription.close();

    const [error] = errors;
    expect(error).toBeInstanceOf(SseTerminalError);
    expect((error as SseTerminalError).terminal).toBe("cursor-too-old");
    expect((error as SseTerminalError).coldSync).toEqual({
      head: "/sources/feed/head",
      // The relay names the cold-sync root by the CLIENT's requested cursor
      // (echoed back), not the window's current oldest -- see sse.test.ts's
      // identical "cursor-too-old" case (same capacity/publish sequence),
      // which asserts the same "entries/0000000000000001" for this exact
      // scenario. This is `coldSyncHint`'s real, already-shipped behavior
      // (sse.ts, Task 8), which Task 11's test text mis-stated.
      archiveRoot: "/sources/feed/entries/0000000000000001",
    });
    expect(link.lastEventIds).toHaveLength(1);
  });

  it("reports an unknown cursor as a typed terminal error", async () => {
    const tail = createInMemoryTailSource(10);
    tail.publish("announcement", '{"n":1}');
    const transport = createSseStreamTransport("https://archive.example", loopback(tail).fetchLike, { reconnectDelayMs: 1 });
    const errors: unknown[] = [];

    const subscription = transport.connect(
      "/sources/feed/tail?cursor=0000000000000099",
      () => undefined,
      (error) => errors.push(error),
    );
    await waitFor(() => errors.length === 1, "the terminal error");
    subscription.close();

    expect((errors[0] as SseTerminalError).terminal).toBe("unknown-cursor");
  });

  it("stops delivering after close()", async () => {
    const tail = createInMemoryTailSource(10);
    const transport = createSseStreamTransport("https://archive.example", loopback(tail).fetchLike);
    const seen: string[] = [];

    const subscription = transport.connect("/sources/feed/tail", (raw) => seen.push(raw), () => undefined);
    tail.publish("announcement", '{"n":1}');
    await waitFor(() => seen.length === 1, "the first event");
    subscription.close();
    tail.publish("announcement", '{"n":2}');
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(seen).toEqual(['{"n":1}']);
  });

  it("closes a stream that never terminates a frame, instead of buffering it forever", async () => {
    // A relay that sends an endless `data:` line with no blank-line
    // terminator would otherwise grow the pending buffer without limit in
    // a daemon that is doing nothing but listening.
    let chunksPulled = 0;
    const fetchLike: FetchLike = async () => new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        chunksPulled += 1;
        controller.enqueue(new TextEncoder().encode(chunksPulled === 1 ? "data: " : "x".repeat(512)));
      },
    }), { status: 200, headers: { "content-type": "text/event-stream" } });

    const transport = createSseStreamTransport("https://archive.example", fetchLike, {
      maxFrameBytes: 2048,
      reconnectDelayMs: 1,
    });
    const errors: unknown[] = [];
    const seen: string[] = [];

    const subscription = transport.connect("/sources/feed/tail", (raw) => seen.push(raw), (error) => errors.push(error));
    await waitFor(() => errors.length === 1, "the frame-overflow error");
    subscription.close();

    expect(errors[0]).toBeInstanceOf(SseFrameOverflowError);
    expect(seen).toEqual([]);
    // Terminal, not a reconnect loop: no second error follows.
    const pulledAtStop = chunksPulled;
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(errors).toHaveLength(1);
    expect(chunksPulled).toBe(pulledAtStop);
  });
});
