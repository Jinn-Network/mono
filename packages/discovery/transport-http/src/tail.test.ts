import { describe, expect, it } from "vitest";
import type { SubscribeClientUnderTest } from "@jinn-network/record-discovery-testing";
import { runSubscribeConformance } from "@jinn-network/record-discovery-testing";

import { classifyTailCursor, createInMemoryTailSource } from "./tail.js";

// The server side of the §9.3 cursor contract answers the same five
// cases as `client`'s consumer-side `classifyCursor`, so it is driven by
// the same kit suite. The adapter turns the kit's
// `(cursor, replayWindowSize, cursorPosition)` triple into this
// package's `(cursor, window, cursorPosition)` shape.
const underTest: SubscribeClientUnderTest = {
  async classifyCursor(cursor, replayWindowSize, cursorPosition) {
    return classifyTailCursor(
      cursor,
      { capacity: replayWindowSize, size: replayWindowSize },
      cursorPosition,
    );
  },
};

runSubscribeConformance(underTest);

describe("createInMemoryTailSource", () => {
  it("assigns fixed-width relay-local cursors and advertises a bounded window", () => {
    const tail = createInMemoryTailSource(3);
    expect(tail.source.window()).toEqual({ capacity: 3, size: 0 });

    const first = tail.publish("announcement", '{"id":1}');
    expect(first.cursor).toBe("0000000000000001");
    tail.publish("announcement", '{"id":2}');

    expect(tail.source.window()).toEqual({
      capacity: 3, size: 2, oldestCursor: "0000000000000001", newestCursor: "0000000000000002",
    });
  });

  it("evicts oldest-first at capacity and reports evicted cursors as too old", () => {
    const tail = createInMemoryTailSource(2);
    for (let index = 0; index < 4; index += 1) tail.publish("announcement", `{"id":${index}}`);

    expect(tail.source.window()).toEqual({
      capacity: 2, size: 2, oldestCursor: "0000000000000003", newestCursor: "0000000000000004",
    });
    expect(tail.source.locate("0000000000000001")).toBe(-1);
    expect(tail.source.locate("0000000000000003")).toBe(0);
    expect(tail.source.locate("0000000000000004")).toBe(1);
  });

  it("reports a never-issued or future cursor as unknown", () => {
    const tail = createInMemoryTailSource(5);
    tail.publish("announcement", '{"id":1}');
    expect(tail.source.locate("0000000000000009")).toBeUndefined();
    expect(tail.source.locate("not-a-cursor")).toBeUndefined();
  });

  it("replays from an offset, oldest first", () => {
    const tail = createInMemoryTailSource(5);
    for (let index = 1; index <= 3; index += 1) tail.publish("announcement", `{"id":${index}}`);
    expect(tail.source.replayFrom(1).map((event) => event.data)).toEqual(['{"id":2}', '{"id":3}']);
  });

  it("delivers live events to subscribers until unsubscribed", () => {
    const tail = createInMemoryTailSource(5);
    const seen: string[] = [];
    const unsubscribe = tail.source.subscribe((event) => seen.push(event.data));
    tail.publish("announcement", '{"id":1}');
    unsubscribe();
    tail.publish("announcement", '{"id":2}');
    expect(seen).toEqual(['{"id":1}']);
  });
});

describe("classifyTailCursor", () => {
  it("resolves a live window position into a replay offset", () => {
    const decision = classifyTailCursor("0000000000000003", { capacity: 5, size: 5 }, 2);
    expect(decision).toEqual({ behavior: "replay-then-live", replayFromOffset: 3 });
  });

  it("resolves `oldest` to the start of the window", () => {
    expect(classifyTailCursor("oldest", { capacity: 5, size: 5 }, undefined))
      .toEqual({ behavior: "start-of-window", replayFromOffset: 0 });
  });
});
