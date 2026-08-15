// SPDX-License-Identifier: MIT

import type { BackendCapabilities } from "@jinn-network/task-execution-backend";
import {
  CLAIM_NOTHING,
  type ClaimPredicate,
  type OperatorCaps,
  type SubmissionFacts,
} from "./types.js";

export { CLAIM_NOTHING };
export type { ClaimPredicate, SubmissionFacts };

/**
 * Evaluates the operator's pluggable predicate. A null predicate claims nothing (§7).
 */
export function evaluateClaimPredicate(
  predicate: ClaimPredicate,
  facts: SubmissionFacts,
  capabilities: BackendCapabilities,
  caps: OperatorCaps,
): boolean {
  if (predicate === null) return false;
  return predicate(facts, capabilities, caps);
}

/** A convenience predicate that claims every runnable facts card. */
export function takeEveryRunnable(): ClaimPredicate {
  return (facts) => facts.runnable;
}

/** Declines work when the facts card's legacy manifest digest does not match the wiring entry. */
export function matchLegacyManifestDigest(
  wiringByWorkKind: ReadonlyMap<string, { readonly legacyManifestDigest?: string }>,
): ClaimPredicate {
  return (facts) => {
    const entry = wiringByWorkKind.get(facts.workKind);
    if (entry?.legacyManifestDigest === undefined) return true;
    return facts.legacyManifestDigest === entry.legacyManifestDigest;
  };
}
