import { describe, expect, it } from "vitest";

import type { PingTransport } from "./ports.js";
import { createFixedWindowDebounce, emitPing } from "./ping.js";

function makeSpyTransport(): PingTransport & { announced: string[] } {
  const announced: string[] = [];
  return {
    announced,
    async announce(headUrl: string) {
      announced.push(headUrl);
    },
  };
}

describe("emitPing (§7 item 4: unauthenticated, debounced head-moved hints)", () => {
  it("emits a ping the first time within a debounce window", async () => {
    const transport = makeSpyTransport();
    const debounce = createFixedWindowDebounce(5000);

    const emitted = await emitPing(transport, "https://example.org/head", debounce, new Date("2026-07-28T12:00:00.000Z"));

    expect(emitted).toBe(true);
    expect(transport.announced).toEqual(["https://example.org/head"]);
  });

  it("suppresses further pings for the same head URL within one debounce window", async () => {
    const transport = makeSpyTransport();
    const debounce = createFixedWindowDebounce(5000);
    const start = new Date("2026-07-28T12:00:00.000Z");

    for (let i = 0; i < 50; i += 1) {
      await emitPing(transport, "https://example.org/head", debounce, new Date(start.getTime() + i * 100));
    }

    expect(transport.announced).toEqual(["https://example.org/head"]);
  });

  it("emits again once a fresh debounce window has elapsed", async () => {
    const transport = makeSpyTransport();
    const debounce = createFixedWindowDebounce(5000);
    const start = new Date("2026-07-28T12:00:00.000Z");

    await emitPing(transport, "https://example.org/head", debounce, start);
    await emitPing(transport, "https://example.org/head", debounce, new Date(start.getTime() + 6000));

    expect(transport.announced).toEqual(["https://example.org/head", "https://example.org/head"]);
  });

  it("debounces independently per head URL", async () => {
    const transport = makeSpyTransport();
    const debounce = createFixedWindowDebounce(5000);
    const at = new Date("2026-07-28T12:00:00.000Z");

    await emitPing(transport, "https://example.org/a/head", debounce, at);
    await emitPing(transport, "https://example.org/b/head", debounce, at);

    expect(transport.announced).toEqual(["https://example.org/a/head", "https://example.org/b/head"]);
  });
});
