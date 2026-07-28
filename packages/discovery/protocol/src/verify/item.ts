import { recordDigest } from "../hashing.js";
import type { FactsProfileDocument } from "../facts-profile.js";
import type { AnnouncedItem, SourceCursor } from "../item.js";
import { factsConsistency } from "./facts-consistency.js";
import type {
  EntryFetcher,
  FactsRecompute,
  KeyResolver,
  RecordFetcher,
  SignatureVerifier,
  SubstrateChecker,
} from "./ports.js";
import type { ItemOutcome } from "./outcomes.js";

// Named verification: item verification (design §10.4). Five ordered steps:
//   1. `fetch` record bytes, re-hash (content-corruption on mismatch);
//   2. facts-consistency (§10.4 step 2 / §5.4);
//   3. verify cited provenance -- REQUIRED before decision-grade/attribution
//      use (§10.4 step 3);
//   4. for projected items, derivation-consistency (§6.2), REQUIRED for
//      decision-grade use, optional spot-check otherwise;
//   5. hand off to the record's own protocol for content verification --
//      out of discovery's scope; return `verified`.
//
// `decisionGrade` does not change the shape of what `verifyItem` reports --
// it is the CALLER's fail-closed policy (§5.4/§6.2: decision-grade use must
// fail closed on anything but `consistent` facts / a required derivation
// check). `verifyItem` always reports the true computed outcome; the caller
// decides what to do with a non-`consistent`/non-`present` result.

// §10.4 step 3 requires confirming the cited entry lies on the source's
// verified chain via the injected `verifiedChain(cursor)` port, which takes
// a full `SourceCursor` (§5.3 rule 4: `{sequence, entry digest}`).
// `AnnouncedItem.provenance` (frozen §8/§16.9 shape) carries the entry's
// digest but not its sequence, so this reference implementation cannot
// construct a fully-populated cursor at this call site. It passes a
// placeholder sequence -- `verifiedChain` implementations key on the entry
// digest, which uniquely identifies a position in an append-only chain.
// Recorded as a finding for whoever revisits `AnnouncedItem`'s shape or the
// `verifiedChain` port signature: carrying the entry's sequence on
// `provenance` (or accepting a bare digest here) would close this gap.
const UNKNOWN_SEQUENCE_PLACEHOLDER = "0000000000000000";

export async function verifyItem(opts: {
  item: AnnouncedItem;
  profile?: FactsProfileDocument;
  decisionGrade: boolean;
  ports: {
    records: RecordFetcher;
    entries: EntryFetcher;
    keys: KeyResolver;
    sigs: SignatureVerifier;
    factsRecompute: FactsRecompute;
    substrate?: SubstrateChecker;
    verifiedChain: (c: SourceCursor) => Promise<boolean>;
  };
}): Promise<ItemOutcome> {
  const { item, profile, ports } = opts;

  // Step 1: `fetch` record bytes by digest, re-hash.
  const fetchedBytes = await ports.records.fetch(item.record.digest);
  if (recordDigest(fetchedBytes) !== item.record.digest) {
    return { status: "content-corruption" };
  }

  // Step 2: facts-consistency.
  const facts = await factsConsistency({
    item,
    profile,
    recordBytes: fetchedBytes,
    factsRecompute: ports.factsRecompute,
    records: ports.records,
  });

  // Step 3: cited provenance.
  const cursor: SourceCursor = { sequence: UNKNOWN_SEQUENCE_PLACEHOLDER, entry: item.provenance.entry };
  if (!(await ports.verifiedChain(cursor))) {
    return { status: "unauthorized-provenance" };
  }

  // Step 4: derivation-consistency, projected items only (an author-source
  // item carries no derivation annotation, §6.2).
  if (item.provenance.derivation !== undefined && ports.substrate !== undefined) {
    const derivation = await ports.substrate.check(item.provenance.derivation, item);
    return { status: "verified", facts, derivation };
  }

  // Step 5: hand off to the record's own protocol for content verification
  // -- out of discovery's scope.
  return { status: "verified", facts };
}
