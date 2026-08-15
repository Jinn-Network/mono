import { describe, expect, it } from "vitest";
import type { ServeUnderTest } from "@jinn-network/record-discovery-testing";
import { loadVectorsByKind, runSourceConformance } from "@jinn-network/record-discovery-testing";
import { maintainsFreshness, refreshByWithinBound } from "@jinn-network/record-discovery-serve";
import type { BlobStore, Clock, DsseSigner } from "@jinn-network/record-discovery-serve";
import type { AnnouncementEntry, SourceIdentity } from "@jinn-network/record-discovery-protocol";
import { GENESIS_SEQUENCE, RECORD_DISCOVERY_VERSION } from "@jinn-network/record-discovery-protocol";

import { publish } from "./publish.js";

// Wires `sources/evidence-journal`'s own `publish()` into the M3 kit's
// `runSourceConformance` (plan Task 25 Step 4: "Run ... the kit's
// runSourceConformance against the wrapper's published output"). Unlike
// `record-discovery-serve`'s own equivalent test (which checks `serve`'s
// raw primitives directly), `isPublished` here is derived by actually
// CALLING this package's `publish()` -- proving the wrapper's own call site
// produces a signed head under the published profile and a bare head under
// the unpublished profile, not merely that the underlying `serve` toolkit
// can.

function makeInMemoryStore(): BlobStore {
  const store = new Map<string, { bytes: Uint8Array; contentType: string }>();
  return {
    async put(path, bytes, contentType) {
      store.set(path, { bytes, contentType });
    },
  };
}

function makeClock(iso: string): Clock {
  return { now: () => new Date(iso) };
}

function makeSigner(keyid: string): DsseSigner {
  return {
    async sign(pae: Uint8Array) {
      return [{ keyid, sig: pae }];
    },
  };
}

const SOURCE: SourceIdentity = { agent: "did:key:zAgentSourceOne", name: "feed" };

function genesisEntry(): AnnouncementEntry {
  return {
    protocol: RECORD_DISCOVERY_VERSION,
    source: SOURCE,
    sequence: GENESIS_SEQUENCE,
    previous: null,
    timestamp: "2026-07-28T12:00:00.000Z",
    announcements: [
      {
        announcementId: "ann-1",
        action: "available",
        record: { kind: "https://spec.jinn.network/records/submission/v1", digest: `sha256:${"a".repeat(64)}` },
      },
    ],
  };
}

async function isPublishedViaWrapper(profile: "published" | "unpublished"): Promise<boolean> {
  const result = await publish({
    store: makeInMemoryStore(),
    clock: makeClock("2026-07-28T12:00:00.000Z"),
    signer: profile === "published" ? makeSigner("key-1") : undefined,
    source: SOURCE,
    entries: [genesisEntry()],
    previousHead: undefined,
  });
  return result.headEnvelope !== undefined;
}

async function buildServeUnderTest(): Promise<ServeUnderTest> {
  const publishedByVectorName = new Map<string, boolean>();
  for (const vector of loadVectorsByKind("source-chain")) {
    if (!vector.name.startsWith("source-conformance-")) continue;
    const input = vector.input as Record<string, unknown>;
    if (input["profile"] === "published" || input["profile"] === "unpublished") {
      publishedByVectorName.set(vector.name, await isPublishedViaWrapper(input["profile"]));
    }
  }
  return {
    isPublished: (name) => publishedByVectorName.get(name) ?? false,
    maintainsFreshness,
    refreshByWithinBound,
  };
}

runSourceConformance(await buildServeUnderTest());

describe("publish() reproduces the vectors' own published/unpublished expectation", () => {
  it("published profile: headEnvelope present, matching the source-conformance-published-profile vector's signed=true", async () => {
    expect(await isPublishedViaWrapper("published")).toBe(true);
  });

  it("unpublished profile: no headEnvelope, matching the source-conformance-unpublished-profile vector's signed=false", async () => {
    expect(await isPublishedViaWrapper("unpublished")).toBe(false);
  });
});
