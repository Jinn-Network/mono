import { describe, expect, it } from "vitest";
import type { SourceIdentity } from "@jinn-network/record-discovery-protocol";

import { createInMemoryHighWaterMarkStore } from "./high-water-mark.js";

const SOURCE: SourceIdentity = { agent: "did:key:zAgentSourceOne", name: "feed" };

describe("createInMemoryHighWaterMarkStore (§5.3 rule 4: the source position cursor)", () => {
  it("returns undefined for a source with no recorded position", async () => {
    const store = createInMemoryHighWaterMarkStore();
    expect(await store.get(SOURCE)).toBeUndefined();
  });

  it("round-trips a put cursor", async () => {
    const store = createInMemoryHighWaterMarkStore();
    const cursor = { sequence: "0000000000000003", entry: `sha256:${"a".repeat(64)}` as const };

    await store.put(SOURCE, cursor);

    expect(await store.get(SOURCE)).toEqual(cursor);
  });

  it("keeps positions independent per source identity", async () => {
    const store = createInMemoryHighWaterMarkStore();
    const other: SourceIdentity = { agent: "did:key:zAgentSourceTwo", name: "feed" };
    const cursorA = { sequence: "0000000000000001", entry: `sha256:${"a".repeat(64)}` as const };
    const cursorB = { sequence: "0000000000000002", entry: `sha256:${"b".repeat(64)}` as const };

    await store.put(SOURCE, cursorA);
    await store.put(other, cursorB);

    expect(await store.get(SOURCE)).toEqual(cursorA);
    expect(await store.get(other)).toEqual(cursorB);
  });

  it("overwrites a prior position on a later put", async () => {
    const store = createInMemoryHighWaterMarkStore();
    await store.put(SOURCE, { sequence: "0000000000000001", entry: `sha256:${"a".repeat(64)}` });
    await store.put(SOURCE, { sequence: "0000000000000002", entry: `sha256:${"b".repeat(64)}` });

    expect(await store.get(SOURCE)).toEqual({ sequence: "0000000000000002", entry: `sha256:${"b".repeat(64)}` });
  });
});
