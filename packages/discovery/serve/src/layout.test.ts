import { describe, expect, it } from "vitest";
import { recordDigest, recordPath, sealJson } from "@jinn-network/record-discovery-protocol";

import type { BlobStore } from "./ports.js";
import { writeRecord } from "./layout.js";

function makeInMemoryStore(): BlobStore & { get(path: string): { bytes: Uint8Array; contentType: string } | undefined } {
  const store = new Map<string, { bytes: Uint8Array; contentType: string }>();
  return {
    async put(path, bytes, contentType) {
      store.set(path, { bytes, contentType });
    },
    get(path) {
      return store.get(path);
    },
  };
}

describe("writeRecord (§7 item 1: records-by-digest)", () => {
  it("writes exact sealed bytes at the digest-derived path and round-trips by digest", async () => {
    const store = makeInMemoryStore();
    const { bytes } = sealJson({ b: 1, a: 2 });

    const result = await writeRecord(store, bytes);

    expect(result.digest).toBe(recordDigest(bytes));
    expect(result.path).toBe(recordPath(result.digest));
    const stored = store.get(result.path);
    expect(stored?.bytes).toEqual(bytes);
  });

  it("derives the same path for the same digest regardless of write order (one digest, one path)", async () => {
    const store = makeInMemoryStore();
    const { bytes } = sealJson({ x: "same" });

    const first = await writeRecord(store, bytes);
    const second = await writeRecord(store, bytes);

    expect(first.path).toBe(second.path);
  });
});
