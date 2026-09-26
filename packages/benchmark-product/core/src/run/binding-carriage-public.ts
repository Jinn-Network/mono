// SPDX-License-Identifier: Apache-2.0

/**
 * The bundle-visible projection of this run's beacon binding (issue #3370).
 *
 * The counterpart of `imported-run.ts`'s `loadPublicExternalImport`, and it differs in one way that
 * matters: the member carries the sealed record's EXACT bytes, straight out of the sealed store,
 * rather than a canonical re-encoding of a projection. That is what makes the manifest's
 * `files[].sha256`, the claim's `recordSha256`, and the store's own digest one value, so nothing
 * about the record can change in transit and still be published.
 *
 * `readRunBindingCarriage` is where the workspace-side linkage check runs, so a record this function
 * returns has already been compared against this run's own sealed Run by `assertRunBindingLinkage`
 * -- the same function a reader applies to the published member.
 */

import { deriveClaimRunBinding, type ClaimBindingSection, type VerifiedRunBinding } from "@colophon-claims/check";
import { readRunBindingCarriage } from "../binding/carriage.js";
import type { RunState } from "./state.js";
import { getSealedBytes } from "../workspace/sealed-store.js";

export interface PublicRunBindingCarriage {
  /** The verified binding, as the report face and `venueHonesty` need it. */
  readonly binding: VerifiedRunBinding;
  /** The sealed record's exact bytes — the bundle member, verbatim. */
  readonly bytes: Uint8Array;
  /** The claim section, projected from those same bytes. */
  readonly claim: ClaimBindingSection;
}

/** `undefined` for a run that has never bound. */
export function loadPublicRunBinding(
  workspaceDir: string,
  runState: Pick<RunState, "binding" | "runSha256" | "lockedAt">,
): PublicRunBindingCarriage | undefined {
  const binding = readRunBindingCarriage(workspaceDir, runState);
  if (binding === undefined) return undefined;
  const bytes = getSealedBytes(workspaceDir, runState.binding!.recordSha256);
  return { binding, bytes, claim: deriveClaimRunBinding(bytes) };
}
