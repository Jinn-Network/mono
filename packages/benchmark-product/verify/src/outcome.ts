import { EVIDENCE_NATIVE_BUNDLE_V5_CHECKS } from "@jinn-network/benchmarking-evidence";
import { legacyClosure } from "./legacy-closures.js";
import { PUBLIC_BUNDLE_V8_CHECKS } from "./reader-instructions.js";
import type { PublicBundleVerificationCheck, PublicBundleVerificationResult } from "./verify.js";

/**
 * The one check a metadata-first `benchmark-product-public-bundle/5` defers (issue #2986): its
 * artifact digests are carried, its artifact bodies are not.
 */
export const NOT_FETCHED_CHECK = "artifact-integrity" as const;

export type VerificationCheckState = "passed" | "not fetched";

/**
 * Every check name either lineage's closure can carry: the legacy/disclosed line's union and the
 * evidence-native `/5` list. Composed here because this module is where both lineages already meet
 * to produce one denominator.
 */
export type VerificationCheckName =
  | PublicBundleVerificationCheck
  | (typeof EVIDENCE_NATIVE_BUNDLE_V5_CHECKS)[number];

export interface VerificationCheckOutcome {
  readonly check: VerificationCheckName;
  readonly state: VerificationCheckState;
}

export interface VerificationOutcome {
  readonly outcomes: readonly VerificationCheckOutcome[];
  /** Checks that actually passed. A deferred check is never counted here. */
  readonly passed: number;
  readonly notFetched: number;
  /** The check count the bundle's declared format promises. */
  readonly total: number;
  /** Present exactly when the bundle deferred artifact content. */
  readonly artifactContent?: {
    readonly notFetched: number;
    readonly notFetchedDigests: readonly string[];
  };
}

/**
 * What each check recomputes, in the words the reader's caveat uses. It lives beside the
 * denominator derivation and is keyed by the check union, so a closure that adds a check cannot
 * add to the `of N` total without also naming what that check recomputed -- the caveat's
 * enumeration was previously a second hand-maintained list and had drifted a whole check behind
 * the six-check closure it described (issue #3691).
 */
const CHECK_SUBJECTS: { readonly [C in VerificationCheckName]: string } = {
  "manifest": "the bundle's integrity",
  "evidence-closure": "evidence closure",
  "trust": "signing trust",
  "matrix-rederivation": "calculations",
  "report-verification": "the report",
  "claim-consistency": "claim consistency",
  "integrity-anchors": "anchor well-formedness",
  "disclosure-specification": "the disclosure specification",
  "artifact-integrity": "artifact integrity",
  "signature-validity": "signature validity",
};

/**
 * The caveat's enumeration of what this bundle's verification actually recomputed. Deferred checks
 * are excluded: a metadata-first bundle carries artifact digests without their bytes, so naming
 * artifact integrity here would claim exactly the thing the deferred-check disclosure denies.
 */
export function describeRecomputedChecks(outcome: VerificationOutcome): string {
  const subjects = outcome.outcomes
    .filter(({ state }) => state === "passed")
    .map(({ check }) => CHECK_SUBJECTS[check]);
  if (subjects.length === 0) return "nothing";
  if (subjects.length === 1) return subjects[0]!;
  return `${subjects.slice(0, -1).join(", ")}, and ${subjects.at(-1)!}`;
}

/**
 * The single derivation of what a verification result may be said to have proved. Every reader
 * surface -- the standalone CLI, the product CLI, the local viewer, the web action -- reads this
 * rather than counting `checks` itself, because a surface that counts for itself is a surface that
 * can print a pass over bytes nobody read (issue #2986).
 */
export function summarizeVerificationOutcome(result: PublicBundleVerificationResult): VerificationOutcome {
  const total = result.format === "benchmark-product-public-bundle/5"
    ? EVIDENCE_NATIVE_BUNDLE_V5_CHECKS.length
    : result.format === "benchmark-product-public-bundle/8"
      ? PUBLIC_BUNDLE_V8_CHECKS.length
      : legacyClosure(result.format).checks.length;
  const deferred = result.format === "benchmark-product-public-bundle/5"
    && result.artifactContent.status === "not-fetched"
    ? result.artifactContent
    : undefined;
  const outcomes: readonly VerificationCheckOutcome[] = result.checks.map((check) => ({
    check,
    state: (deferred !== undefined && check === NOT_FETCHED_CHECK ? "not fetched" : "passed") as VerificationCheckState,
  }));
  const notFetched = outcomes.filter((outcome) => outcome.state === "not fetched").length;
  return {
    outcomes,
    passed: outcomes.length - notFetched,
    notFetched,
    total,
    ...(deferred === undefined ? {} : {
      artifactContent: {
        notFetched: deferred.notFetched,
        notFetchedDigests: deferred.notFetchedDigests,
      },
    }),
  };
}
