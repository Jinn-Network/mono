import type { DsseEnvelope } from "@jinn-network/trust-core";
import {
  sealJson,
  verifyItem,
  verifySourceChain,
  verifySourceHead,
  verifyAnchoredEntryHold,
  formatOrigin,
} from "@jinn-network/record-discovery-protocol";
import type {
  AnnouncedItem,
  AnnouncementEntry,
  AnchoredEntryHold,
  AnchoredEntryHoldStore,
  EntryFetcher,
  FactsRecompute,
  HighWaterMark,
  HighWaterMarkStore,
  ItemOutcome,
  RecordFetcher,
  SourceChainOutcome,
  SourceHead,
  SourceHeadOutcome,
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
  /**
   * Consumer refusal for a previously recorded anchored entry (publication-head
   * anchoring §5.4 step 5). Absent: the chain procedure runs unchanged.
   */
  holds?: AnchoredEntryHoldStore;
  now(): Date;
}

export interface VerifySourceOptions {
  source: SourceIdentity;
  head: SourceHead;
  headSignature: DsseEnvelope;
  entries: AsyncIterable<{ entry: AnnouncementEntry; signature: DsseEnvelope }>;
  firstAdoption: boolean;
  /** First-visit tuple after the caller verified an entry-anchor proof. */
  observedAnchoredEntry?: Omit<AnchoredEntryHold, "origin">;
}

export type VerifySourceResult =
  | SourceChainOutcome
  | { status: "missing-held-entry"; hold: AnchoredEntryHold };

export interface VerifyHeadOptions {
  source: SourceIdentity;
  head: SourceHead;
  headSignature: DsseEnvelope;
}

export interface VerifyDriver {
  /** Runs `source-chain-verification` (§10.3) and, on `ok`, records every walked entry as verified-onto-chain for later `verifyItem` provenance checks (§10.4 step 3). When a hold store is injected, also applies `anchored-entry-hold`. */
  verifySource(opts: VerifySourceOptions): Promise<VerifySourceResult>;
  /**
   * Runs `source-head-revalidation` on a head that names the chain position
   * this consumer already holds. Adopts nothing and advances no mark; the
   * caller must have established the same-position precondition first.
   */
  verifyHead(opts: VerifyHeadOptions): Promise<SourceHeadOutcome>;
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

  async function verifySource(opts: VerifySourceOptions): Promise<VerifySourceResult> {
    const walked: AnnouncementEntry[] = [];
    async function* tee(): AsyncGenerator<{ entry: AnnouncementEntry; signature: DsseEnvelope }> {
      for await (const item of opts.entries) {
        walked.push(item.entry);
        yield item;
      }
    }

    // When a hold store is injected, intercept step 7's `hwm.put` so a
    // refused hold never persists the new high-water mark. `get` still
    // reads the prior mark (the HWM-covered prefix for the hold check).
    let deferredMark: HighWaterMark | undefined;
    const hwm: HighWaterMarkStore =
      deps.holds === undefined
        ? deps.hwm
        : {
            get: (source) => deps.hwm.get(source),
            put: async (_source, mark) => {
              deferredMark = mark;
            },
          };

    const outcome = await verifySourceChain({
      head: opts.head,
      headSignature: opts.headSignature,
      entries: tee(),
      ports: {
        keys: deps.trust.keys,
        sigs: deps.trust.sigs,
        fresh: deps.trust.fresh,
        hwm,
        now: deps.now(),
        firstAdoption: opts.firstAdoption,
      },
    });

    if (outcome.status === "ok" && deps.holds !== undefined) {
      const priorHwm = await deps.hwm.get(opts.source);
      const hold = await verifyAnchoredEntryHold({
        origin: formatOrigin(opts.source.agent, opts.source.name),
        entries: walked.map((entry) => ({
          sequence: entry.sequence,
          digest: sealJson(entry).digest as `sha256:${string}`,
        })),
        ports: { holds: deps.holds },
        coveredThrough:
          opts.firstAdoption || priorHwm === undefined ? undefined : { sequence: priorHwm.sequence },
        observed: opts.observedAnchoredEntry,
      });
      if (hold.status === "missing-held-entry") return hold;
    }

    if (deferredMark !== undefined) await deps.hwm.put(opts.source, deferredMark);

    if (outcome.status === "ok") {
      for (const entry of walked) markVerified(opts.source, sealJson(entry).digest);
    }
    return outcome;
  }

  async function verifyHead(opts: VerifyHeadOptions): Promise<SourceHeadOutcome> {
    return verifySourceHead({
      source: opts.source,
      head: opts.head,
      headSignature: opts.headSignature,
      ports: { keys: deps.trust.keys, sigs: deps.trust.sigs, fresh: deps.trust.fresh, now: deps.now() },
    });
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

  return { verifySource, verifyHead, verifyForDecision, verifyForFilter };
}
