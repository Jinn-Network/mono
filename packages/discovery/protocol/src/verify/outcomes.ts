import type { AnnouncementEntry } from "../entry.js";
import type { SourceHead } from "../head.js";
import type { HighWaterMark } from "./ports.js";

// Typed outcomes for the two named verification procedures (design §16
// item 11): failures are typed, not boolean.

export type SourceChainOutcome =
  | { status: "ok"; head: SourceHead; advanced: HighWaterMark }
  | { status: "stale" } // refreshBy expired
  | { status: "forked"; evidence: { a: SourceHead | AnnouncementEntry; b: SourceHead | AnnouncementEntry } } // equivocation -- evidence-bearing
  | { status: "broken-chain"; at: string } // linkage, contiguity, ceiling, or duplicate-announcementId failure -- sequence or entry digest
  | { status: "unauthorized-signer" }; // including the old-key head case

/**
 * `source-head-revalidation`'s typed outcome: the same fail-closed vocabulary
 * as the chain procedure's steps 1-3, plus the two envelope-shaped refusals
 * that procedure folds into `unauthorized-signer` and this one keeps separate
 * so a caller can tell a malformed envelope from a wrong signer.
 */
export type SourceHeadOutcome =
  | { status: "ok" }
  | { status: "stale" } // refreshBy expired
  // The §5.2 freshness-window refusals, slugs shared with the chain procedure,
  // which reports the SAME defects as `broken-chain` with `at` set to the same
  // string (alongside the entry ceilings its linkage walk enforces). This
  // procedure has no chain to fold them into, so they surface at the top
  // level; a caller correlating the two reads one vocabulary either way.
  | { status: "refresh-by-ceiling" } // empty/inverted window, or refreshBy further ahead of issuedAt than the profile allows
  | { status: "head-issued-ahead" } // issuedAt further ahead of `now` than one freshness window
  | { status: "unauthorized-signer" } // no signature by a key valid at `now`
  | { status: "head-origin-mismatch" } // head names a source other than the one followed
  | { status: "head-payload-mismatch" } // envelope does not carry these head bytes
  | { status: "invalid-head-envelope" }; // not a parseable wire DSSE envelope

export type FactsConsistency = "consistent" | "inconsistent" | "indeterminate";

export type ItemOutcome =
  | { status: "content-corruption" }
  | { status: "verified"; facts: FactsConsistency; derivation?: "present" | "fabricated" | "reorged-away" }
  | { status: "unauthorized-provenance" }; // §10.4 step 3 failure
