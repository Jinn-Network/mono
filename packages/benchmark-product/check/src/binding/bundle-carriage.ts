// SPDX-License-Identifier: Apache-2.0

/**
 * Bundle carriage for `beacon-binding/1` (issue #3370): the member the `beacon-binding` capability
 * makes mandatory, the claim section projected from it, and the one linkage rule both the workspace
 * producer and a standalone reader apply.
 *
 * `verifyRunBinding` proves a record is internally consistent -- that its declared order derives
 * from the `sealDigest` it itself carries, and that its beacon postdates the `sealedAt` it itself
 * carries. It cannot know WHICH RUN the record was written for: a foreign record filed under its own
 * true digest passes every one of those checks. So whoever holds the sealed Run must compare the
 * three fields the record restates from it against the Run itself, and until this module existed
 * that comparison was written once, workspace-side, in `core/src/binding/carriage.ts`. Carrying the
 * record in a published bundle needed the same comparison on the reader's side, and the module that
 * argued for `verifyRunBinding` being shared argues for this too: a second local implementation
 * would turn "the verifier recomputes and fails on mismatch" into a comparison of two guesses.
 *
 * So the rule lives here, once, and both sides reduce to the same four inputs. What differs is only
 * where each side reads them: the workspace reads its own `RunState`, a reader reads the
 * authenticated `run.json` member the bundle carries.
 */

import { RunBindingError, type VerifiedRunBinding } from "./beacon-binding.js";

/**
 * The bundle member carrying the sealed `beacon-binding/1` record, verbatim.
 *
 * A fixed path rather than a `records/<sha256>.bin` pattern, for two reasons. The `records/` tree is
 * allowlisted only because the evidence catalog enumerates it, so a record there needs an evidence
 * role and an edge naming it -- and the only edge available would be a new Report extension, which
 * would force `beacon-binding` into the `/2` catalog vocabulary that
 * `profile/disclosure.test.ts`'s `PRE_APPEND_V2_ROLES_SHA256` freezes. And cardinality is
 * structural: a run binds to one beacon or to none, so a fixed path states the cardinality that
 * `assertMemberClosure` has no knob for. `anchoring` is the precedent -- a carried record with its
 * own member shape, no evidence role, no Report extension -- not `disclosure-specification`.
 */
export const BEACON_BINDING_BUNDLE_MEMBER = "beacon-binding.json" as const;

/**
 * Compares the three fields a binding restates from its sealed Run against that Run.
 *
 * Throws `RunBindingError`, which every caller translates into its own typed refusal — the same
 * shape `verifyRunBinding` already raises, so a caller handles one error class rather than two.
 *
 * `sealedAt` is compared only when the Run declares one. Absence is the pre-existing, legal state:
 * `beacon-source/v1` gained the field in this change, so every Run sealed before it declares none,
 * and treating absence as a mismatch would refuse every already-published run rather than catch a
 * forgery. The gap that leaves is named to the reader by step 2d of `EXTERNAL-VERIFICATION.md`
 * instead of being papered over here — when the Run declares no instant, the seal time is the
 * publisher's own assertion and step 2 against the beacon is the independent check that remains.
 */
export function assertRunBindingLinkage(input: {
  readonly binding: VerifiedRunBinding;
  readonly runSha256: string;
  readonly sealedAt: string | undefined;
  readonly declaredSource: string | undefined;
}): void {
  const sealDigest = `sha256:${input.runSha256}`;
  if (input.binding.sealDigest !== sealDigest) {
    throw new RunBindingError(
      "sealDigest",
      `binding covers ${input.binding.sealDigest}, which is not this run's sealed Run ${sealDigest}`,
    );
  }
  if (input.sealedAt !== undefined && input.binding.sealedAt !== input.sealedAt) {
    throw new RunBindingError(
      "sealedAt",
      `binding names a seal at ${input.binding.sealedAt}, but this run was sealed at ${input.sealedAt}`,
    );
  }
  // The declared source is the third field the binding restates from the sealed record (#3426), and
  // it is checked for the same reason the two above are: `verifyRunBinding` can only tell that the
  // restatement agrees with the binding's OWN beacon, never that it agrees with the Run. Omission is
  // the case that makes this load-bearing rather than tidy -- a binding that simply drops the field
  // verifies clean and reports `operator-chosen`, which would let a run that declared a source bind
  // any other one and print the honest-looking weaker sentence over it.
  if (input.binding.declaredSource !== input.declaredSource) {
    const carried = input.binding.declaredSource === undefined
      ? "binding declares no beacon source"
      : `binding names ${input.binding.declaredSource} as this run's declared beacon source`;
    const sealed = input.declaredSource === undefined
      ? "its sealed Run declares none"
      : `its sealed Run declares ${input.declaredSource}`;
    throw new RunBindingError("declaredSource", `${carried}, but ${sealed}`);
  }
}
