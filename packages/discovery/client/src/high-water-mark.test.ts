import { describe, expect, it } from "vitest";
import type { SourceIdentity } from "@jinn-network/record-discovery-protocol";

import { createInMemoryHighWaterMarkStore } from "./high-water-mark.js";

const SOURCE: SourceIdentity = { agent: "did:key:zAgentSourceOne", name: "feed" };
const ISSUED_AT = "2026-07-28T12:00:00.000Z";

describe("createInMemoryHighWaterMarkStore (§5.3 rule 4 chain-position cursor, plus §5.2 issuedAt)", () => {
  it("returns undefined for a source with no recorded position", async () => {
    const store = createInMemoryHighWaterMarkStore();
    expect(await store.get(SOURCE)).toBeUndefined();
  });

  it("round-trips a put mark", async () => {
    const store = createInMemoryHighWaterMarkStore();
    const mark = { sequence: "0000000000000003", entry: `sha256:${"a".repeat(64)}` as const, issuedAt: ISSUED_AT };

    await store.put(SOURCE, mark);

    expect(await store.get(SOURCE)).toEqual(mark);
  });

  it("keeps positions independent per source identity", async () => {
    const store = createInMemoryHighWaterMarkStore();
    const other: SourceIdentity = { agent: "did:key:zAgentSourceTwo", name: "feed" };
    const markA = { sequence: "0000000000000001", entry: `sha256:${"a".repeat(64)}` as const, issuedAt: ISSUED_AT };
    const markB = { sequence: "0000000000000002", entry: `sha256:${"b".repeat(64)}` as const, issuedAt: ISSUED_AT };

    await store.put(SOURCE, markA);
    await store.put(other, markB);

    expect(await store.get(SOURCE)).toEqual(markA);
    expect(await store.get(other)).toEqual(markB);
  });

  it("overwrites a prior position on a later put", async () => {
    const store = createInMemoryHighWaterMarkStore();
    await store.put(SOURCE, { sequence: "0000000000000001", entry: `sha256:${"a".repeat(64)}`, issuedAt: ISSUED_AT });
    await store.put(SOURCE, {
      sequence: "0000000000000002",
      entry: `sha256:${"b".repeat(64)}`,
      issuedAt: "2026-07-29T00:00:00.000Z",
    });

    expect(await store.get(SOURCE)).toEqual({
      sequence: "0000000000000002",
      entry: `sha256:${"b".repeat(64)}`,
      issuedAt: "2026-07-29T00:00:00.000Z",
    });
  });
});
