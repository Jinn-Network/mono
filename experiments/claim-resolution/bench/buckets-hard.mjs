/**
 * Hard stratum buckets.
 *
 * The main benchmark ceilinged: every condition resolved every dev claim
 * correctly, with zero solver disagreement, so it cannot distinguish one agent
 * from a network. That is a property of how it was assembled — claims were
 * admitted only when an unrestricted verifier could settle them confidently and
 * judged the criteria unambiguous, which selects for "one search away".
 *
 * This stratum targets the failure modes that actually make oracle resolution
 * hard, chosen a priori from the structure of the task and NOT by looking at
 * which claims the solvers got wrong:
 *
 *   contested   — reporting was contradictory, or an early report was later
 *                 corrected. A solver that stops at the first source is wrong.
 *   obscure     — the fact exists only in low-coverage sources: non-English
 *                 local media, official gazettes, regulatory dockets, small-cap
 *                 filings. Search returns little and most of it is irrelevant.
 *   threshold   — the outcome sits within a hair of the stated threshold, so
 *                 the answer turns on a precise figure rather than a gist.
 *   stage       — announcement vs agreement vs signature vs completion vs entry
 *                 into force, with the deadline falling between two stages.
 *   negative    — the claim asserts something did NOT happen, or happened zero
 *                 times, so it can only be settled by evidencing absence.
 *   multi-hop   — several independently-sourced facts must be assembled, and at
 *                 least one leg is itself obscure.
 */

const WINDOW = 'a resolution deadline between 2026-01-01 and 2026-08-15';

const COMMON = `
The point of this bucket is DIFFICULTY. A claim that a competent researcher
settles with one search is worthless here. Every candidate must be one you
yourself had to work for: several searches, a source that was hard to find, or a
judgement about which of two conflicting reports was right.

Still mandatory: already definitively resolved; resolvable from public web
evidence; clear enough that the answer is safely ground truth; self-contained
claim and criteria; never name a prediction market, oracle or arbitration venue;
never let the wording hint at the answer. No sports results.`;

export const BUCKETS = [
  { id: 'hard-contested', n: 12, window: WINDOW, brief: `Events where the public record was contradictory or self-correcting: an initial report that major outlets later retracted or corrected, two credible outlets reporting incompatible facts, an official denial of a widely-reported claim, a figure revised after first publication. The claim should be settled by the corrected/final record, so that a solver anchoring on the first wave of reporting gets it wrong.${COMMON}` },
  { id: 'hard-obscure', n: 12, window: WINDOW, brief: `Events documented mainly in low-coverage sources: non-English local and national media, official gazettes and government bulletins, regulatory dockets and court filings, small-cap company disclosures, municipal and provincial decisions, industry trade press. Deliberately avoid anything that got wide English-language coverage.${COMMON}` },
  { id: 'hard-threshold', n: 10, window: WINDOW, brief: `Outcomes that landed within a hair of the stated threshold — a vote margin, a percentage, a count, a monetary figure, a date. Set the threshold so the true answer depends on the precise value and not on the general impression. Roughly half should fall just on the YES side and half just on the NO side.${COMMON}` },
  { id: 'hard-stage', n: 10, window: WINDOW, brief: `Claims that turn on which stage of a multi-stage process had been reached by the deadline: announced vs agreed vs initialed vs signed vs ratified vs in force; indicted vs convicted vs sentenced; approved vs launched vs delivered; ordered vs implemented vs enjoined. The deadline must fall between two stages so that a solver reading the headline reaches the wrong stage.${COMMON}` },
  { id: 'hard-negative', n: 10, window: WINDOW, brief: `Claims asserting a non-event: that something did not happen, was never done, happened zero times, or that no such body ever issued a given decision, within a defined window. These can only be settled by evidencing absence, which is the hardest thing to research.${COMMON}` },
  { id: 'hard-multihop', n: 12, window: WINDOW, brief: `Claims requiring several independently-sourced facts to be assembled, where at least one leg is obscure: "A happened before B", "X exceeded T on at least N occasions", "the same person held both roles", "of the countries that did A, at least K also did B". Each leg must be individually verifiable but no single source should carry the whole claim.${COMMON}` },
];
