import { recordDigest } from "../hashing.js";
import type { FactsProfileDocument } from "../facts-profile.js";
import { parseAnnouncementEntry } from "../entry.js";
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

  // Step 3: verify the cited provenance (§10.4 step 3, decision-grade
  // MUST). "Provenance" claimed by a query/subscribe service is only that
  // service's word until this step corroborates it against the cited
  // entry's OWN content and the source's verified chain -- a malicious
  // service citing a trusted source it never synced, or lying about which
  // entry announced this item, is caught here and nowhere else.
  let citedEntryBytes: Uint8Array;
  try {
    citedEntryBytes = await ports.entries.fetch(item.provenance.entry);
  } catch {
    return { status: "unauthorized-provenance" };
  }
  if (recordDigest(citedEntryBytes) !== item.provenance.entry) {
    return { status: "unauthorized-provenance" };
  }
  let citedEntry;
  try {
    citedEntry = parseAnnouncementEntry(
      JSON.parse(new TextDecoder().decode(citedEntryBytes)),
    );
  } catch {
    return { status: "unauthorized-provenance" };
  }
  const announces = citedEntry.announcements.some(
    (announcement) =>
      announcement.action === "available" &&
      announcement.announcementId === item.provenance.announcementId &&
      announcement.record.kind === item.record.kind &&
      announcement.record.digest === item.record.digest,
  );
  if (!announces) {
    return { status: "unauthorized-provenance" };
  }
  const cursor: SourceCursor = { sequence: citedEntry.sequence, entry: item.provenance.entry };
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
