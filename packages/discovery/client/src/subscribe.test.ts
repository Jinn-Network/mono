import { describe, expect, it } from "vitest";
import { loadVectorsByKind, runConsumerConformance, runSubscribeConformance } from "@jinn-network/record-discovery-testing";
import { announcementDedupeKey, toAnnouncementEvent } from "@jinn-network/record-discovery-protocol";
import type { AnnouncedItem, AnnouncementEntry } from "@jinn-network/record-discovery-protocol";
import { parseAnnouncementEntry } from "@jinn-network/record-discovery-protocol";

import type { StreamSubscription, StreamTransport, Transport, TransportResponse } from "./ports.js";
import {
  classifyCursor,
  classifyWithdrawal,
  checkLocator,
  createAnnouncementDedupe,
  createPullDebounce,
  shouldDowngradeRelay,
  spotCheckEntry,
  subscribe,
} from "./subscribe.js";

function makeRoutedTransport(routes: Map<string, TransportResponse>): Transport {
  return {
    async "fetch"(url: string): Promise<TransportResponse> {
      const response = routes.get(url);
      if (response === undefined) throw new Error(`no route seeded for ${url}`);
      return response;
    },
  };
}

describe("classifyCursor (§9.3: the five-case cursor contract)", () => {
  it("no cursor -> live tail from now", () => {
    expect(classifyCursor(undefined, 0)).toEqual({ behavior: "live-tail-from-now" });
  });

  it("unknown or future cursor (no known position) -> typed error, close", () => {
    expect(classifyCursor("cursor-never-issued", 10)).toEqual({ behavior: "typed-error-close" });
  });

  it("cursor within the replay window -> replay then live", () => {
    expect(classifyCursor("c", 10, 3)).toEqual({ behavior: "replay-then-live" });
  });

  it("cursor older than the window -> explicit cursor-too-old, never silent gap-skipping", () => {
    expect(classifyCursor("c", 10, -5)).toEqual({ behavior: "cursor-too-old", detailCode: "cursor-too-old" });
  });

  it("oldest requested -> start of window", () => {
    expect(classifyCursor("oldest", 10)).toEqual({ behavior: "start-of-window" });
  });
});

describe("checkLocator (§7/§14: hostile-locator guards)", () => {
  it("rejects a private/link-local address before fetching (SSRF)", async () => {
    const result = await checkLocator(
      { profile: "https://jinn.network/record-discovery/location/https/1.0", locator: "https://169.254.169.254/latest/meta-data/" },
      { transport: makeRoutedTransport(new Map()), maxBytes: 1 << 20 },
    );
    expect(result).toEqual({ rejected: true, reason: "private-address" });
  });

  it("rejects an oversized response", async () => {
    const locator = "https://example.org/records/huge-blob";
    const routes = new Map<string, TransportResponse>([[locator, { status: 200, contentType: "application/octet-stream", declaredLength: 5_368_709_120, bytes: new Uint8Array(0) }]]);
    const result = await checkLocator(
      { profile: "https://jinn.network/record-discovery/location/https/1.0", locator },
      { transport: makeRoutedTransport(routes), maxBytes: 1 << 20 },
    );
    expect(result).toEqual({ rejected: true, reason: "oversize" });
  });

  it("rejects an unexpected content type", async () => {
    const locator = "https://example.org/records/x";
    const routes = new Map<string, TransportResponse>([[locator, { status: 200, contentType: "text/html", bytes: new Uint8Array(10) }]]);
    const result = await checkLocator(
      { profile: "https://jinn.network/record-discovery/location/https/1.0", locator },
      { transport: makeRoutedTransport(routes), maxBytes: 1 << 20 },
    );
    expect(result).toEqual({ rejected: true, reason: "wrong-content-type" });
  });

  it("accepts a conforming https locator serving a reasonable, correctly-typed response", async () => {
    const locator = "https://example.org/records/ok";
    const routes = new Map<string, TransportResponse>([[locator, { status: 200, contentType: "application/octet-stream", bytes: new Uint8Array(10) }]]);
    const result = await checkLocator(
      { profile: "https://jinn.network/record-discovery/location/https/1.0", locator },
      { transport: makeRoutedTransport(routes), maxBytes: 1 << 20 },
    );
    expect(result).toEqual({ rejected: false });
  });
});

describe("shouldDowngradeRelay (§9.5 obligation 1: head-vs-delivered comparison)", () => {
  it("downgrades a relay whose delivered position lags the independently observed head", () => {
    expect(
      shouldDowngradeRelay({ sequence: "0000000000000005", entry: `sha256:${"a".repeat(64)}` }, { sequence: "0000000000000009", entry: `sha256:${"b".repeat(64)}` }),
    ).toBe(true);
  });

  it("does not downgrade a relay that is fully caught up", () => {
    const cursor = { sequence: "0000000000000005", entry: `sha256:${"a".repeat(64)}` as const };
    expect(shouldDowngradeRelay(cursor, cursor)).toBe(false);
  });
});

describe("spotCheckEntry (§9.5 obligation 2: entry-granular spot-check catches per-item-drop censoring)", () => {
  const fullEntry: AnnouncementEntry = parseAnnouncementEntry({
    protocol: "https://jinn.network/record-discovery/1.0",
    source: { agent: "did:key:zAgentSourceOne", name: "feed" },
    sequence: "0000000000000001",
    previous: null,
    timestamp: "2026-07-28T12:00:00.000Z",
    announcements: [
      { announcementId: "ann-1", action: "available", record: { kind: "https://jinn.network/records/submission/1.0", digest: `sha256:${"a".repeat(64)}` } },
      { announcementId: "ann-2", action: "available", record: { kind: "https://jinn.network/records/submission/1.0", digest: `sha256:${"b".repeat(64)}` } },
    ],
  });

  it("catches a relay that delivered every item except one", () => {
    const result = spotCheckEntry(fullEntry, new Set(["ann-1"]));
    expect(result).toEqual({ caught: true, missingAnnouncementIds: ["ann-2"] });
  });

  it("finds nothing wrong when every announced item was delivered", () => {
    const result = spotCheckEntry(fullEntry, new Set(["ann-1", "ann-2"]));
    expect(result).toEqual({ caught: false, missingAnnouncementIds: [] });
  });
});

describe("classifyWithdrawal (§5.1/§6.2: retrospective-kind pruning obligations)", () => {
  it("never prunes on a delisted withdrawal", () => {
    expect(classifyWithdrawal("delisted")).toEqual({ prune: false, recompute: false });
  });

  it("never prunes on a reorged withdrawal, but does trigger recompute", () => {
    expect(classifyWithdrawal("reorged")).toEqual({ prune: false, recompute: true });
  });
});

describe("createPullDebounce (consumer-side ping-flood debounce)", () => {
  it("allows at most one pull per debounce window regardless of how many pings arrived", () => {
    const debounce = createPullDebounce(5000);
    const start = new Date("2026-07-28T12:00:00.000Z");
    let pulls = 0;
    for (let i = 0; i < 50; i += 1) {
      if (debounce.shouldPull("https://example.org/head", new Date(start.getTime() + i * 100))) pulls += 1;
    }
    expect(pulls).toBe(1);
  });
});

function makeScriptedStreamTransport(): StreamTransport & { deliver(raw: string): void; closed: boolean } {
  let handler: ((raw: string) => void) | undefined;
  let closed = false;
  return {
    connect(_url, onMessage): StreamSubscription {
      handler = onMessage;
      return { close: () => { closed = true; } };
    },
    deliver(raw: string) {
      handler?.(raw);
    },
    get closed() {
      return closed;
    },
  };
}

describe("subscribe (§9.1/§9.4: dispatches announcement vs observation events, dedupes announcements)", () => {
  it("routes an announcement event to onAnnouncement and dedupes a redelivery", () => {
    const transport = makeScriptedStreamTransport();
    const announcements: unknown[] = [];
    const observations: unknown[] = [];
    subscribe({
      streamTransport: transport,
      url: "https://relay.example.org/subscribe",
      onAnnouncement: (event) => announcements.push(event),
      onObservation: (raw) => observations.push(raw),
    });

    const event = { specversion: "1.0", id: "ann-1", source: "did:key:zAgentSourceOne/feed", type: "network.jinn.record-discovery.announcement", subject: `sha256:${"a".repeat(64)}`, recordkind: "https://jinn.network/records/submission/1.0", sourceagent: "did:key:zAgentSourceOne", sourcename: "feed", entrydigest: `sha256:${"b".repeat(64)}`, announcementid: "ann-1", data: {} };
    transport.deliver(JSON.stringify(event));
    transport.deliver(JSON.stringify(event)); // redelivery, same tuple

    expect(announcements).toHaveLength(1);
    expect(observations).toHaveLength(0);
  });

  it("passes an observation event through unaltered (§9.1: a relay adds nothing)", () => {
    const transport = makeScriptedStreamTransport();
    const observations: unknown[] = [];
    subscribe({
      streamTransport: transport,
      url: "https://relay.example.org/subscribe",
      onAnnouncement: () => { throw new Error("should not route here"); },
      onObservation: (raw) => observations.push(raw),
    });

    const observation = { kind: "tep-lifecycle-observation", taskDigest: `sha256:${"c".repeat(64)}`, sequence: "0000000000000007" };
    transport.deliver(JSON.stringify(observation));

    expect(observations).toEqual([observation]);
  });

  it("closing the returned subscription closes the underlying stream", () => {
    const transport = makeScriptedStreamTransport();
    const subscription = subscribe({
      streamTransport: transport,
      url: "https://relay.example.org/subscribe",
      onAnnouncement: () => {},
      onObservation: () => {},
    });

    subscription.close();

    expect(transport.closed).toBe(true);
  });
});

describe("createAnnouncementDedupe (§9.1: (source identity, entry digest, announcementId))", () => {
  it("collapses a redelivered event with the same dedupe tuple", () => {
    const item: AnnouncedItem = {
      record: { kind: "https://jinn.network/records/submission/1.0", digest: `sha256:${"a".repeat(64)}` },
      provenance: { source: { agent: "did:key:zAgentSourceOne", name: "feed" }, entry: `sha256:${"b".repeat(64)}`, announcementId: "ann-1" },
    };
    const event = toAnnouncementEvent(item, undefined);
    const dedupe = createAnnouncementDedupe();

    expect(dedupe.isNew(event)).toBe(true);
    expect(dedupe.isNew(event)).toBe(false); // redelivery, same tuple
    expect(announcementDedupeKey(event)).toBe(`${event.sourceagent} ${event.sourcename} ${event.entrydigest} ${event.announcementid}`);
  });
});

describe("kit conformance", () => {
  runSubscribeConformance({
    async classifyCursor(cursor, replayWindowSize, cursorPosition) {
      return classifyCursor(cursor, replayWindowSize, cursorPosition);
    },
  });

  // The shared kit runner (`runConsumerConformance`) calls
  // `checkLocator(input.location)` with no other vector context, but two
  // of the three hostile-locator vectors need RESPONSE data
  // (`declaredBytes`/`servedContentType`) `checkLocator` can only learn
  // by actually fetching the locator through its injected Transport. This
  // seeds that Transport directly from the same §18 vector fixtures
  // (read here, not through the kit's runner) so all three vectors --
  // private-address (no fetch needed), oversize, and wrong-content-type
  // -- resolve correctly through the shared conformance suite.
  const locatorRoutes = new Map<string, TransportResponse>();
  for (const vector of loadVectorsByKind("consumer")) {
    const input = vector.input as { location?: { locator: string }; declaredBytes?: number; servedContentType?: string };
    if (input.location === undefined) continue;
    locatorRoutes.set(input.location.locator, {
      status: 200,
      contentType: input.servedContentType ?? "application/octet-stream",
      ...(input.declaredBytes === undefined ? {} : { declaredLength: input.declaredBytes }),
      bytes: new Uint8Array(0),
    });
  }
  runConsumerConformance({
    async checkLocator(location: unknown) {
      return checkLocator(location as { profile: string; locator: string }, { transport: makeRoutedTransport(locatorRoutes), maxBytes: 1 << 20 });
    },
  });
});
