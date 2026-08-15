import { describe, expect, it } from "vitest";
import { RECORD_DISCOVERY_VERSION } from "@jinn-network/record-discovery-protocol";
import type { WellKnownDocument } from "@jinn-network/record-discovery-serve";
import { parseWellKnownDocument } from "@jinn-network/record-discovery-serve";

import { createInMemoryTailSource } from "./tail.js";
import { advertiseReplayWindow, withReplayWindowAdvertisements } from "./advertise.js";

const DOCUMENT: WellKnownDocument = {
  protocol: RECORD_DISCOVERY_VERSION,
  sources: [
    { agent: "did:key:zA", name: "feed", headPath: "/sources/feed/head", archiveRoot: "/sources/feed/entries/0000000000000001" },
    { agent: "did:key:zA", name: "corpus", headPath: "/sources/corpus/head", archiveRoot: "/sources/corpus/entries/0000000000000001" },
  ],
};

describe("advertiseReplayWindow", () => {
  it("advertises the bounded window, its tail path, and the relay-local cursor scope", () => {
    const tail = createInMemoryTailSource(64);
    expect(advertiseReplayWindow("feed", tail.source.window())).toEqual({
      tailPath: "/sources/feed/tail",
      cursorScope: "relay-local",
      capacity: 64,
    });
  });
});

describe("withReplayWindowAdvertisements", () => {
  it("decorates only the named sources and leaves the rest untouched", () => {
    const tail = createInMemoryTailSource(16);
    const decorated = withReplayWindowAdvertisements(DOCUMENT, { feed: tail.source.window() });

    expect(decorated.sources[0]).toEqual({
      ...DOCUMENT.sources[0],
      replayWindow: { tailPath: "/sources/feed/tail", cursorScope: "relay-local", capacity: 16 },
    });
    expect(decorated.sources[1]).toEqual(DOCUMENT.sources[1]);
  });

  it("does not mutate the input document", () => {
    const tail = createInMemoryTailSource(16);
    withReplayWindowAdvertisements(DOCUMENT, { feed: tail.source.window() });
    expect(DOCUMENT.sources[0]).not.toHaveProperty("replayWindow");
  });

  it("still validates against serve's in-protocol well-known schema", () => {
    const tail = createInMemoryTailSource(16);
    const decorated = withReplayWindowAdvertisements(DOCUMENT, { feed: tail.source.window() });
    expect(() => parseWellKnownDocument(decorated)).not.toThrow();
  });
});
