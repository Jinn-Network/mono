// Leaf facts-conformance at the public verifyItem / facts-consistency boundary, mirroring
// `packages/discovery/facts/environments/src/facts-conformance.test.ts`: the kit's `digestOf`
// and `makeInMemoryPorts` supply the AnnouncementEntry chain and the unused keys/sigs stubs,
// while this leaf's own recompute and a byte-exact RecordFetcher are injected at verifyItem.
import {
  CHAIN_ENVIRONMENT_KIND,
  prefixedDigest,
  sealChainEnvironmentRecord,
} from "@jinn-network/chain-environment-record";
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
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import { chainEnvironmentFactsProfile } from "./profiles.js";
import { CHAIN_ENVIRONMENTS_FACTS_RECOMPUTE } from "./recompute.js";

const SOURCE = { agent: "did:key:zChainEnvironmentFactsConformance", name: "facts" };

const goldenJson = async (path: string): Promise<Record<string, unknown>> =>
  JSON.parse(
    await readFile(
      new URL(import.meta.resolve(`@jinn-network/chain-environment-record/fixtures/${path}`)),
      "utf8",
    ),
  ) as Record<string, unknown>;

async function verify(
  documentPath: string,
  facts: Record<string, unknown>,
): Promise<ItemOutcome> {
  const bytes = sealChainEnvironmentRecord(await goldenJson(documentPath));
  const digest = recordDigest(bytes);
  const entry: AnnouncementEntry = {
    protocol: RECORD_DISCOVERY_VERSION,
    source: SOURCE,
    sequence: GENESIS_SEQUENCE,
    previous: null,
    timestamp: "2026-07-31T12:00:00Z",
    announcements: [
      { announcementId: "ann-chain", action: "available", record: { kind: CHAIN_ENVIRONMENT_KIND, digest } },
    ],
  };
  const entryDigest = digestOf(entry);
  const kitPorts = makeInMemoryPorts({ entries: { [entryDigest]: entry } });

  const records: RecordFetcher = {
    async fetch(requested) {
      if (requested === digest) return bytes;
      throw new Error(`no record seeded for ${requested}`);
    },
  };

  const item: AnnouncedItem = {
    record: { kind: CHAIN_ENVIRONMENT_KIND, digest },
    facts,
    provenance: { source: SOURCE, entry: entryDigest, announcementId: "ann-chain" },
  };

  return verifyItem({
    item,
    profile: chainEnvironmentFactsProfile,
    decisionGrade: false,
    ports: {
      records,
      entries: kitPorts.entries,
      keys: kitPorts.keys,
      sigs: kitPorts.sigs,
      factsRecompute: CHAIN_ENVIRONMENTS_FACTS_RECOMPUTE,
      verifiedChain: async () => true,
    },
  });
}

async function truthfulCard(path: string): Promise<Record<string, unknown>> {
  const document = await goldenJson(path);
  const bytes = sealChainEnvironmentRecord(document);
  const runtime = document.runtime as { family: string; version: string; image: { manifestDigest: string } };
  const state = document.stateMaterialization as {
    closureClass: string;
    fidelityClass: string;
    stateArtifact?: { descriptor: { digest: { sha256: string } } };
  };
  const card: Record<string, unknown> = {
    chainEnvironmentRecordDigest: recordDigest(bytes),
    "runtime.family": runtime.family,
    "runtime.version": runtime.version,
    "runtime.image.manifestDigest": runtime.image.manifestDigest,
    "stateMaterialization.closureClass": state.closureClass,
    "stateMaterialization.fidelityClass": state.fidelityClass,
  };
  if (state.stateArtifact !== undefined) {
    card["stateMaterialization.stateArtifactDigest"] = prefixedDigest(state.stateArtifact.descriptor.digest.sha256);
  }
  return card;
}

describe("facts/chain-environments leaf conformance via verifyItem", () => {
  it("consistent: a truthful card matches the recomputed facts", async () => {
    expect(await verify("chain/closed-anchored-subset.json", await truthfulCard("chain/closed-anchored-subset.json")))
      .toEqual({ status: "verified", facts: "consistent" });
  });

  // The optional-field case. A failure here is a discovery-layer finding about optional facts,
  // not a licence to emit a placeholder digest.
  it("consistent: a record with no state artifact announces a card that omits the artifact fact", async () => {
    expect(await verify("chain/archive-dependent.json", await truthfulCard("chain/archive-dependent.json")))
      .toEqual({ status: "verified", facts: "consistent" });
  });

  it("inconsistent: a card overstating the closure class", async () => {
    const card = await truthfulCard("chain/archive-dependent.json");
    card["stateMaterialization.closureClass"] = "closed-state";
    expect(await verify("chain/archive-dependent.json", card))
      .toEqual({ status: "verified", facts: "inconsistent" });
  });

  it("inconsistent: a card overstating the fidelity class", async () => {
    const card = await truthfulCard("chain/closed-local.json");
    card["stateMaterialization.fidelityClass"] = "full-state";
    expect(await verify("chain/closed-local.json", card))
      .toEqual({ status: "verified", facts: "inconsistent" });
  });

  it("inconsistent: a card claiming a different runtime image", async () => {
    const card = await truthfulCard("chain/closed-anchored-subset.json");
    card["runtime.image.manifestDigest"] = `sha256:${"9".repeat(64)}`;
    expect(await verify("chain/closed-anchored-subset.json", card))
      .toEqual({ status: "verified", facts: "inconsistent" });
  });
});
