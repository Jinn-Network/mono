// Leaf facts-conformance at the public verifyItem / facts-consistency boundary, mirroring
// `packages/discovery/facts/benchmarking/src/facts-conformance.test.ts`: kit `digestOf` +
// `makeInMemoryPorts` supply the AnnouncementEntry chain and the unused keys/sigs stubs,
// while this leaf's own recompute and a byte-exact RecordFetcher are injected at verifyItem.
import { ENVIRONMENT_RECORD_KIND, sealEnvironmentRecord } from "@jinn-network/environment-record";
import {
  GENESIS_SEQUENCE,
  RECORD_DISCOVERY_VERSION,
  recordDigest,
  verifyItem,
} from "@jinn-network/record-discovery-protocol";
import type {
  AnnouncedItem,
  AnnouncementEntry,
  ItemOutcome,
  RecordFetcher,
} from "@jinn-network/record-discovery-protocol";
import { digestOf, makeInMemoryPorts } from "@jinn-network/record-discovery-testing";
import { describe, expect, it } from "vitest";

import { environmentFactsProfile } from "./profiles.js";
import { ENVIRONMENTS_FACTS_RECOMPUTE } from "./recompute.js";

const SOURCE = { agent: "did:key:zEnvironmentFactsConformance", name: "facts" };
const MANIFEST = `sha256:${"1".repeat(64)}`;

const document = {
  kind: ENVIRONMENT_RECORD_KIND,
  source: {
    repo: "example-org/example-lib",
    repoUrl: "https://github.com/example-org/example-lib",
    commit: "0".repeat(39) + "1",
  },
  image: { manifestDigest: MANIFEST, platform: "linux/amd64" },
  workspace: "/testbed",
  invocations: { test: [{ bin: "make", args: ["test"] }] },
  parser: { id: "pytest-text", version: "1.0.0", digest: `sha256:${"3".repeat(64)}` },
  build: { reproducibilityTier: 0 },
  rights: { sourceLicense: "Apache-2.0" },
};

async function verify(facts: Record<string, unknown>): Promise<ItemOutcome> {
  const bytes = sealEnvironmentRecord(document);
  const digest = recordDigest(bytes);
  const entry: AnnouncementEntry = {
    protocol: RECORD_DISCOVERY_VERSION,
    source: SOURCE,
    sequence: GENESIS_SEQUENCE,
    previous: null,
    timestamp: "2026-07-31T12:00:00Z",
    announcements: [
      { announcementId: "ann-environment", action: "available", record: { kind: ENVIRONMENT_RECORD_KIND, digest } },
    ],
  };
  const entryDigest = digestOf(entry);
  const kitPorts = makeInMemoryPorts({ entries: { [entryDigest]: entry } });

  const records: RecordFetcher = {
    async "fetch"(requested) {
      if (requested === digest) return bytes;
      throw new Error(`no record seeded for ${requested}`);
    },
  };

  const item: AnnouncedItem = {
    record: { kind: ENVIRONMENT_RECORD_KIND, digest },
    facts,
    provenance: { source: SOURCE, entry: entryDigest, announcementId: "ann-environment" },
  };

  return verifyItem({
    item,
    profile: environmentFactsProfile,
    decisionGrade: false,
    ports: {
      records,
      entries: kitPorts.entries,
      keys: kitPorts.keys,
      sigs: kitPorts.sigs,
      factsRecompute: ENVIRONMENTS_FACTS_RECOMPUTE,
      verifiedChain: async () => true,
    },
  });
}

describe("facts/environments leaf conformance via verifyItem", () => {
  it("consistent: a truthful card matches the recomputed facts", async () => {
    const bytes = sealEnvironmentRecord(document);
    expect(
      await verify({
        environmentRecordDigest: recordDigest(bytes),
        "source.repo": "example-org/example-lib",
        "source.commit": "0".repeat(39) + "1",
        "image.manifestDigest": MANIFEST,
        "image.platform": "linux/amd64",
        "build.reproducibilityTier": 0,
      }),
    ).toEqual({ status: "verified", facts: "consistent" });
  });

  it("inconsistent: a card claiming a different image", async () => {
    const bytes = sealEnvironmentRecord(document);
    expect(
      await verify({
        environmentRecordDigest: recordDigest(bytes),
        "source.repo": "example-org/example-lib",
        "source.commit": "0".repeat(39) + "1",
        "image.manifestDigest": `sha256:${"9".repeat(64)}`,
        "image.platform": "linux/amd64",
        "build.reproducibilityTier": 0,
      }),
    ).toEqual({ status: "verified", facts: "inconsistent" });
  });

  it("inconsistent: a card overstating the reproducibility tier", async () => {
    const bytes = sealEnvironmentRecord(document);
    expect(
      await verify({
        environmentRecordDigest: recordDigest(bytes),
        "source.repo": "example-org/example-lib",
        "source.commit": "0".repeat(39) + "1",
        "image.manifestDigest": MANIFEST,
        "image.platform": "linux/amd64",
        "build.reproducibilityTier": 2,
      }),
    ).toEqual({ status: "verified", facts: "inconsistent" });
  });
});
