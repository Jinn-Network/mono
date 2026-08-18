/**
 * Workspace-side anchor carriage (anchor-evidence design §7.4): the one place that turns
 * `RunState.anchors` into the exact AnchorEvidence byte strings a claim and a bundle carry.
 *
 * Three rules, each of them the reason this is a module rather than three inline loops:
 *
 * - **Bytes come out of the sealed store, never out of RunState.** RunState names record digests;
 *   `getSealedBytes` re-verifies each digest on read, so a record that was edited in place surfaces
 *   as its own `record-integrity` refusal naming the store path, before anything projects it.
 * - **The projection is the shared one.** `deriveClaimAnchors` lives in `@colophon-claims/verify`
 *   and is the same function the portable verifier rebuilds the section with. Producing the section
 *   through a second local implementation would make the claim-consistency byte-compare a
 *   comparison of two guesses rather than of one function's output over two byte sets.
 * - **A projection failure is a typed product refusal.** A dangling anchor, a kind that
 *   misdescribes the record its digest resolves to, or a proof the rules reject is
 *   `record-integrity` here — the producer's half of §8's "reported louder than absence".
 */

import { parseRun, readRunAnchorIntentExtension } from "@jinn-network/benchmarking-records";
import { deriveClaimAnchors, ClaimAnchorProjectionError } from "@colophon-claims/verify";
import type { ClaimAnchor, CarriedAnchorRecord } from "@colophon-claims/verify";
import { refuse } from "../errors.js";
import type { RunState } from "../run/state.js";
import { getSealedBytes } from "../workspace/sealed-store.js";

export interface RunAnchorCarriage {
  /** The exact sealed bytes, keyed by record digest — what `anchors/<sha256>.bin` carries. */
  readonly records: readonly CarriedAnchorRecord[];
  /** The claim package's `anchors` section, in record-digest order. */
  readonly anchors: readonly ClaimAnchor[];
  /**
   * Whether this run publishes on the anchored closure. True when it carries an anchor, and also
   * when it carries none but its sealed Run **declared** anchoring intent (§7.3): a declaration
   * whose anchor is missing has to be reported as `declared-but-absent`, and only the anchored
   * closure runs the check that reports it. A stripped anchor must not be able to drop the bundle
   * back to a closure version with nothing to say about it.
   */
  readonly anchoredClosure: boolean;
  /** The provider profiles the sealed Run declares intent for, sorted and unique (§7.3). */
  readonly declaredProfiles: readonly string[];
}

const EMPTY: RunAnchorCarriage = {
  records: [],
  anchors: [],
  anchoredClosure: false,
  declaredProfiles: [],
};

/**
 * Reads every anchor this run recorded, projects it, and reports whether the run is on the anchored
 * closure at all. Returns the empty carriage for a run that has never anchored and declared no
 * intent, which is what keeps every unanchored claim and bundle byte-identical.
 */
export function readRunAnchorCarriage(
  workspaceDir: string,
  runState: Pick<RunState, "anchors" | "runSha256" | "matrixSha256">,
): RunAnchorCarriage {
  const recorded = runState.anchors ?? [];
  if (runState.runSha256 === undefined || runState.matrixSha256 === undefined) {
    if (recorded.length === 0) return EMPTY;
    refuse(
      "conflict",
      "runs.anchors",
      "this run carries anchors but has no sealed Run and Matrix identity to resolve their subjects against",
    );
  }
  const declaredProfiles = readRunAnchorIntentExtension(
    parseRun(getSealedBytes(workspaceDir, runState.runSha256)) as unknown as Record<string, unknown>,
  )?.providers ?? [];
  if (recorded.length === 0 && declaredProfiles.length === 0) return EMPTY;

  const records = recorded.map((anchor) => ({
    recordSha256: anchor.recordSha256,
    bytes: getSealedBytes(workspaceDir, anchor.recordSha256),
  }));
  try {
    return {
      records,
      anchors: deriveClaimAnchors({
        records,
        runSha256: runState.runSha256,
        matrixSha256: runState.matrixSha256,
      }),
      anchoredClosure: true,
      declaredProfiles,
    };
  } catch (cause) {
    if (cause instanceof ClaimAnchorProjectionError) {
      refuse("record-integrity", `anchors/${cause.recordSha256}.bin`, cause.message);
    }
    throw cause;
  }
}
