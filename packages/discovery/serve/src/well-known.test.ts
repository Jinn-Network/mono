import { describe, expect, it } from "vitest";
import { WELL_KNOWN_PATH, sealJson } from "@jinn-network/record-discovery-protocol";

import type { BlobStore } from "./ports.js";
import type { WellKnownDocument } from "./well-known.js";
import { parseWellKnownDocument, writeWellKnownDocument } from "./well-known.js";

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

const VALID_DOCUMENT: WellKnownDocument = {
  protocol: "https://jinn.network/record-discovery/1.0",
  sources: [
    {
      agent: "did:key:zAgentSourceOne",
      name: "feed",
      headPath: "/sources/feed/head",
      archiveRoot: "/sources/feed/entries",
      confirmationDepth: 6,
      substrate: "base-mainnet",
    },
  ],
};

describe("parseWellKnownDocument (§7 item 3, in-protocol schema)", () => {
  it("accepts a well-formed document", () => {
    expect(parseWellKnownDocument(VALID_DOCUMENT)).toEqual(VALID_DOCUMENT);
  });

  it("accepts a source entry with no optional projection metadata", () => {
    const minimal: WellKnownDocument = {
      protocol: "https://jinn.network/record-discovery/1.0",
      sources: [{ agent: "did:key:zAgentSourceOne", name: "feed", headPath: "/sources/feed/head", archiveRoot: "/sources/feed/entries" }],
    };
    expect(() => parseWellKnownDocument(minimal)).not.toThrow();
  });

  it("rejects a document under the wrong protocol version", () => {
    expect(() => parseWellKnownDocument({ ...VALID_DOCUMENT, protocol: "https://jinn.network/record-discovery/9.9" })).toThrow();
  });

  it("rejects a source entry missing a required field", () => {
    const missingHeadPath = { protocol: VALID_DOCUMENT.protocol, sources: [{ agent: "a", name: "feed", archiveRoot: "/x" }] };
    expect(() => parseWellKnownDocument(missingHeadPath)).toThrow();
  });
});

describe("writeWellKnownDocument", () => {
  it("writes the sealed document at the fixed WELL_KNOWN_PATH", async () => {
    const store = makeInMemoryStore();
    await writeWellKnownDocument(store, VALID_DOCUMENT);

    const stored = store.get(WELL_KNOWN_PATH);
    expect(stored).toBeDefined();
    expect(stored!.bytes).toEqual(sealJson(VALID_DOCUMENT).bytes);
  });

  it("validates before writing -- an invalid document is rejected, not published", async () => {
    const store = makeInMemoryStore();
    const invalid = { protocol: VALID_DOCUMENT.protocol, sources: [{ agent: "a" }] } as unknown as WellKnownDocument;

    await expect(writeWellKnownDocument(store, invalid)).rejects.toThrow();
    expect(store.get(WELL_KNOWN_PATH)).toBeUndefined();
  });
});
