import type { DsseEnvelope } from "@jinn-network/trust-core";
import {
  sealJson,
  verifyItem,
  verifySourceChain,
} from "@jinn-network/record-discovery-protocol";
import type {
  AnnouncedItem,
  AnnouncementEntry,
  EntryFetcher,
  FactsRecompute,
  HighWaterMarkStore,
  ItemOutcome,
  RecordFetcher,
  SourceChainOutcome,
  SourceHead,
  SourceIdentity,
  SubstrateChecker,
} from "@jinn-network/record-discovery-protocol";

import type { FactsProfileRegistry } from "./ports.js";
import type { TrustAdapter } from "./trust-adapter.js";

// The verification driver (design §10.1/§10.3/§10.4, plan Task 20):
// composes `verifySourceChain` and `verifyItem` (protocol's reference
// procedures) with the trust adapter, the high-water-mark store, and the
// host-injected facts ports, and tracks which entries have been verified
// onto a source's accepted chain -- the state `verifyItem`'s §10.4 step 3
// (`verifiedChain`) needs, which `verifySourceChain` on its own has no way
// to persist for a later, separate `verifyItem` call to consult.

function entrySourceKey(source: SourceIdentity): string {
  return `${source.agent}/${source.name}`;
}

export interface VerifyDriverDeps {
  trust: TrustAdapter;
  hwm: HighWaterMarkStore;
  factsProfiles: FactsProfileRegistry;
  factsRecompute: FactsRecompute;
  records: RecordFetcher;
  entries: EntryFetcher;
  /** Present for decision-grade derivation-consistency (§6.2); a filter-only driver may omit it. */
  substrate?: SubstrateChecker;
  now(): Date;
}

export interface VerifySourceOptions {
  source: SourceIdentity;
  head: SourceHead;
  headSignature: DsseEnvelope;
  entries: AsyncIterable<{ entry: AnnouncementEntry; signature: DsseEnvelope }>;
  firstAdoption: boolean;
}

export interface VerifyDriver {
  /** Runs `source-chain-verification` (§10.3) and, on `ok`, records every walked entry as verified-onto-chain for later `verifyItem` provenance checks (§10.4 step 3). */
  verifySource(opts: VerifySourceOptions): Promise<SourceChainOutcome>;
  /** Decision-grade item verification (§10.4): chain-verified provenance required, derivation-consistency mandatory for projected items (§6.2). */
  verifyForDecision(item: AnnouncedItem): Promise<ItemOutcome>;
  /** Shallow, filter-only item verification (§13.1): derivation-consistency is an optional spot-check, not required. */
  verifyForFilter(item: AnnouncedItem): Promise<ItemOutcome>;
}

export function createVerifyDriver(deps: VerifyDriverDeps): VerifyDriver {
  // Verified entry digests, per source -- populated by verifySource, read
  // by the verifiedChain port verifyItem's §10.4 step 3 consults.
  const verifiedEntryDigests = new Map<string, Set<string>>();

  function markVerified(source: SourceIdentity, digest: string): void {
    const key = entrySourceKey(source);
    let set = verifiedEntryDigests.get(key);
    if (set === undefined) {
      set = new Set();
      verifiedEntryDigests.set(key, set);
    }
    set.add(digest);
  }

  function isVerified(digest: string): boolean {
    for (const set of verifiedEntryDigests.values()) {
      if (set.has(digest)) return true;
    }
    return false;
  }

  async function verifySource(opts: VerifySourceOptions): Promise<SourceChainOutcome> {
    const walked: AnnouncementEntry[] = [];
    async function* tee(): AsyncGenerator<{ entry: AnnouncementEntry; signature: DsseEnvelope }> {
      for await (const item of opts.entries) {
        walked.push(item.entry);
        yield item;
      }
    }

    const outcome = await verifySourceChain({
      head: opts.head,
      headSignature: opts.headSignature,
      entries: tee(),
      ports: {
        keys: deps.trust.keys,
        sigs: deps.trust.sigs,
        fresh: deps.trust.fresh,
        hwm: deps.hwm,
        now: deps.now(),
        firstAdoption: opts.firstAdoption,
      },
    });

    if (outcome.status === "ok") {
      for (const entry of walked) markVerified(opts.source, sealJson(entry).digest);
    }
    return outcome;
  }

  async function verifiedChain(cursor: { entry: string }): Promise<boolean> {
    return isVerified(cursor.entry);
  }

  async function verifyForDecision(item: AnnouncedItem): Promise<ItemOutcome> {
    return verifyItem({
      item,
      profile: deps.factsProfiles.get(item.record.kind),
      decisionGrade: true,
      ports: {
        records: deps.records,
        entries: deps.entries,
        keys: deps.trust.keys,
        sigs: deps.trust.sigs,
        factsRecompute: deps.factsRecompute,
        substrate: deps.substrate,
        verifiedChain,
      },
    });
  }

  async function verifyForFilter(item: AnnouncedItem): Promise<ItemOutcome> {
    return verifyItem({
      item,
      profile: deps.factsProfiles.get(item.record.kind),
      decisionGrade: false,
      ports: {
        records: deps.records,
        entries: deps.entries,
        keys: deps.trust.keys,
        sigs: deps.trust.sigs,
        factsRecompute: deps.factsRecompute,
        // No substrate port: derivation-consistency is an optional spot-
        // check under shallow/filter use (§6.2), never mandatory.
        verifiedChain,
      },
    });
  }

  return { verifySource, verifyForDecision, verifyForFilter };
}
