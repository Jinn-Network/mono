// SPDX-License-Identifier: Apache-2.0

/**
 * The report face for `beacon-binding/1` (issue #2976, acceptance criteria 3 and 4): which binding
 * applied, in plain words, and what it does and does not establish.
 *
 * Two rules carried over from `../profile/anchor-claims.ts`, whose conditional honesty copy this
 * mirrors:
 *
 * - **Single-sourced, never mirrored.** `@colophon-claims/core` already depends on this package, so
 *   producer and reader render the same function rather than two copies that can drift.
 * - **The words key on facts, not on configuration.** Every value in a sentence below comes from
 *   the verified binding itself, so the text is identical for every reader.
 *
 * A third rule follows from issues #3322 and #3426: **a sentence claims unchosen-ness only where
 * the seal established it**, separately for the round and for the source. A beacon that merely
 * postdates the seal makes the value unpredictable and leaves the operator choosing among the
 * values that postdate it. So both sentences carry `roundChoiceClause`, which asserts the second
 * property under `seal-derived` and retracts it under `operator-chosen` rather than letting either
 * branch imply it.
 *
 * A fourth rule is this module's own, and is the whole point of the originating issue: **the census
 * sentence says it is the weaker binding.** Ordering-only binding shows the run's order was fixed by
 * randomness that postdates the seal; it does not show the population was, because with a census
 * there was no population choice to make. Letting the two modes share one confident sentence would
 * be the failure this feature exists to prevent. Issue #3425 subjects that sentence to the third
 * rule as well: `censusOrderClause` asserts the postdating only under `proven-offline`, and concedes
 * it under `attributive` in the register the sampled opening already uses, because the clauses on
 * either side of it concede exactly that.
 */

import {
  BEACON_BINDING_PROCEDURE,
  BEACON_SOURCES,
  type VerifiedRunBinding,
} from "./beacon-binding.js";

/**
 * Which binding a run carries. `none` is the historical state every unbound run keeps -- the
 * absence of a binding is a fact about the run, and is reported as one.
 */
export type RunBindingClass = "none" | "beacon-drawn-slate" | "beacon-ordering-only";

export function runBindingClass(binding: VerifiedRunBinding | undefined): RunBindingClass {
  if (binding === undefined) return "none";
  return binding.mode === "sampled" ? "beacon-drawn-slate" : "beacon-ordering-only";
}

/**
 * `<source display name> <round|height> <n>`, the one rendering every sentence below uses. The
 * index word keys on the source's own time basis (issue #3429): `attributive-height` sources index
 * by block height, and the clauses that follow this name turn on exactly that distinction --
 * "No round follows from a seal on a height-indexed source" reads as a contradiction of a beacon
 * the same sentence has just called a round.
 */
function beaconName(binding: VerifiedRunBinding): string {
  const source = BEACON_SOURCES[binding.beacon.source];
  const index = source.timeBasis === "attributive-height" ? "height" : "round";
  return `${source.displayName} ${index} ${binding.beacon.round}`;
}

/**
 * How the sentence may talk about the beacon postdating the seal. `proven-offline` asserts,
 * because the source's own published schedule turns the round number into a time by arithmetic.
 * `attributive` reports what the chain asserts and names what checking it takes -- the same
 * assertive/attributive split `anchoredPreRegistrationSentence` draws between a timestamp token
 * and an OpenTimestamps commitment.
 */
function postSealClause(binding: VerifiedRunBinding): string {
  return binding.postSeal === "proven-offline"
    ? `a value that did not exist until ${binding.beaconInstant}, after this run was sealed at ${binding.sealedAt}`
    : `a value the chain places after this run's seal at ${binding.sealedAt} — establishing that ordering `
      + "requires block headers on the reader's side, so it is what the chain asserts rather than something "
      + "this bundle proves";
}

/**
 * What the run's choice of ROUND and of SOURCE does or does not add (issues #3322, #3426). A beacon
 * that merely postdates the seal leaves the operator picking among realized values, and a sentence
 * that names only the value's unpredictability reads as though it had ruled that out. So the clause
 * is not decoration: it states each property the seal established and retracts each one it did not,
 * in the same plain register the census branch uses about its own weaker binding.
 *
 * The source half is load-bearing rather than tidy. Under `operator-chosen` the round rule is one
 * source selection away from having no effect at all: `bitcoin/mainnet` is height-indexed, so no
 * round follows from a seal for it and nothing in the bundle places its value after the seal, which
 * means an operator who disliked the round the seal named could bind that source at any height the
 * chain carries instead. Only a sealed declaration removes that, so only `seal-declared` may say it
 * is removed.
 */
function roundChoiceClause(binding: VerifiedRunBinding): string {
  // Name the thing a chosen round would actually have moved. Saying "the result" for both modes
  // made the census clause read as a retraction of a population claim a census never makes: with a
  // census the population is the whole declared one whatever round applies, and only the ORDER
  // moves.
  const derived = binding.mode === "sampled" ? "slate" : "order";
  // "possibly different", never "different" (issue #3429). The alternatives clause sizes a
  // residue, and a bare universal overstates it: a one-item census derives the same order from
  // every beacon value, and a two-item one from roughly half of all rounds. What the procedure
  // supports is that another round MIGHT have derived another result, which is the whole of the
  // residue and is what the clause claims.

  // What a declared source does and does not settle, stated once and appended to whichever round
  // clause applies. Under `seal-declared` the beacon is fixed outright on a scheduled source; on a
  // height-indexed one it fixes only WHICH CHAIN, and the round clause below still concedes the
  // height. Under `operator-chosen` this is the residue PR #3375 could only report.
  //
  // The declared branch takes its connective from the caller (#3525) because the two round clauses
  // that append this say opposite things before it: "Nor" continues the seal-derived branch's
  // denial, and would read as a contradiction after the chosen-round branch's concession that the
  // round WAS the operator's. The property after the colon is one string on both branches -- only
  // the word joining it to the sentence before moves. The residue opens on its own subject and
  // follows either clause, so it needs no such split.
  const sourceClause = (connective: string): string =>
    binding.sourceBasis === "seal-declared"
      ? `${connective}: the sealed record names the beacon this run binds to, so a binding naming `
        + "any other source is refused."
      : "What choosing remains is the source — the seal names no beacon, so an operator could have "
        + "bound a different one, and this procedure admits a beacon indexed by block height where "
        + "no round follows from a seal at all.";
  if (binding.roundBasis === "seal-derived") {
    // Only a scheduled source reaches here: `requiredBeaconRound` derives nothing for a height, so
    // an `attributive` binding is `operator-chosen` by construction.
    return "The round was not the operator's to pick either: it is the first round this source publishes after "
      + `the seal, so the seal instant alone fixes it. ${sourceClause("Nor was the source")}`;
  }
  if (binding.postSeal === "attributive") {
    // Say no more here than the postdating clause two sentences earlier already conceded. Claiming
    // the value was unpredictable would assert exactly what this branch cannot check: nothing in
    // the bundle places this height after the seal, so nothing rules out a height that predates it.
    // A declared source does not change that, and the sentence order says so: the beacon is fixed,
    // the height within it is not.
    const declared = binding.sourceBasis === "seal-declared"
      ? "The sealed record names this source, so the beacon itself was not the operator's to pick. But no "
        + "round follows from a seal on a height-indexed source, so this height was still the operator's "
        + "choice"
      : "No round follows from a seal on a height-indexed source, so this height was the operator's choice";
    return `${declared} — and on the reader's side it is the chain, not this bundle, that places it after the `
      + `seal at all. Any other height would have derived a possibly different ${derived} from the same inputs.`;
  }
  // A chosen round on a scheduled source. The source clause still applies here -- a declared source
  // narrows what could have been chosen even when the round was -- and omitting it would leave this
  // one branch of the three saying nothing about the source at all.
  return `Which post-seal value applied was still the operator's choice: this binding names a round selected after `
    + `the seal, and every round the source published in between was an available alternative deriving a `
    + `possibly different ${derived} from the same inputs. The value could not have been predicted; this ${derived} is `
    + `nonetheless one of several the operator could have realized by waiting. ${sourceClause("The source was not")}`;
}

/**
 * What the census binding shows about the ORDER (issue #3425). The postdating half keys on
 * `postSeal` for the same reason the sampled opening does: on a height-indexed source nothing in
 * the bundle places the value after the seal, so asserting that the order was fixed by randomness
 * postdating it would be conceded by `postSealClause` two clauses earlier and again by
 * `roundChoiceClause` two clauses later. The population half is unconditional -- a census makes no
 * population choice on any basis.
 */
function censusOrderClause(binding: VerifiedRunBinding): string {
  const order = binding.postSeal === "proven-offline"
    ? "It shows the run's order was fixed by randomness postdating the seal"
    : "It shows the run's order was tied to a value this bundle cannot place after the seal";
  return `${order}; it does not show the population was, because a census makes no population choice.`;
}

const RECOMPUTE_CLAUSE =
  `Any reader recomputes the derivation offline from the sealed digest, the published beacon value and the `
  + `item identities alone, by procedure ${BEACON_BINDING_PROCEDURE}; the verifier fails the run when its `
  + "recomputation disagrees.";

/**
 * The one sentence that states which binding applied. `undefined` yields the unbound statement,
 * which is a claim about the run too: nothing about it was drawn from post-seal randomness.
 */
export function runBindingSentence(binding: VerifiedRunBinding | undefined): string {
  if (binding === undefined) {
    return "This run is bound to no public randomness: its seal shows the design existed by a given time, and "
      + "nothing establishes that execution followed the seal rather than preceding it.";
  }
  if (binding.mode === "sampled") {
    // The "could not have been selected after the fact" claim is the one issue #3322 exists to
    // stop overstating, so it appears ONLY on the branch where the seal named the round. Under
    // `operator-chosen` it is not merely unproven, it is false -- selecting the slate after the
    // fact needed no prediction at all, only waiting for a round whose derivation the operator
    // liked -- so it is dropped rather than hedged.
    //
    // The opening keys on `postSeal` as well, for the same reason `roundChoiceClause` does: under
    // `attributive` nothing in the bundle places the height after the seal, so an opening that
    // called the value unpredictable would assert what the branch cannot check -- and would be
    // retracted two clauses later by the very postdating clause it introduces.
    const opening = binding.roundBasis === "seal-derived"
      ? "This run's slate was drawn, not chosen"
      : binding.postSeal === "attributive"
        ? "This run's slate was drawn from a value this bundle cannot place after the seal"
        : "This run's slate was drawn from a value it could not have predicted";
    const unpredictabilityClause = binding.roundBasis === "seal-derived"
      ? "Selecting the slate after the fact would have required predicting that value. "
      : "";
    return `${opening}: its ${binding.sample.length} items were derived from a `
      + `declared pool of ${binding.poolSize} by procedure ${BEACON_BINDING_PROCEDURE}, keyed on this run's sealed `
      + `digest together with ${beaconName(binding)} — ${postSealClause(binding)}. `
      + `${unpredictabilityClause}${roundChoiceClause(binding)} ${RECOMPUTE_CLAUSE}`;
  }
  return `This run evaluated its whole declared population of ${binding.poolSize} items, so no slate was selected `
    + `and none could be selected after the fact. The beacon binds execution ORDER only: the order was derived by `
    + `procedure ${BEACON_BINDING_PROCEDURE} from this run's sealed digest together with ${beaconName(binding)} — `
    + `${postSealClause(binding)}. This is a weaker binding than a beacon-drawn slate. `
    + `${censusOrderClause(binding)} ${roundChoiceClause(binding)} ${RECOMPUTE_CLAUSE}`;
}

/**
 * The venue-limits list with the binding statement appended. Returns the list unchanged when the
 * run carries no binding, so every run that predates this feature keeps its exact limits bytes --
 * the same additive posture `anchoredVenueLimits` takes for an unanchored run.
 */
export function runBoundVenueLimits(
  limits: readonly string[],
  binding: VerifiedRunBinding | undefined,
): readonly string[] {
  return binding === undefined ? limits : [...limits, runBindingSentence(binding)];
}
