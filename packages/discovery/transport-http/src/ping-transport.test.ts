import { describe, expect, it } from "vitest";
import { createFixedWindowDebounce, emitPing } from "@jinn-network/record-discovery-serve";

import type { FetchLike } from "./ports.js";
import { PingDeliveryError, createHttpPingTransport } from "./ping-transport.js";

function stub(status: number): { fetchLike: FetchLike; bodies: string[] } {
  const bodies: string[] = [];
  return {
    bodies,
    async fetchLike(_url, init) {
      bodies.push(init?.body ?? "");
      return new Response(null, { status });
    },
  };
}

describe("createHttpPingTransport", () => {
  it("POSTs the moved head URL as JSON", async () => {
    const stubbed = stub(202);
    const transport = createHttpPingTransport("https://relay.example/ping", stubbed.fetchLike);
    await transport.announce("https://archive.example/sources/feed/head");
    expect(JSON.parse(stubbed.bodies[0]!)).toEqual({ headUrl: "https://archive.example/sources/feed/head" });
  });

  it("throws a typed error on a non-2xx status", async () => {
    const transport = createHttpPingTransport("https://relay.example/ping", stub(500).fetchLike);
    await expect(transport.announce("https://archive.example/sources/feed/head"))
      .rejects.toBeInstanceOf(PingDeliveryError);
  });

  it("plugs into serve's producer-side debounce", async () => {
    const stubbed = stub(202);
    const transport = createHttpPingTransport("https://relay.example/ping", stubbed.fetchLike);
    const debounce = createFixedWindowDebounce(60_000);
    const headUrl = "https://archive.example/sources/feed/head";

    expect(await emitPing(transport, headUrl, debounce, new Date("2026-07-30T12:00:00Z"))).toBe(true);
    expect(await emitPing(transport, headUrl, debounce, new Date("2026-07-30T12:00:30Z"))).toBe(false);
    expect(stubbed.bodies).toHaveLength(1);
  });
});
