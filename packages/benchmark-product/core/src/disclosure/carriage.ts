/**
 * Workspace-side disclosure carriage (disclosure-specification-record design §6.6, §10.3; issue
 * #2839): the one place that turns `RunState.disclosureSha256` into the exact record bytes a claim
 * and a bundle carry.
 *
 * Mirrors `anchor/carriage.ts` deliberately, rule for rule:
 *
 * - **Bytes come out of the sealed store, never out of RunState.** RunState names one digest;
 *   `getSealedBytes` re-verifies it on read, so a record edited in place surfaces as its own
 *   `record-integrity` refusal naming the store path, before anything projects it.
 * - **The projection is the shared one.** `deriveDisclosureSpecification` lives in
 *   `@colophon-claims/verify` and is the same function the portable verifier rebuilds the section
 *   with. Producing the section through a second local implementation would make the
 *   claim-consistency byte-compare a comparison of two guesses rather than of one function's output
 *   over two byte sets.
 * - **A projection failure is a typed product refusal.** A record that no longer parses, or whose
 *   digest no longer matches its bytes, is `record-integrity` here.
 */

import { deriveDisclosureSpecification, DisclosureProjectionError } from "@colophon-claims/verify";
import type { ClaimDisclosureSection } from "@colophon-claims/verify";
import { refuse } from "../errors.js";
import type { RunState } from "../run/state.js";
import { getSealedBytes } from "../workspace/sealed-store.js";

export interface RunDisclosureCarriage {
  /** The exact sealed bytes — what `records/<sha256>.bin` carries. */
  readonly bytes: Uint8Array;
  readonly recordSha256: string;
  /** The claim package's `disclosure` section. */
  readonly disclosure: ClaimDisclosureSection;
}

/**
 * Reads this run's sealed disclosure declaration, if it has one, and projects it.
 *
 * Returns `undefined` for a run that never declared — which is what keeps every existing claim and
 * bundle byte-identical, and what makes the whole feature strictly opt-in at produce time.
 */
export function readRunDisclosureCarriage(
  workspaceDir: string,
  runState: Pick<RunState, "disclosureSha256">,
): RunDisclosureCarriage | undefined {
  const recordSha256 = runState.disclosureSha256;
  if (recordSha256 === undefined) return undefined;
  const bytes = getSealedBytes(workspaceDir, recordSha256);
  try {
    return { bytes, recordSha256, disclosure: deriveDisclosureSpecification(bytes) };
  } catch (cause) {
    if (cause instanceof DisclosureProjectionError) {
      refuse("record-integrity", `records/${recordSha256}.bin`, cause.message);
    }
    throw cause;
  }
}
