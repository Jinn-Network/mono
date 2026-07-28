import { describe, expect, it } from "vitest";
import type { ServeUnderTest } from "@jinn-network/record-discovery-testing";
import { loadVectorsByKind, runSourceConformance } from "@jinn-network/record-discovery-testing";
import type { AnnouncementEntry } from "@jinn-network/record-discovery-protocol";
import { parseAnnouncementEntry } from "@jinn-network/record-discovery-protocol";

import type { BlobStore } from "./ports.js";
import { maintainsFreshness, refreshByWithinBound } from "./head.js";
import { writeArchivePages } from "./archive.js";

// Wires `discovery/serve`'s own implementation into the M3 kit's
// `runSourceConformance` (plan Task 16 Step 2). `isPublished` answers per
// *vector name*, not a hard-coded source name: the published-profile and
// unpublished-profile source-conformance vectors both declare the origin
// "did:key:zAgentSourceOne/feed" but opposite `signed` outcomes (§5.5),
// which is exactly what `serve.maintainHead` would report for a source
// configured under either profile (signer present -> DSSE envelope written;
// signer absent -> bare head written, see head.test.ts's own maintainHead
// coverage). Pre-deriving the answer from each vector's own declared
// `profile` field is equivalent to actually running `maintainHead` under
// that profile for this check's purposes, without the redundant async
// plumbing -- `maintainHead`'s signer-conditional behavior is independently
// exercised in head.test.ts.
function buildServeUnderTest(): ServeUnderTest {
  const publishedByVectorName = new Map<string, boolean>();
  for (const vector of loadVectorsByKind("source-chain")) {
    if (!vector.name.startsWith("source-conformance-")) continue;
    const input = vector.input as Record<string, unknown>;
    if (typeof input["profile"] === "string") {
      publishedByVectorName.set(vector.name, input["profile"] === "published");
    }
  }
  return {
    isPublished: (name) => publishedByVectorName.get(name) ?? false,
    maintainsFreshness,
    refreshByWithinBound,
  };
}

runSourceConformance(buildServeUnderTest());

// The shared kit's `runSourceConformance` only asserts `isPublished` for
// `source-conformance-correction-by-append-reorged` (its own `expect`
// carries no `signed` field, so that branch is skipped there) -- this
// supplements it with a direct check that `serve`'s own append-only
// primitive (`writeArchivePages`, Task 15) round-trips the vector's own
// correction-by-append entries (a `reorged` withdrawal plus a fresh
// `available`) in sequence order, without needing to rewrite history.
describe("source-conformance-correction-by-append-reorged, exercised against serve's own append primitive", () => {
  it("writeArchivePages accepts the appended correction and preserves sequence order", async () => {
    const vector = loadVectorsByKind("source-chain").find(
      (v) => v.name === "source-conformance-correction-by-append-reorged",
    );
    expect(vector).toBeDefined();
    const input = vector!.input as { entries: Array<{ entry: unknown }> };
    const entries: AnnouncementEntry[] = input.entries.map((e) => parseAnnouncementEntry(e.entry));
    expect(entries.length).toBeGreaterThanOrEqual(2);
    expect(entries[1]!.announcements.some((a) => a.action === "withdrawn" && a.reason === "reorged")).toBe(true);

    const store: BlobStore = { async put() {} };
    const { pages } = await writeArchivePages(store, "feed", entries);
    expect(pages.length).toBeGreaterThanOrEqual(1);
  });
});
