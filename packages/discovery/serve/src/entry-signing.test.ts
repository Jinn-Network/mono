import { describe, expect, it } from "vitest";
import {
  DISCOVERY_SIGNING_SCOPE,
  MEDIA_ENTRY,
  RECORD_DISCOVERY_VERSION,
  RECORD_KINDS,
  dssePreAuthEncoding,
  parseAnnouncementEntry,
  recordDigest,
  sealJson,
} from "@jinn-network/record-discovery-protocol";

import { signAnnouncementEntry, type ScopedDiscoverySigner } from "./entry-signing.js";

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

describe("signAnnouncementEntry", () => {
  const recordBytes = new TextEncoder().encode("exact-record");
  const entry = parseAnnouncementEntry({
    protocol: RECORD_DISCOVERY_VERSION,
    source: { agent: "did:key:zSourceWriter", name: "native-feed" },
    sequence: "0000000000000001",
    previous: null,
    timestamp: "2026-08-03T12:00:00.000Z",
    announcements: [{
      announcementId: "ann-1",
      action: "available",
      record: { kind: RECORD_KINDS.submission, digest: recordDigest(recordBytes) },
    }],
  });

  it("preserves the marketplace implementation's exact DSSE bytes", async () => {
    const signer: ScopedDiscoverySigner = {
      scope: DISCOVERY_SIGNING_SCOPE,
      async sign(pae) {
        return [{ keyid: "key-1", sig: pae }];
      },
    };

    const result = await signAnnouncementEntry(entry, signer);
    const entryBytes = sealJson(entry).bytes;
    expect(result).toEqual({
      payloadType: MEDIA_ENTRY,
      payload: encodeBase64(entryBytes),
      signatures: [{
        keyid: "key-1",
        sig: encodeBase64(dssePreAuthEncoding(MEDIA_ENTRY, entryBytes)),
      }],
    });
  });

  it("rejects a signer that is not bound to the discovery scope", async () => {
    const signer = {
      scope: "jinn:not-discovery",
      async sign() {
        return [];
      },
    } as unknown as ScopedDiscoverySigner;

    await expect(signAnnouncementEntry(entry, signer)).rejects.toThrow(DISCOVERY_SIGNING_SCOPE);
  });
});
