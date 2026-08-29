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
 * A third rule is this module's own, and is the whole point of the issue: **the census sentence
 * says it is the weaker binding.** Ordering-only binding shows the run's order was fixed by
 * randomness that postdates the seal; it does not show the population was, because with a census
 * there was no population choice to make. Letting the two modes share one confident sentence would
 * be the failure this feature exists to prevent.
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

/** `<source display name> round <n>`, the one rendering every sentence below uses. */
function beaconName(binding: VerifiedRunBinding): string {
  return `${BEACON_SOURCES[binding.beacon.source].displayName} round ${binding.beacon.round}`;
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
    return `This run's slate was drawn, not chosen: its ${binding.sample.length} items were derived from a `
      + `declared pool of ${binding.poolSize} by procedure ${BEACON_BINDING_PROCEDURE}, keyed on this run's sealed `
      + `digest together with ${beaconName(binding)} — ${postSealClause(binding)}. Selecting the slate after the `
      + `fact would have required predicting that value. ${RECOMPUTE_CLAUSE}`;
  }
  return `This run evaluated its whole declared population of ${binding.poolSize} items, so no slate was selected `
    + `and none could be selected after the fact. The beacon binds execution ORDER only: the order was derived by `
    + `procedure ${BEACON_BINDING_PROCEDURE} from this run's sealed digest together with ${beaconName(binding)} — `
    + `${postSealClause(binding)}. This is a weaker binding than a beacon-drawn slate. It shows the run's order was `
    + `fixed by randomness postdating the seal; it does not show the population was, because a census makes no `
    + `population choice. ${RECOMPUTE_CLAUSE}`;
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
