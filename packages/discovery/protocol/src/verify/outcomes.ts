import type { AnnouncementEntry } from "../entry.js";
import type { SourceHead } from "../head.js";
import type { SourceCursor } from "../item.js";

// Typed outcomes for the two named verification procedures (design §16
// item 11): failures are typed, not boolean.

export type SourceChainOutcome =
  | { status: "ok"; head: SourceHead; advanced: SourceCursor }
  | { status: "stale" } // refreshBy expired
  | { status: "forked"; evidence: { a: SourceHead | AnnouncementEntry; b: SourceHead | AnnouncementEntry } } // equivocation -- evidence-bearing
  | { status: "broken-chain"; at: string } // linkage, contiguity, ceiling, or duplicate-announcementId failure -- sequence or entry digest
  | { status: "unauthorized-signer" }; // including the old-key head case

export type FactsConsistency = "consistent" | "inconsistent" | "indeterminate";

export type ItemOutcome =
  | { status: "content-corruption" }
  | { status: "verified"; facts: FactsConsistency; derivation?: "present" | "fabricated" | "reorged-away" }
  | { status: "unauthorized-provenance" }; // §10.4 step 3 failure
