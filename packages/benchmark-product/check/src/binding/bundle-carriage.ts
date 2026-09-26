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

import { createHash } from "node:crypto";
import { z } from "zod";
import {
  BeaconReferenceSchema,
  BeaconSourceIdSchema,
  RunBindingError,
  verifyRunBinding,
  type VerifiedRunBinding,
} from "./beacon-binding.js";
import { refuse } from "../profile/errors.js";

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

/**
 * The claim's `binding` section: the record's own digest plus the facts embedded in its bytes.
 *
 * The recomputed products — `poolDigest`, `poolSize`, `order`, and a sampled binding's `sample` —
 * are deliberately absent. The member is authenticated by `bundle.json`, so a reader already holds
 * the bytes those derive from and `verifyRunBinding` recomputes them from those bytes on every read;
 * restating them here would duplicate what the reader has and would grow the claim with the run's
 * item count. What the section is for is the reader of `claim-package.json` ALONE: which beacon,
 * which seal, and on what basis each of the three claims the face makes rests.
 *
 * It is a convenience surface rather than the primary one. `assertClaimConsistency`'s whole-claim
 * byte-compare against the rebuilt claim is what actually proves the section is this record's
 * projection, which is why there is no second bespoke comparison for it anywhere.
 */
export const ClaimBindingSectionSchema = z.strictObject({
  recordSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  sealDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  sealedAt: z.string().min(1),
  mode: z.enum(["census", "sampled"]),
  beacon: BeaconReferenceSchema,
  postSeal: z.enum(["proven-offline", "attributive"]),
  roundBasis: z.enum(["seal-derived", "operator-chosen"]),
  sourceBasis: z.enum(["seal-declared", "operator-chosen"]),
  /** The source the sealed Run named, present exactly when the record restates one. */
  declaredSource: BeaconSourceIdSchema.optional(),
});

export type ClaimBindingSection = z.infer<typeof ClaimBindingSectionSchema>;

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Verifies one carried binding member's EXACT bytes.
 *
 * Exact is the whole point, and it is where this differs from `parseExternalImportMarker`, which
 * requires the canonical encoding: the member carries the sealed record verbatim out of the
 * producer's sealed store, so the manifest's `files[].sha256`, the claim's `recordSha256`, and that
 * store's own digest are one value. A reader that canonicalized before hashing would hold a second
 * digest free to disagree with the one `bundle.json` pins.
 *
 * Throws `RunBindingError` on a record the procedure refuses, for the caller to translate into its
 * own typed refusal — the same contract `assertRunBindingLinkage` has.
 */
export function verifyRunBindingMember(recordBytes: Uint8Array): VerifiedRunBinding {
  let candidate: unknown;
  try {
    candidate = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(recordBytes));
  } catch {
    refuse("record-integrity", BEACON_BINDING_BUNDLE_MEMBER, `${BEACON_BINDING_BUNDLE_MEMBER} is not valid UTF-8 JSON`);
  }
  return verifyRunBinding(candidate);
}

/**
 * The one shared projection, called by BOTH the workspace producer and the standalone verifier.
 *
 * It takes the record's own bytes and computes `recordSha256` from THOSE bytes, rather than
 * accepting a separately supplied digest: a caller-supplied digest is a second answer free to
 * disagree with the bytes, and admitting one is exactly what would turn the whole-claim byte-compare
 * into a comparison of two derivations.
 */
export function deriveClaimRunBinding(recordBytes: Uint8Array): ClaimBindingSection {
  const binding = verifyRunBindingMember(recordBytes);
  return {
    recordSha256: sha256Hex(recordBytes),
    sealDigest: binding.sealDigest,
    sealedAt: binding.sealedAt,
    mode: binding.mode,
    beacon: { ...binding.beacon },
    postSeal: binding.postSeal,
    roundBasis: binding.roundBasis,
    sourceBasis: binding.sourceBasis,
    ...(binding.declaredSource === undefined ? {} : { declaredSource: binding.declaredSource }),
  };
}
